import { randomUUID } from "node:crypto";
import { randomBearer } from "./util.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    const detail =
      typeof body === "object" && body !== null && "problems" in body
        ? ` problems=${JSON.stringify((body as { problems: unknown }).problems)}`
        : ` body=${typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body)?.slice(0, 400)}`;
    super(`IMD API ${status} on ${path}:${detail}`);
    this.name = "ApiError";
  }
}

/** One paid action advertised in GET /openapi.json under x-imd-actions. */
export interface ActionSpec {
  name: string;
  description?: string;
  /** JSON schema for the action's input object, if advertised (the live API advertises none). */
  inputSchema?: Record<string, unknown>;
  raw: unknown;
}

/** One action's payment terms from GET /requests/capabilities actions[]. */
export interface ActionPayment {
  network?: string;
  asset?: string;
  /** Price of one unit in wei (integer string). */
  amount?: string;
  payTo?: string;
  decimals?: number;
  quoteTtlSeconds?: number;
}

export interface Capabilities {
  /** Payment terms keyed by action name. There is no top-level asset/payTo/price. */
  actions: Record<string, ActionPayment>;
  /** action -> unit, e.g. { "schedule.create": "run" }: amount is charged once per unit. */
  pricedPer: Record<string, string>;
  raw: unknown;
}

export interface ChallengeAccept extends Record<string, unknown> {
  maxTimeoutSeconds?: unknown;
}

export interface Challenge {
  accepts: ChallengeAccept[];
  quote: {
    id: string;
    quoteHash: string;
    action: string;
    payment: { asset: string; amount: string; payTo: string };
    expiresAt: unknown;
  };
  resource: unknown;
  resourceUrl: string;
  requesterScopeHash: string;
  /** The exact prepared input saved with the quote (e.g. schedule runs). */
  input: unknown;
  raw: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Thin HTTP client for https://api.imd.fun (server-side only).
 * Auth is a per-process random bearer token, as required by the paid-request flow.
 */
export class ImdClient {
  private readonly bearer: string;
  private actionsCache: Record<string, ActionSpec> | null = null;
  private capabilitiesCache: Capabilities | null = null;

  constructor(private readonly baseUrl: string) {
    this.bearer = randomBearer();
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; okStatuses?: number[] } = {},
  ): Promise<{ status: number; json: unknown; text: string }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.bearer}`,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON — keep text */
    }
    if (!(opts.okStatuses ?? [200, 201, 202]).includes(res.status)) {
      throw new ApiError(res.status, path, json ?? text);
    }
    return { status: res.status, json, text };
  }

  /** GET /requests/capabilities — per-action price, asset, payTo and quote lifetime. */
  async capabilities(force = false): Promise<Capabilities> {
    if (this.capabilitiesCache && !force) return this.capabilitiesCache;
    const { json } = await this.request("GET", "/requests/capabilities");
    this.capabilitiesCache = parseCapabilities(json);
    return this.capabilitiesCache;
  }

  /** GET /openapi.json — paid actions live under x-imd-actions. */
  async actions(force = false): Promise<Record<string, ActionSpec>> {
    if (this.actionsCache && !force) return this.actionsCache;
    const { json } = await this.request("GET", "/openapi.json");
    const root = (json ?? {}) as Record<string, unknown>;
    const x = root["x-imd-actions"];
    this.actionsCache = normaliseActions(x);
    return this.actionsCache;
  }

  /** POST /requests/check — free evaluator verdict. Noisy; caller retries. */
  async check(action: string, input: unknown): Promise<unknown> {
    const { json } = await this.request("POST", "/requests/check", { body: { action, input } });
    return json;
  }

  /** POST /requests/check with up to 3 attempts (the evaluator is noisy). */
  async checkWithRetry(action: string, input: unknown): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.check(action, input);
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await sleep(250 * attempt);
      }
    }
    throw lastErr;
  }

  /** POST /requests/import — public GitHub repo -> { repoUrl, baseCommit }. */
  async importRepo(url: string, kind: string): Promise<unknown> {
    const { json } = await this.request("POST", "/requests/import", { body: { url, kind } });
    return json;
  }

  /** POST /requests/quote — creates an order; returns the order id. */
  async quote(action: string, input: unknown): Promise<string> {
    const { json } = await this.request("POST", "/requests/quote", {
      body: { requestKey: randomUUID(), action, input },
      okStatuses: [200, 201],
    });
    const id = (json as { order?: { id?: string } } | undefined)?.order?.id;
    if (typeof id !== "string" || !id) {
      throw new Error(`quote response did not contain order.id: ${JSON.stringify(json)}`);
    }
    return id;
  }

  /** GET /requests/{id} — current request/order status. */
  async getRequest(id: string): Promise<Record<string, unknown>> {
    const { json } = await this.request("GET", `/requests/${encodeURIComponent(id)}`);
    return (json ?? {}) as Record<string, unknown>;
  }

  /**
   * POST /requests/{id}/submit with no payment.
   * Expects the 402 challenge; throws on anything unexpected.
   */
  async getChallenge(id: string): Promise<Challenge> {
    const { status, json } = await this.request("POST", `/requests/${encodeURIComponent(id)}/submit`, {
      okStatuses: [402],
    });
    if (status !== 402 || typeof json !== "object" || json === null) {
      throw new Error(`expected a 402 payment challenge, got HTTP ${status}`);
    }
    const o = json as Record<string, unknown>;
    const quote = o.quote as Record<string, unknown> | undefined;
    const payment = (quote?.payment ?? {}) as Record<string, unknown>;
    const challenge: Challenge = {
      accepts: Array.isArray(o.accepts) ? (o.accepts as ChallengeAccept[]) : [],
      quote: {
        id: str(quote?.id) ?? "",
        quoteHash: str(quote?.quoteHash) ?? str(quote?.quote_hash) ?? "",
        action: str(quote?.action) ?? "",
        payment: {
          asset: str(payment.asset) ?? "",
          amount: str(payment.amount) ?? "",
          payTo: str(payment.payTo) ?? str(payment.pay_to) ?? "",
        },
        expiresAt: quote?.expiresAt ?? quote?.expires_at,
      },
      resource: o.resource,
      resourceUrl: str(o.resourceUrl) ?? str(o.resource_url) ?? "",
      requesterScopeHash: str(o.requesterScopeHash) ?? str(o.requester_scope_hash) ?? "",
      input: o.input,
      raw: o,
    };
    return challenge;
  }

  /**
   * POST /requests/{id}/submit with PAYMENT-SIGNATURE + { quoteSignature }.
   * Returns the raw response (202 pending or 200 outcome).
   */
  async submitPayment(
    id: string,
    payment: Record<string, unknown>,
    quoteSignature: string,
  ): Promise<{ status: number; json: unknown }> {
    const encoded = Buffer.from(JSON.stringify(payment), "utf8").toString("base64");
    return this.request("POST", `/requests/${encodeURIComponent(id)}/submit`, {
      headers: { "payment-signature": encoded },
      body: { quoteSignature },
      okStatuses: [200, 202],
    });
  }

  /** Poll GET /requests/{id} until the status leaves the pending set. */
  async pollRequest(
    id: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const pending = new Set(["quoted", "payment_pending", "admission_pending"]);
    const intervalMs = opts.intervalMs ?? 2_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    for (;;) {
      const req = await this.getRequest(id);
      const status = str(req.status) ?? "";
      if (!pending.has(status)) return req;
      if (Date.now() > deadline) {
        throw new Error(`request ${id} still '${status}' after ${opts.timeoutMs ?? 300_000}ms`);
      }
      await sleep(intervalMs);
    }
  }

  /** GET /jobs/{id} */
  async job(id: string): Promise<unknown> {
    const { json } = await this.request("GET", `/jobs/${encodeURIComponent(id)}`);
    return json;
  }

  /** GET /jobs/{id}/report.md — plain markdown. */
  async jobReport(id: string): Promise<string> {
    const { text } = await this.request("GET", `/jobs/${encodeURIComponent(id)}/report.md`);
    return text;
  }

  /** GET /schedules?owner= — list one owner's schedules. */
  async schedules(owner: string): Promise<unknown> {
    const { json } = await this.request("GET", `/schedules?owner=${encodeURIComponent(owner)}`);
    return json;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/**
 * Parse GET /requests/capabilities: { actions: [{ action, version, payment:
 * { network, asset, amount, payTo, decimals }, quoteTtlSeconds }], pricedPer, ... }.
 */
export function parseCapabilities(json: unknown): Capabilities {
  const o = (json ?? {}) as Record<string, unknown>;
  const actions: Record<string, ActionPayment> = {};
  for (const item of Array.isArray(o.actions) ? o.actions : []) {
    const a = (item ?? {}) as Record<string, unknown>;
    const name = str(a.action);
    if (!name) continue;
    const p = (a.payment ?? {}) as Record<string, unknown>;
    actions[name] = {
      network: str(p.network),
      asset: str(p.asset),
      amount: str(p.amount),
      payTo: str(p.payTo),
      decimals: num(p.decimals),
      quoteTtlSeconds: num(a.quoteTtlSeconds),
    };
  }
  const pricedPer: Record<string, string> = {};
  if (o.pricedPer && typeof o.pricedPer === "object") {
    for (const [name, unit] of Object.entries(o.pricedPer as Record<string, unknown>)) {
      if (str(unit)) pricedPer[name] = unit as string;
    }
  }
  return { actions, pricedPer, raw: json };
}

/**
 * Normalise the x-imd-actions extension: an array of
 * { action, version, payment, quoteTtlSeconds, limits }, keyed by .action.
 */
export function normaliseActions(x: unknown): Record<string, ActionSpec> {
  const out: Record<string, ActionSpec> = {};
  const fromEntry = (name: string, spec: unknown) => {
    const s = (spec ?? {}) as Record<string, unknown>;
    const inputSchema =
      (s.inputSchema as Record<string, unknown> | undefined) ??
      (s.input as Record<string, unknown> | undefined) ??
      (s.schema as Record<string, unknown> | undefined) ??
      (s.parameters as Record<string, unknown> | undefined);
    out[name] = {
      name,
      description: str(s.description) ?? str(s.summary),
      inputSchema: inputSchema && typeof inputSchema === "object" ? inputSchema : undefined,
      raw: spec,
    };
  };
  if (Array.isArray(x)) {
    for (const item of x) {
      const name = str((item as Record<string, unknown> | null)?.action);
      if (name) fromEntry(name, item);
    }
  }
  return out;
}
