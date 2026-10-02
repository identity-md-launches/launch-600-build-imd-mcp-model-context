import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * Local mock of https://api.imd.fun for tests. Never spends real IMD,
 * never touches mainnet — it just speaks the wire protocol.
 */

export const MOCK_ASSET = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7"; // IMD
export const MOCK_PAYTO = "0x9cA70B93CaE5576645F5F069524A9B9c3aef5006";
export const MOCK_PRICE_WEI = "500000000000000000"; // 0.5 IMD

export interface ChallengeOverrides {
  asset?: string;
  payTo?: string;
  amount?: string;
  scheme?: string;
  network?: string;
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

const ACTIONS = {
  "swarm.launch": {
    description: "Hire the swarm on a repository task",
    inputSchema: {
      type: "object",
      properties: {
        repoUrl: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["repoUrl", "prompt"],
      additionalProperties: false,
    },
  },
  "schedule.create": {
    description: "Create a recurring swarm run",
    inputSchema: {
      type: "object",
      properties: {
        repoUrl: { type: "string" },
        prompt: { type: "string" },
        cron: { type: "string" },
      },
      required: ["repoUrl", "prompt", "cron"],
      additionalProperties: false,
    },
  },
};

export async function startMock(opts: MockOptions = {}): Promise<MockServer> {
  const orders = new Map<string, Order>();
  const challenges = new Map<string, Record<string, unknown>>();
  const submissions: Submission[] = [];
  let challengeCount = 0;
  let checkCalls = 0;
  let checkFailsLeft = opts.checkFailures ?? 0;
  const pendingPolls = opts.pendingPolls ?? 1;
  let orderSeq = 0;

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
    const asset = ov.asset ?? MOCK_ASSET;
    const payTo = ov.payTo ?? MOCK_PAYTO;
    const amount = ov.amount ?? MOCK_PRICE_WEI;
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    return {
      accepts: [
        {
          scheme: ov.scheme ?? "exact",
          network: ov.network ?? "eip155:1",
          asset,
          amount,
          payTo,
          maxTimeoutSeconds: 300,
        },
      ],
      quote: {
        id: `q_${orderId}`,
        quoteHash: randomBytes(32).toString("hex"),
        action: orders.get(orderId)?.action ?? "swarm.launch",
        payment: { asset, amount, payTo },
        expiresAt,
      },
      resource: `imd:requests/${orderId}`,
      resourceUrl: `https://api.imd.fun/requests/${orderId}`,
      requesterScopeHash: randomBytes(32).toString("hex"),
    };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const authed = bearer.length === 64;

    try {
      if (req.method === "GET" && path === "/openapi.json") {
        return send(res, 200, {
          openapi: "3.1.0",
          info: { title: "IMD API (mock)", version: "0.0.0" },
          paths: {},
          "x-imd-actions": ACTIONS,
        });
      }

      if (req.method === "GET" && path === "/requests/capabilities") {
        return send(res, 200, {
          asset: opts.capabilitiesAsset ?? MOCK_ASSET,
          payTo: opts.capabilitiesPayTo ?? MOCK_PAYTO,
          price: opts.capabilitiesPrice ?? MOCK_PRICE_WEI,
          quoteLifetimeSeconds: 300,
          launchChains: ["ethereum", "base"],
        });
      }

      if (req.method === "POST" && path === "/requests/check") {
        checkCalls++;
        if (checkFailsLeft > 0) {
          checkFailsLeft--;
          return send(res, 503, { error: "evaluator unavailable" });
        }
        return send(res, 200, { verdict: "pass", problems: [] });
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
        if (!(body.action in ACTIONS)) {
          return send(res, 422, {
            error: "invalid_input",
            problems: [`unknown action ${String(body.action)}`],
          });
        }
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
        return send(res, 201, { order: { id } });
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
        order.paid = true;
        order.status = "admission_pending";
        submissions.push({
          orderId: order.id,
          payment,
          quoteSignature: body.quoteSignature,
          paymentSignatureHeader: psHeader,
        });
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
            { id: "sched_1", owner, action: "swarm.launch", cron: "0 9 * * 1" },
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
