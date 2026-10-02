import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Ajv, type ValidateFunction } from "ajv";
import { Config, EXPERIMENTAL_NOTICE, SpendTracker } from "./config.js";
import { ApiError, ImdClient } from "./api.js";
import { payOrder } from "./pay.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const err = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});
const fail = (e: unknown): ToolResult => err(e instanceof Error ? e.message : String(e));

const ajv = new Ajv({ allErrors: true, strict: false });

/** Context shared by every tool handler. */
export interface ToolContext {
  client: ImdClient;
  cfg: Config;
  tracker: SpendTracker;
}

/**
 * Check a paid action against GET /openapi.json x-imd-actions. The live API
 * advertises no per-action input schema, so input is passed through; if a
 * schema ever appears it is applied. The server's 422 invalid_input response
 * (and the free imd_check verdict) is authoritative.
 */
async function validateActionInput(
  ctx: ToolContext,
  action: string,
  input: unknown,
): Promise<string | null> {
  let spec;
  try {
    spec = (await ctx.client.actions())[action];
  } catch (e) {
    return `could not fetch action list: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!spec) {
    return `unknown action "${action}". Known actions: ${Object.keys(await ctx.client.actions()).join(", ") || "(none advertised)"}`;
  }
  if (!spec.inputSchema) return null;
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(spec.inputSchema);
  } catch {
    return null; // schema uses keywords we don't support — let the server judge
  }
  if (validate(input)) return null;
  return `input does not satisfy the "${action}" schema: ${ajv.errorsText(validate.errors)}`;
}

export function createHandlers(ctx: ToolContext) {
  return {
    /** GET /requests/capabilities + advertised actions from /openapi.json. */
    async imd_capabilities(): Promise<ToolResult> {
      try {
        const caps = await ctx.client.capabilities(true);
        const actions = await ctx.client.actions(true);
        return ok({
          capabilities: caps.raw,
          actions: Object.fromEntries(
            Object.entries(actions).map(([name, a]) => [
              name,
              { description: a.description, inputSchema: a.inputSchema },
            ]),
          ),
          walletConfigured: Boolean(ctx.cfg.privateKey),
          dryRun: ctx.cfg.dryRun,
        });
      } catch (e) {
        return fail(e);
      }
    },

    /** POST /requests/check — free evaluator verdict (retries up to 3x). */
    async imd_check(args: { action: string; input: unknown }): Promise<ToolResult> {
      try {
        return ok(await ctx.client.checkWithRetry(args.action, args.input));
      } catch (e) {
        return fail(e);
      }
    },

    /** POST /requests/import — import a public GitHub repo -> repoUrl + baseCommit. */
    async imd_import_repo(args: { url: string; kind: string }): Promise<ToolResult> {
      try {
        return ok(await ctx.client.importRepo(args.url, args.kind));
      } catch (e) {
        return fail(e);
      }
    },

    /** Quote only: create the order, fetch the 402 challenge, return price + order id. */
    async imd_quote(args: { action: string; input: Record<string, unknown> }): Promise<ToolResult> {
      try {
        const invalid = await validateActionInput(ctx, args.action, args.input);
        if (invalid) return err(invalid);
        const orderId = await ctx.client.quote(args.action, args.input);
        const challenge = await ctx.client.getChallenge(orderId);
        const q = challenge.quote;
        return ok({
          orderId,
          quote: {
            id: q.id,
            quoteHash: q.quoteHash,
            action: q.action,
            payment: q.payment,
            expiresAt: q.expiresAt,
          },
          message:
            "quote only — nothing was paid. Call imd_pay with this orderId and confirm: true to pay.",
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 422) {
          return err(
            `invalid_input: ${JSON.stringify((e.body as { problems?: unknown })?.problems ?? e.body)} ` +
              "(imd_check gives the free evaluator verdict for this action and input)",
          );
        }
        return fail(e);
      }
    },

    /** Pay a quoted order. Requires confirm: true; honours caps and IMD_DRY_RUN. */
    async imd_pay(args: { orderId: string; confirm: boolean }): Promise<ToolResult> {
      if (args.confirm !== true) {
        return err(
          "imd_pay spends real IMD. Call it again with confirm: true once you have checked the quote.",
        );
      }
      try {
        return ok(await payOrder(ctx.client, ctx.cfg, ctx.tracker, args.orderId));
      } catch (e) {
        return fail(e);
      }
    },

    /** GET /requests/{id} — order status. */
    async imd_order_status(args: { orderId: string }): Promise<ToolResult> {
      try {
        return ok(await ctx.client.getRequest(args.orderId));
      } catch (e) {
        return fail(e);
      }
    },

    /** GET /jobs/{id}, optionally with /jobs/{id}/report.md. */
    async imd_job(args: { jobId: string; report: boolean }): Promise<ToolResult> {
      try {
        const job = await ctx.client.job(args.jobId);
        const report = args.report ? await ctx.client.jobReport(args.jobId) : undefined;
        return ok({ job, ...(report !== undefined ? { report } : {}) });
      } catch (e) {
        return fail(e);
      }
    },

    /** GET /schedules?owner= — list one owner's schedules. */
    async imd_schedules(args: { owner: string }): Promise<ToolResult> {
      try {
        return ok(await ctx.client.schedules(args.owner));
      } catch (e) {
        return fail(e);
      }
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;

const NOTICE = `Experimental: ${EXPERIMENTAL_NOTICE}`;

export function registerTools(server: McpServer, handlers: Handlers): void {
  server.registerTool(
    "imd_capabilities",
    {
      title: "IMD capabilities",
      description:
        `${NOTICE} Read what the IMD swarm can do: price, payment asset, payTo, ` +
        "quote lifetime, launch chains, and the paid actions advertised in /openapi.json.",
      inputSchema: {},
    },
    handlers.imd_capabilities,
  );

  server.registerTool(
    "imd_check",
    {
      title: "IMD check",
      description:
        `${NOTICE} Free evaluator verdict for an action+input (POST /requests/check). ` +
        "No payment. Retried up to 3 times because the evaluator is noisy.",
      inputSchema: {
        action: z.string().describe("Paid action name, e.g. from imd_capabilities"),
        input: z.record(z.unknown()).describe("Action input object"),
      },
    },
    async (args) => handlers.imd_check(args),
  );

  server.registerTool(
    "imd_import_repo",
    {
      title: "IMD import repo",
      description:
        `${NOTICE} Import a public GitHub repository (POST /requests/import); ` +
        "returns repoUrl + baseCommit to use in paid-action inputs.",
      inputSchema: {
        url: z.string().url().describe("Public GitHub repository URL"),
        kind: z.string().default("github").describe("Import kind, e.g. 'github'"),
      },
    },
    async (args) => handlers.imd_import_repo(args),
  );

  server.registerTool(
    "imd_quote",
    {
      title: "IMD quote",
      description:
        `${NOTICE} Quote a paid action only — creates the order and returns the price ` +
        "and order id. Nothing is paid. Actions come from the server's x-imd-actions at " +
        "runtime, so new actions work without upgrading this package. Input is passed " +
        "through; run imd_check first, and the server's 422 problems are returned as-is.",
      inputSchema: {
        action: z.string().describe("Paid action name from imd_capabilities"),
        input: z.record(z.unknown()).describe("Action input, validated by the server"),
      },
    },
    async (args) => handlers.imd_quote(args),
  );

  server.registerTool(
    "imd_pay",
    {
      title: "IMD pay",
      description:
        `${NOTICE} Pay a quoted order from imd_quote. Requires confirm: true. ` +
        "Honours IMD_DRY_RUN (default on: stops before signing), IMD_MAX_PER_REQUEST " +
        "and IMD_MAX_PER_DAY. Refuses any challenge whose asset, payTo or amount " +
        "differs from capabilities or the quote.",
      inputSchema: {
        orderId: z.string().describe("orderId returned by imd_quote"),
        confirm: z.boolean().describe("Must be true to pay"),
      },
    },
    async (args) => handlers.imd_pay(args),
  );

  server.registerTool(
    "imd_order_status",
    {
      title: "IMD order status",
      description: `${NOTICE} GET /requests/{id} — current status of a quoted/paid order.`,
      inputSchema: { orderId: z.string().describe("Order/request id") },
    },
    async (args) => handlers.imd_order_status(args),
  );

  server.registerTool(
    "imd_job",
    {
      title: "IMD job",
      description:
        `${NOTICE} GET /jobs/{id}; when report is true also fetches /jobs/{id}/report.md.`,
      inputSchema: {
        jobId: z.string().describe("Job id"),
        report: z.boolean().default(false).describe("Also fetch the markdown report"),
      },
    },
    async (args) => handlers.imd_job(args),
  );

  server.registerTool(
    "imd_schedules",
    {
      title: "IMD schedules",
      description: `${NOTICE} GET /schedules?owner= — list the schedules owned by one address.`,
      inputSchema: { owner: z.string().describe("Owner address") },
    },
    async (args) => handlers.imd_schedules(args),
  );
}
