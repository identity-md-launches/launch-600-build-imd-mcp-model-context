import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { ImdClient } from "../src/api.js";
import { SpendTracker, loadConfig } from "../src/config.js";
import { MOCK_PRICE_WEI, startMock } from "./mock-server.js";
import { TEST_KEY, handlersOf, makeCtx, resultJson, resultText } from "./helpers.js";

const INPUT = { repoUrl: "https://github.com/example/repo", prompt: "fix the tests" };
const EVIL = "0x000000000000000000000000000000000000dEaD";

async function quote(handlers: ReturnType<typeof handlersOf>): Promise<string> {
  const res = await handlers.imd_quote({ action: "swarm.launch", input: INPUT });
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

  it("retries the noisy evaluator up to 3 times", async () => {
    const mock = await startMock({ checkFailures: 2 });
    try {
      const handlers = handlersOf(makeCtx(mock));
      const res = await handlers.imd_check({ action: "swarm.launch", input: INPUT });
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
      const res = await handlers.imd_check({ action: "swarm.launch", input: INPUT });
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

  it("validates action input against the advertised schema", async () => {
    const mock = await startMock();
    try {
      const handlers = handlersOf(makeCtx(mock));
      const res = await handlers.imd_quote({ action: "swarm.launch", input: { prompt: "x" } });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /schema/);
    } finally {
      await mock.close();
    }
  });
});
