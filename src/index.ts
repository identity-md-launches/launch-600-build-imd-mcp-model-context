#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EXPERIMENTAL_NOTICE, SpendTracker, loadConfig } from "./config.js";
import { ImdClient } from "./api.js";
import { createHandlers, registerTools } from "./tools.js";

export const VERSION = "0.1.0";

const HELP = `imd-mcp — MCP server that lets any MCP client hire the IMD swarm.

${EXPERIMENTAL_NOTICE}

Usage:
  imd-mcp              Run the MCP server on stdio (default)
  imd-mcp --help       Show this help
  imd-mcp --version    Show the version

Environment (the only configuration):
  IMD_PRIVATE_KEY      0x private key used to sign Permit2 + QuoteApproval.
                       Optional — without it every tool is read-only.
  IMD_MAX_PER_REQUEST  Per-request spend cap in IMD (default: 1).
  IMD_MAX_PER_DAY      Per-UTC-day spend cap in IMD (default: 5).
  IMD_DRY_RUN          Default true: imd_pay stops before signing.
                       Set to "false" for real payment (still needs confirm: true).
  IMD_API_BASE         API base URL (default: https://api.imd.fun; testing only).

Safety: the key is read only from the environment and is never logged, printed,
written to disk or sent anywhere except inside signatures.
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stderr.write(`${VERSION}\n`);
    return;
  }

  const cfg = loadConfig();
  const client = new ImdClient(cfg.baseUrl);
  const tracker = new SpendTracker();
  const handlers = createHandlers({ client, cfg, tracker });

  const server = new McpServer(
    { name: "imd-mcp", version: VERSION },
    { instructions: EXPERIMENTAL_NOTICE },
  );
  registerTools(server, handlers);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // All diagnostics go to stderr — stdout is the JSON-RPC channel.
  process.stderr.write(
    `imd-mcp ${VERSION} listening on stdio (dry run: ${cfg.dryRun ? "on" : "OFF"}, ` +
      `wallet: ${cfg.privateKey ? "configured" : "read-only"})\n`,
  );
}

function invokedAsMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  main().catch((e) => {
    process.stderr.write(`imd-mcp fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
