import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

/**
 * Local mock of https://api.imd.fun for tests. Never spends real IMD,
 * never touches mainnet — it just speaks the wire protocol.
 *
 * GET /requests/capabilities, GET /openapi.json and POST /requests/check are
 * served from bodies saved from the live API under fixtures/live/.
 */

/** Read a body saved from the live API (fixtures/live/, resolved from the compiled dist/tests/). */
export function liveFixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../fixtures/live/${name}`, import.meta.url), "utf8")) as T;
}

export const LIVE_CAPABILITIES = liveFixture<{
  actions: { action: string; payment: Record<string, unknown> }[];
  pricedPer: Record<string, string>;
}>("capabilities.json");
export const LIVE_OPENAPI = liveFixture<{ "x-imd-actions": { action: string }[] }>("openapi.json");
const LIVE_ACTIONS = LIVE_OPENAPI["x-imd-actions"].map((a) => a.action);
const LIVE_CHECKS: Record<string, unknown> = {
  "job.open": liveFixture("check-job.open.response.json"),
  "schedule.create": liveFixture("check-schedule.create.response.json"),
};
const JOB_OPEN = LIVE_CAPABILITIES.actions.find((a) => a.action === "job.open")!.payment;

export const MOCK_ASSET = JOB_OPEN.asset as string; // IMD
export const MOCK_PAYTO = JOB_OPEN.payTo as string;
export const MOCK_PRICE_WEI = JOB_OPEN.amount as string; // 0.5 IMD

export interface ChallengeOverrides {
  asset?: string;
  payTo?: string;
  amount?: string;
  scheme?: string;
  network?: string;
  maxTimeoutSeconds?: unknown;
}

export interface MockOptions {
  /** Tamper with the 402 challenge to test refusals. */
  challenge?: ChallengeOverrides;
  /** Tamper with GET /requests/capabilities. */
  capabilitiesPayTo?: string;
  capabilitiesAsset?: string;
  capabilitiesPrice?: string;
  /** Fail POST /requests/check this many times with 503 first. */
  checkFailures?: number;
  /** Number of pending poll responses before an order completes. */
  pendingPolls?: number;
  /** Accept the first signed payment, then drop its response (simulates a lost TCP response). */
  dropFirstPaymentResponse?: boolean;
}

export interface Submission {
  orderId: string;
  payment: Record<string, unknown>;
  quoteSignature: string;
  paymentSignatureHeader: string;
}

interface Order {
  id: string;
  bearer: string;
  action: string;
  input: unknown;
  status: string;
  paid: boolean;
  polls: number;
}

export interface MockServer {
  url: string;
  submissions: Submission[];
  challenges: Map<string, Record<string, unknown>>;
  challengeCount: number;
  checkCalls: number;
  orders: Map<string, Order>;
  close(): Promise<void>;
}

/** Live price: the action's payment.amount, times input.runs when priced per run. */
function liveAmount(action: string, input: unknown): string {
  const unit = BigInt(String(LIVE_CAPABILITIES.actions.find((a) => a.action === action)?.payment.amount ?? MOCK_PRICE_WEI));
  if (LIVE_CAPABILITIES.pricedPer[action] !== "run") return unit.toString(10);
  return (unit * BigInt((input as { runs: number }).runs)).toString(10);
}

/** The checks the live quote applies that the tests exercise (422 problems). */
function inputProblems(action: string, input: unknown): string[] {
  const o = (input ?? {}) as Record<string, unknown>;
  if (action === "job.open" && typeof o.objective !== "string") {
    return ["objective: Invalid input: expected string, received undefined"];
  }
  if (["schedule.create", "schedule.topup"].includes(action)) {
    if (typeof o.runs !== "number" || !Number.isSafeInteger(o.runs) || o.runs < 1) {
      return ["runs: Invalid input: expected a positive integer"];
    }
  }
  return [];
}

export async function startMock(opts: MockOptions = {}): Promise<MockServer> {
  const orders = new Map<string, Order>();
  const challenges = new Map<string, Record<string, unknown>>();
  const submissions: Submission[] = [];
  let challengeCount = 0;
  let checkCalls = 0;
  let checkFailsLeft = opts.checkFailures ?? 0;
  const pendingPolls = opts.pendingPolls ?? 1;
  let orderSeq = 0;
  let dropPaymentResponse = opts.dropFirstPaymentResponse ?? false;

  const send = (res: http.ServerResponse, status: number, body: unknown, type = "application/json") => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": type });
    res.end(text);
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
    });

  const challenge = (orderId: string) => {
    const ov = opts.challenge ?? {};
    const order = orders.get(orderId)!;
    const asset = ov.asset ?? MOCK_ASSET;
    const payTo = ov.payTo ?? MOCK_PAYTO;
    const amount = ov.amount ?? liveAmount(order.action, order.input);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    return {
      x402Version: 2,
      accepts: [
        {
          scheme: ov.scheme ?? "exact",
          network: ov.network ?? "eip155:1",
          asset,
          amount,
          payTo,
          maxTimeoutSeconds: "maxTimeoutSeconds" in ov ? ov.maxTimeoutSeconds : 300,
        },
      ],
      quote: {
        id: `q_${orderId}`,
        quoteHash: randomBytes(32).toString("hex"),
        action: order.action,
        payment: { asset, amount, payTo },
        expiresAt,
      },
      resource: `imd:requests/${orderId}`,
      resourceUrl: `https://api.imd.fun/requests/${orderId}`,
      requesterScopeHash: randomBytes(32).toString("hex"),
      input: order.input,
    };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const authed = bearer.length === 64;

    try {
      if (req.method === "GET" && path === "/openapi.json") {
        return send(res, 200, LIVE_OPENAPI);
      }

      if (req.method === "GET" && path === "/requests/capabilities") {
        const caps = structuredClone(LIVE_CAPABILITIES);
        for (const a of caps.actions) {
          if (opts.capabilitiesAsset) a.payment.asset = opts.capabilitiesAsset;
          if (opts.capabilitiesPayTo) a.payment.payTo = opts.capabilitiesPayTo;
          if (opts.capabilitiesPrice) a.payment.amount = opts.capabilitiesPrice;
        }
        return send(res, 200, caps);
      }

      if (req.method === "POST" && path === "/requests/check") {
        checkCalls++;
        if (checkFailsLeft > 0) {
          checkFailsLeft--;
          return send(res, 503, { error: "evaluator unavailable" });
        }
        const body = JSON.parse(await readBody(req) || "{}");
        return send(res, 200, LIVE_CHECKS[body.action] ?? { action: body.action, blockers: [], suggestions: [] });
      }

      if (req.method === "POST" && path === "/requests/import") {
        const body = JSON.parse(await readBody(req) || "{}");
        return send(res, 200, {
          repoUrl: body.url,
          baseCommit: "a".repeat(40),
        });
      }

      if (!authed) return send(res, 401, { error: "missing bearer" });

      if (req.method === "POST" && path === "/requests/quote") {
        const body = JSON.parse(await readBody(req) || "{}");
        if (typeof body.requestKey !== "string" || !body.requestKey) {
          return send(res, 422, { error: "invalid_input", problems: ["requestKey required"] });
        }
        if (!LIVE_ACTIONS.includes(body.action)) {
          return send(res, 422, {
            error: "invalid_input",
            problems: [`unknown action ${String(body.action)}`],
          });
        }
        const problems = inputProblems(body.action, body.input);
        if (problems.length) return send(res, 422, { error: "invalid_input", problems });
        const id = `ord_${++orderSeq}`;
        orders.set(id, {
          id,
          bearer,
          action: body.action,
          input: body.input,
          status: "quoted",
          paid: false,
          polls: 0,
        });
        return send(res, 201, { created: true, order: { id } });
      }

      const submitMatch = path.match(/^\/requests\/([^/]+)\/submit$/);
      if (req.method === "POST" && submitMatch) {
        const order = orders.get(submitMatch[1]);
        if (!order) return send(res, 404, { error: "no such order" });
        if (order.bearer !== bearer) return send(res, 403, { error: "wrong bearer" });

        const psHeader = req.headers["payment-signature"];
        if (typeof psHeader !== "string") {
          challengeCount++;
          const ch = challenge(order.id);
          challenges.set(order.id, ch);
          return send(res, 402, ch);
        }

        const body = JSON.parse(await readBody(req) || "{}");
        let payment: Record<string, unknown>;
        try {
          payment = JSON.parse(Buffer.from(psHeader, "base64").toString("utf8"));
        } catch {
          return send(res, 402, { error: "invalid_payment_shape", detail: "bad base64" });
        }
        const payload = payment.payload as Record<string, unknown> | undefined;
        const auth = payload?.permit2Authorization as Record<string, unknown> | undefined;
        if (
          payment.x402Version !== 2 ||
          typeof payload?.signature !== "string" ||
          !auth ||
          typeof body.quoteSignature !== "string"
        ) {
          return send(res, 402, { error: "invalid_payment_shape" });
        }
        const accepted = (challenges.get(order.id)?.accepts as Record<string, unknown>[] | undefined)?.[0];
        if (typeof auth.deadline !== "string" || !/^\d+$/.test(auth.deadline)) {
          return send(res, 402, { error: "invalid_payment_shape" });
        }
        const maxTimeoutSeconds = accepted?.maxTimeoutSeconds;
        if (typeof maxTimeoutSeconds !== "number" || !Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
          return send(res, 400, { error: "invalid_payment_window" });
        }
        if (BigInt(auth.deadline) > BigInt(Math.floor(Date.now() / 1000) + maxTimeoutSeconds)) {
          return send(res, 400, { error: "invalid_payment_window" });
        }
        order.paid = true;
        order.status = "admission_pending";
        submissions.push({
          orderId: order.id,
          payment,
          quoteSignature: body.quoteSignature,
          paymentSignatureHeader: psHeader,
        });
        if (dropPaymentResponse) {
          dropPaymentResponse = false;
          // The server accepted the authorization, but the client cannot know
          // whether it did when the connection disappears before a response.
          req.socket.destroy();
          return;
        }
        return send(res, 202, { id: order.id, status: order.status });
      }

      const reqMatch = path.match(/^\/requests\/([^/]+)$/);
      if (req.method === "GET" && reqMatch) {
        const order = orders.get(reqMatch[1]);
        if (!order) return send(res, 404, { error: "no such order" });
        if (order.bearer !== bearer) return send(res, 403, { error: "wrong bearer" });
        if (order.paid) {
          order.polls++;
          if (order.polls > pendingPolls) order.status = "completed";
        }
        return send(res, 200, {
          id: order.id,
          status: order.status,
          action: order.action,
          paid: order.paid,
        });
      }

      const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
      if (req.method === "GET" && jobMatch) {
        return send(res, 200, {
          id: jobMatch[1],
          status: "succeeded",
          orderId: "ord_1",
        });
      }
      const reportMatch = path.match(/^\/jobs\/([^/]+)\/report\.md$/);
      if (req.method === "GET" && reportMatch) {
        return send(res, 200, `# Report for ${reportMatch[1]}\n\nAll good.\n`, "text/markdown");
      }

      if (req.method === "GET" && path === "/schedules") {
        const owner = url.searchParams.get("owner") ?? "";
        return send(res, 200, {
          schedules: [
            { id: "sched_1", owner, action: "job.open", cron: "0 9 * * 1" },
          ],
        });
      }

      return send(res, 404, { error: `no mock route ${req.method} ${path}` });
    } catch (e) {
      return send(res, 500, { error: String(e) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    submissions,
    challenges,
    orders,
    get challengeCount() {
      return challengeCount;
    },
    get checkCalls() {
      return checkCalls;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
