import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { Challenge, normaliseActions, parseCapabilities } from "../src/api.js";
import { IMD_ASSET } from "../src/config.js";
import { PaymentRefusal, payOrder, verifyChallenge } from "../src/pay.js";
import { LIVE_CAPABILITIES, LIVE_OPENAPI, liveFixture, startMock } from "./mock-server.js";
import { handlersOf, makeCtx, resultJson, resultText } from "./helpers.js";

/**
 * Bodies saved from the live API (fixtures/live/): GET /requests/capabilities,
 * GET /openapi.json and two free POST /requests/check calls.
 */
const JOB_OPEN = liveFixture("check-job.open.request.json");
const SCHEDULE = liveFixture("check-schedule.create.request.json");
const SCHEDULE_CHECK = liveFixture("check-schedule.create.response.json");
const LIVE_ACTIONS = [
  "job.open",
  "job.continue",
  "launch.open",
  "oracle.request",
  "workflow.open",
  "schedule.create",
  "schedule.topup",
];

/** A 402 challenge shaped like the live one, with its terms taken from live capabilities. */
function challengeFor(action: string, amount: string, input: unknown): Challenge {
  const p = LIVE_CAPABILITIES.actions.find((a) => a.action === action)!.payment as Record<string, string>;
  return {
    accepts: [{ scheme: "exact", network: p.network, asset: p.asset, amount, payTo: p.payTo, maxTimeoutSeconds: 300 }],
    quote: {
      id: "q_1",
      quoteHash: "ab".repeat(32),
      action,
      payment: { asset: p.asset, amount, payTo: p.payTo },
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    },
    resource: {},
    resourceUrl: "https://api.imd.fun/requests/1",
    requesterScopeHash: "cd".repeat(32),
    input,
    raw: {},
  };
}

describe("live API shapes", () => {
  it("capabilities() parses the live body with per-action asset, payTo and amount", () => {
    const caps = parseCapabilities(LIVE_CAPABILITIES);
    assert.deepEqual(Object.keys(caps.actions).sort(), [...LIVE_ACTIONS].sort());
    const job = caps.actions["job.open"];
    assert.equal(job.asset, IMD_ASSET);
    assert.match(job.payTo!, /^0x[0-9a-f]{40}$/);
    assert.equal(job.amount, "500000000000000000");
    assert.equal(caps.pricedPer["schedule.create"], "run");
    assert.equal(caps.pricedPer["job.open"], undefined);
  });

  it("normaliseActions keys the live x-imd-actions array on .action", () => {
    const actions = normaliseActions(LIVE_OPENAPI["x-imd-actions"]);
    assert.deepEqual(Object.keys(actions), LIVE_ACTIONS);
    assert.equal(actions["job.open"].name, "job.open");
    assert.equal(actions["job.open"].inputSchema, undefined, "the live payload has no input schemas");
  });

  it("pay-terms check accepts job.open at payment.amount", () => {
    const caps = parseCapabilities(LIVE_CAPABILITIES);
    const v = verifyChallenge(challengeFor("job.open", "500000000000000000", JOB_OPEN.input), caps);
    assert.equal(v.amountWei, parseUnits("0.5", 18));
  });

  it("pay-terms check accepts a 3-run schedule.create at 3 x 0.5 IMD and refuses 2 x", () => {
    const caps = parseCapabilities(LIVE_CAPABILITIES);
    assert.equal(SCHEDULE.input.runs, 3);
    // The live evaluator priced the same input at 1.5 IMD.
    assert.equal(SCHEDULE_CHECK.amount, parseUnits("1.5", 18).toString());
    const v = verifyChallenge(challengeFor("schedule.create", SCHEDULE_CHECK.amount, SCHEDULE.input), caps);
    assert.equal(v.amountWei, parseUnits("1.5", 18));
    assert.throws(
      () => verifyChallenge(challengeFor("schedule.create", parseUnits("1", 18).toString(), SCHEDULE.input), caps),
      (e: unknown) => e instanceof PaymentRefusal && /differs from capabilities price/.test(e.message),
    );
    assert.throws(
      () => verifyChallenge(challengeFor("schedule.create", SCHEDULE_CHECK.amount, { ...SCHEDULE.input, runs: undefined }), caps),
      /runs/,
    );
  });

  it("imd_quote accepts a real job.open and a 3-run schedule.create; caps apply to the total", async () => {
    const mock = await startMock();
    try {
      const handlers = handlersOf(makeCtx(mock, { dryRun: true }));
      const job = await handlers.imd_quote({ action: "job.open", input: JOB_OPEN.input });
      assert.equal(job.isError, undefined, resultText(job));

      const sched = await handlers.imd_quote({ action: "schedule.create", input: SCHEDULE.input });
      assert.equal(sched.isError, undefined, resultText(sched));
      const quoted = resultJson<{ orderId: string; quote: { payment: { amount: string } } }>(sched);
      assert.equal(quoted.quote.payment.amount, SCHEDULE_CHECK.amount);

      // Default per-request cap (1 IMD) refuses the 1.5 IMD total...
      const capped = await handlers.imd_pay({ orderId: quoted.orderId, confirm: true });
      assert.equal(capped.isError, true);
      assert.match(resultText(capped), /per-request cap/);

      // ...and a 2 IMD cap lets the dry run verify it.
      const ctx = makeCtx(mock, { dryRun: true, maxPerRequestWei: parseUnits("2", 18) });
      const orderId = await ctx.client.quote("schedule.create", SCHEDULE.input);
      const res = await payOrder(ctx.client, ctx.cfg, ctx.tracker, orderId);
      assert.equal(res.dryRun, true);
      assert.equal(res.amountImd, "1.5");
      assert.equal(mock.submissions.length, 0);
    } finally {
      await mock.close();
    }
  });
});
