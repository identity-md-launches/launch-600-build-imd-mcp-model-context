import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnits } from "viem";
import { ApiError, ImdClient } from "../src/api.js";
import { SpendTracker, loadConfig } from "../src/config.js";
import { payOrder } from "../src/pay.js";
import { MOCK_PRICE_WEI, liveFixture, startMock } from "./mock-server.js";
import { TEST_ADDRESS, TEST_KEY, handlersOf, makeCtx, resultJson, resultText } from "./helpers.js";

const INPUT = liveFixture("check-job.open.request.json").input;
const EVIL = "0x000000000000000000000000000000000000dEaD";

async function quote(handlers: ReturnType<typeof handlersOf>): Promise<string> {
  const res = await handlers.imd_quote({ action: "job.open", input: INPUT });
  return resultJson<{ orderId: string }>(res).orderId;
}

describe("safety", () => {
  it("IMD_DRY_RUN unset stops before signing and says so", async () => {
    const mock = await startMock();
    try {
      // IMD_DRY_RUN deliberately absent — the default must be dry run.
      const cfg = loadConfig({ IMD_PRIVATE_KEY: TEST_KEY, IMD_API_BASE: mock.url });
      assert.equal(cfg.dryRun, true);
      const handlers = handlersOf({
        client: new ImdClient(mock.url),
        cfg,
        tracker: new SpendTracker(),
      });
      const orderId = await quote(handlers);
      const res = await handlers.imd_pay({ orderId, confirm: true });
      const body = resultJson<{ dryRun: boolean; paid: boolean; message: string }>(res);
      assert.equal(body.dryRun, true);
      assert.equal(body.paid, false);
      assert.match(body.message, /dry run/i);
      assert.match(body.message, /before signing/i);
      assert.equal(mock.submissions.length, 0, "no signed payment may reach the server");
      assert.ok(mock.challengeCount >= 1, "the challenge was still fetched and verified");
    } finally {
      await mock.close();
    }
  });

  it("refuses without confirm: true", async () => {
    const mock = await startMock();
    try {
      const handlers = handlersOf(makeCtx(mock));
      const orderId = await quote(handlers);
      const res = await handlers.imd_pay({ orderId, confirm: false });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /confirm: true/);
      assert.equal(mock.submissions.length, 0);
    } finally {
      await mock.close();
    }
  });

  it("read-only without IMD_PRIVATE_KEY", async () => {
    const mock = await startMock();
    try {
      const handlers = handlersOf(makeCtx(mock, { privateKey: undefined }));
      const orderId = await quote(handlers);
      const res = await handlers.imd_pay({ orderId, confirm: true });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /read-only|IMD_PRIVATE_KEY/);
      assert.equal(mock.submissions.length, 0);
    } finally {
      await mock.close();
    }
  });

  it("refuses a challenge whose payTo differs from capabilities", async () => {
    const mock = await startMock({ challenge: { payTo: EVIL } });
    try {
      const handlers = handlersOf(makeCtx(mock));
      const orderId = await quote(handlers);
      const res = await handlers.imd_pay({ orderId, confirm: true });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /refused.*payTo/i);
      assert.equal(mock.submissions.length, 0);
    } finally {
      await mock.close();
    }
  });

  it("refuses when capabilities payTo differs from the quote", async () => {
    const mock = await startMock({ capabilitiesPayTo: EVIL });
    try {
      const handlers = handlersOf(makeCtx(mock));
      const orderId = await quote(handlers);
      const res = await handlers.imd_pay({ orderId, confirm: true });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /refused/i);
      assert.equal(mock.submissions.length, 0);
    } finally {
      await mock.close();
    }
  });

  it("refuses a challenge whose asset differs from capabilities", async () => {
    const mock = await startMock({ challenge: { asset: EVIL } });
    try {
      const handlers = handlersOf(makeCtx(mock));
      const orderId = await quote(handlers);
      const res = await handlers.imd_pay({ orderId, confirm: true });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /refused.*(asset|IMD)/i);
      assert.equal(mock.submissions.length, 0);
    } finally {
      await mock.close();
    }
  });

  it("refuses a challenge whose amount exceeds the quote price", async () => {
    const mock = await startMock({ challenge: { amount: String(BigInt(MOCK_PRICE_WEI) * 4n) } });
    try {
      const handlers = handlersOf(makeCtx(mock));
      const orderId = await quote(handlers);
      const res = await handlers.imd_pay({ orderId, confirm: true });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /refused.*(amount|price|differs)/i);
      assert.equal(mock.submissions.length, 0);
    } finally {
      await mock.close();
    }
  });

  it("enforces IMD_MAX_PER_REQUEST before signing", async () => {
    const mock = await startMock();
    try {
      const handlers = handlersOf(makeCtx(mock, { maxPerRequestWei: parseUnits("0.1", 18) }));
      const orderId = await quote(handlers);
      const res = await handlers.imd_pay({ orderId, confirm: true });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /per-request cap/);
      assert.equal(mock.submissions.length, 0);
    } finally {
      await mock.close();
    }
  });

  it("refuses missing, invalid and too-short payment windows before reserving spend", async () => {
    for (const maxTimeoutSeconds of [undefined, 0, -1, 2.5, "300", 5]) {
      const mock = await startMock({ challenge: { maxTimeoutSeconds } });
      try {
        const ctx = makeCtx(mock);
        const orderId = await ctx.client.quote("job.open", INPUT);
        await assert.rejects(
          () => payOrder(ctx.client, ctx.cfg, ctx.tracker, orderId),
          /payment refused: .*(maxTimeoutSeconds|no future Permit2 deadline)/,
        );
        assert.equal(ctx.tracker.spentToday(), 0n);
        assert.equal(mock.submissions.length, 0);
      } finally {
        await mock.close();
      }
    }
  });

  it("includes a submit 4xx error code in the imd_pay message", async () => {
    const mock = await startMock();
    try {
      const ctx = makeCtx(mock);
      const orderId = await ctx.client.quote("job.open", INPUT);
      ctx.client.submitPayment = async () => {
        throw new ApiError(400, `/requests/${orderId}/submit`, { error: "invalid_payment_window" });
      };
      const res = await handlersOf(ctx).imd_pay({ orderId, confirm: true });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /server error code: invalid_payment_window/);
    } finally {
      await mock.close();
    }
  });

  it("enforces IMD_MAX_PER_DAY across orders", async () => {
    const mock = await startMock({ pendingPolls: 0 });
    try {
      // cap == exactly one action's price
      const ctx = makeCtx(mock, { maxPerDayWei: BigInt(MOCK_PRICE_WEI) });
      const handlers = handlersOf(ctx);
      const first = await quote(handlers);
      const pay1 = await handlers.imd_pay({ orderId: first, confirm: true });
      assert.equal(resultJson<{ paid: boolean }>(pay1).paid, true);

      const second = await quote(handlers);
      const pay2 = await handlers.imd_pay({ orderId: second, confirm: true });
      assert.equal(pay2.isError, true);
      assert.match(resultText(pay2), /per-day cap/);
      assert.equal(mock.submissions.length, 1);
    } finally {
      await mock.close();
    }
  });

  it("atomically reserves the daily cap for concurrent payments", async () => {
    const mock = await startMock({ pendingPolls: 0 });
    try {
      const ctx = makeCtx(mock, { maxPerRequestWei: BigInt(MOCK_PRICE_WEI), maxPerDayWei: BigInt(MOCK_PRICE_WEI) });
      const handlers = handlersOf(ctx);
      const [first, second] = await Promise.all([quote(handlers), quote(handlers)]);
      const results = await Promise.all([
        handlers.imd_pay({ orderId: first, confirm: true }),
        handlers.imd_pay({ orderId: second, confirm: true }),
      ]);
      assert.equal(results.filter((r) => !r.isError).length, 1);
      assert.equal(results.filter((r) => r.isError).length, 1);
      assert.match(resultText(results.find((r) => r.isError)!), /per-day cap/);
      assert.equal(mock.submissions.length, 1);
      assert.equal(ctx.tracker.spentToday(), BigInt(MOCK_PRICE_WEI));
    } finally {
      await mock.close();
    }
  });

  it("keeps a pre-sign reservation when the accepted submit response is lost", async () => {
    const mock = await startMock({ pendingPolls: 0, dropFirstPaymentResponse: true });
    try {
      const ctx = makeCtx(mock, { maxPerRequestWei: BigInt(MOCK_PRICE_WEI), maxPerDayWei: BigInt(MOCK_PRICE_WEI) });
      const first = await ctx.client.quote("job.open", INPUT);
      await assert.rejects(() => payOrder(ctx.client, ctx.cfg, ctx.tracker, first, { intervalMs: 1, timeoutMs: 50 }));
      assert.equal(mock.submissions.length, 1, "the mock accepted the authorization before disconnecting");
      assert.equal(ctx.tracker.spentToday(), BigInt(MOCK_PRICE_WEI));

      const second = await ctx.client.quote("job.open", INPUT);
      await assert.rejects(
        () => payOrder(ctx.client, ctx.cfg, ctx.tracker, second, { intervalMs: 1, timeoutMs: 50 }),
        /per-day cap/,
      );
      assert.equal(mock.submissions.length, 1);
    } finally {
      await mock.close();
    }
  });

  it("does not sign a second Permit2 authorization when a pending order is retried", async () => {
    const mock = await startMock({ pendingPolls: 10_000 });
    try {
      const ctx = makeCtx(mock);
      const orderId = await ctx.client.quote("job.open", INPUT);
      await assert.rejects(() => payOrder(ctx.client, ctx.cfg, ctx.tracker, orderId, { intervalMs: 1, timeoutMs: 10 }));
      assert.equal(mock.submissions.length, 1);
      await assert.rejects(() => payOrder(ctx.client, ctx.cfg, ctx.tracker, orderId, { intervalMs: 1, timeoutMs: 10 }));
      assert.equal(mock.submissions.length, 1, "retry must poll, not sign a new nonce");
    } finally {
      await mock.close();
    }
  });

  it("retains a wallet's cap when a new server tracker starts", async () => {
    const mock = await startMock({ pendingPolls: 0 });
    const stateDir = await mkdtemp(join(tmpdir(), "imd-mcp-ledger-"));
    try {
      const cap = BigInt(MOCK_PRICE_WEI);
      const cfg = makeCtx(mock, { maxPerRequestWei: cap, maxPerDayWei: cap }).cfg;
      const firstClient = new ImdClient(mock.url);
      const firstTracker = new SpendTracker({ wallet: TEST_ADDRESS, storageDir: stateDir });
      const first = await firstClient.quote("job.open", INPUT);
      await payOrder(firstClient, cfg, firstTracker, first, { intervalMs: 1, timeoutMs: 100 });

      const secondClient = new ImdClient(mock.url);
      const secondTracker = new SpendTracker({ wallet: TEST_ADDRESS, storageDir: stateDir });
      assert.equal(secondTracker.spentToday(), cap, "new tracker reads the same wallet ledger");
      const second = await secondClient.quote("job.open", INPUT);
      await assert.rejects(
        () => payOrder(secondClient, cfg, secondTracker, second, { intervalMs: 1, timeoutMs: 100 }),
        /per-day cap/,
      );
      assert.equal(mock.submissions.length, 1);
    } finally {
      await mock.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects an out-of-range private key without including it in the error", () => {
    const key = `0x${"ff".repeat(32)}`;
    assert.throws(() => loadConfig({ IMD_PRIVATE_KEY: key }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "IMD_PRIVATE_KEY is invalid");
      assert.equal(err.message.includes(key), false);
      return true;
    });
  });

  it("retries the noisy evaluator up to 3 times", async () => {
    const mock = await startMock({ checkFailures: 2 });
    try {
      const handlers = handlersOf(makeCtx(mock));
      const res = await handlers.imd_check({ action: "job.open", input: INPUT });
      assert.equal(res.isError, undefined, resultText(res));
      assert.equal(mock.checkCalls, 3);
    } finally {
      await mock.close();
    }
  });

  it("gives up on the evaluator after 3 failures", async () => {
    const mock = await startMock({ checkFailures: 10 });
    try {
      const handlers = handlersOf(makeCtx(mock));
      const res = await handlers.imd_check({ action: "job.open", input: INPUT });
      assert.equal(res.isError, true);
      assert.equal(mock.checkCalls, 3);
    } finally {
      await mock.close();
    }
  });

  it("rejects unknown paid actions from the advertised schema", async () => {
    const mock = await startMock();
    try {
      const handlers = handlersOf(makeCtx(mock));
      const res = await handlers.imd_quote({ action: "does.not.exist", input: {} });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /unknown action/);
    } finally {
      await mock.close();
    }
  });

  it("passes input through and surfaces the server's 422 problems", async () => {
    const mock = await startMock();
    try {
      const handlers = handlersOf(makeCtx(mock));
      const res = await handlers.imd_quote({ action: "job.open", input: { prompt: "x" } });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /invalid_input.*objective/);
      assert.match(resultText(res), /imd_check/);
    } finally {
      await mock.close();
    }
  });
});
