import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, verifyTypedData } from "viem";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { X402_SPENDER } from "../src/config.js";
import { payOrder } from "../src/pay.js";
import { paymentHashOf, sortedJsonStringify, toEpochSeconds } from "../src/util.js";
import { registerTools } from "../src/tools.js";
import {
  MOCK_ASSET,
  MOCK_PAYTO,
  MOCK_PRICE_WEI,
  MockServer,
  liveFixture,
  startMock,
} from "./mock-server.js";
import {
  TEST_ADDRESS,
  handlersOf,
  makeCtx,
  resultJson,
  resultText,
} from "./helpers.js";

const QUOTE_INPUT = liveFixture("check-job.open.request.json").input;

let mock: MockServer;
before(async () => {
  mock = await startMock();
});
after(async () => {
  await mock.close();
});

describe("full paid-request path", () => {
  it("quote -> 402 challenge -> sign -> submit -> poll completes", async () => {
    const ctx = makeCtx(mock);
    const handlers = handlersOf(ctx);

    const quoteRes = await handlers.imd_quote({ action: "job.open", input: QUOTE_INPUT });
    assert.equal(quoteRes.isError, undefined, resultText(quoteRes));
    const quote = resultJson<{ orderId: string; quote: { payment: { amount: string; payTo: string; asset: string } } }>(quoteRes);
    assert.ok(quote.orderId.startsWith("ord_"));
    assert.equal(quote.quote.payment.amount, MOCK_PRICE_WEI);
    assert.equal(quote.quote.payment.payTo.toLowerCase(), MOCK_PAYTO.toLowerCase());
    assert.equal(quote.quote.payment.asset.toLowerCase(), MOCK_ASSET.toLowerCase());

    // pay directly so we can poll fast
    const result = await payOrder(ctx.client, ctx.cfg, ctx.tracker, quote.orderId, {
      intervalMs: 10,
      timeoutMs: 10_000,
    });
    assert.equal(result.dryRun, false);
    assert.equal(result.paid, true);
    assert.equal(result.amountImd, "0.5");
    assert.equal(result.final?.status, "completed");
    assert.equal(result.submitStatus, 202);

    // exactly one signed submission reached the server
    assert.equal(mock.submissions.length, 1);
    const sub = mock.submissions[0];
    const challenge = mock.challenges.get(quote.orderId)!;
    const quoteData = challenge.quote as {
      id: string;
      quoteHash: string;
      action: string;
      expiresAt: string;
    };

    // payment object shape: no extra fields, numbers as decimal strings
    assert.deepEqual(Object.keys(sub.payment).sort(), ["accepted", "payload", "resource", "x402Version"]);
    assert.equal(sub.payment.x402Version, 2);
    assert.equal(sub.payment.resource, challenge.resource);
    const accept = (challenge.accepts as Record<string, unknown>[])[0];
    assert.deepEqual(sub.payment.accepted, accept);

    const payload = sub.payment.payload as Record<string, unknown>;
    assert.match(payload.signature as string, /^0x[0-9a-fA-F]{130}$/);
    const auth = payload.permit2Authorization as Record<string, any>;
    assert.equal(auth.from, TEST_ADDRESS);
    assert.equal(auth.permitted.token.toLowerCase(), MOCK_ASSET.toLowerCase());
    assert.equal(auth.permitted.amount, MOCK_PRICE_WEI);
    assert.equal(auth.spender, X402_SPENDER);
    assert.match(auth.nonce, /^\d+$/);
    const expiresAtSec = toEpochSeconds(quoteData.expiresAt, "expiresAt");
    assert.equal(BigInt(auth.deadline), expiresAtSec - 5n);
    assert.equal(auth.witness.to.toLowerCase(), MOCK_PAYTO.toLowerCase());
    assert.equal(auth.witness.validAfter, "0");

    // permit signature recovers to the test key
    const permitOk = await verifyTypedData({
      address: TEST_ADDRESS,
      domain: {
        name: "Permit2",
        chainId: 1,
        verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      },
      types: {
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "Witness" },
        ],
        Witness: [
          { name: "to", type: "address" },
          { name: "validAfter", type: "uint256" },
        ],
      },
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: getAddress(auth.permitted.token), amount: BigInt(auth.permitted.amount) },
        spender: getAddress(auth.spender),
        nonce: BigInt(auth.nonce),
        deadline: BigInt(auth.deadline),
        witness: { to: getAddress(auth.witness.to), validAfter: BigInt(auth.witness.validAfter) },
      },
      signature: payload.signature as `0x${string}`,
    });
    assert.ok(permitOk, "permit2 signature must recover to the payer key");

    // QuoteApproval signature recovers too, using sha256 of key-sorted JSON
    const paymentHash = paymentHashOf(sub.payment);
    const scopeHash = `0x${challenge.requesterScopeHash}` as `0x${string}`;
    const quoteSigOk = await verifyTypedData({
      address: TEST_ADDRESS,
      domain: { name: "IdentityMD Paid Action", version: "1", chainId: 1 },
      types: {
        QuoteApproval: [
          { name: "resource", type: "string" },
          { name: "requesterScopeHash", type: "bytes32" },
          { name: "quoteId", type: "string" },
          { name: "quoteHash", type: "bytes32" },
          { name: "paymentHash", type: "bytes32" },
          { name: "action", type: "string" },
          { name: "asset", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "payTo", type: "address" },
          { name: "expiresAt", type: "uint256" },
        ],
      },
      primaryType: "QuoteApproval",
      message: {
        resource: challenge.resourceUrl as string,
        requesterScopeHash: scopeHash,
        quoteId: quoteData.id,
        quoteHash: `0x${quoteData.quoteHash}` as `0x${string}`,
        paymentHash,
        action: quoteData.action,
        asset: getAddress(MOCK_ASSET),
        amount: BigInt(MOCK_PRICE_WEI),
        payTo: getAddress(MOCK_PAYTO),
        expiresAt: expiresAtSec,
      },
      signature: sub.quoteSignature as `0x${string}`,
    });
    assert.ok(quoteSigOk, "QuoteApproval signature must recover to the payer key");
  });

  it("records spend against the per-day tracker", async () => {
    const ctx = makeCtx(mock);
    const orderId = await ctx.client.quote("job.open", QUOTE_INPUT);
    await payOrder(ctx.client, ctx.cfg, ctx.tracker, orderId, { intervalMs: 5 });
    assert.equal(ctx.tracker.spentToday(), BigInt(MOCK_PRICE_WEI));
  });

  it("works end-to-end through a real MCP transport", async () => {
    const ctx = makeCtx(mock, { dryRun: true });
    const server = new McpServer({ name: "imd-mcp", version: "test" });
    registerTools(server, handlersOf(ctx));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "imd_capabilities",
      "imd_check",
      "imd_import_repo",
      "imd_job",
      "imd_order_status",
      "imd_pay",
      "imd_quote",
      "imd_schedules",
    ]);

    const caps = await client.callTool({ name: "imd_capabilities", arguments: {} });
    const capsJson = JSON.parse((caps.content as any)[0].text);
    assert.equal(capsJson.dryRun, true);
    assert.ok(capsJson.actions["job.open"]);

    const quote = await client.callTool({
      name: "imd_quote",
      arguments: { action: "job.open", input: QUOTE_INPUT },
    });
    const orderId = JSON.parse((quote.content as any)[0].text).orderId;
    assert.ok(orderId);

    await Promise.all([client.close(), server.close()]);
  });

  it("paymentHash is sha256 of key-sorted JSON", () => {
    const payment = { b: 1, a: { d: 2, c: 3 } };
    assert.equal(sortedJsonStringify(payment), '{"a":{"c":3,"d":2},"b":1}');
    assert.match(paymentHashOf(payment), /^0x[0-9a-f]{64}$/);
  });
});
