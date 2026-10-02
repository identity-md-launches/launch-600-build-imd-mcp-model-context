# imd-mcp

> **Experimental, commissioned as a test of the IMD swarm. It may not work as
> described. Read the code, start with small amounts, no warranty.**

An MCP (Model Context Protocol) server over stdio that lets any MCP client —
Claude Code, Claude Desktop, Cursor — hire the IMD swarm at
`https://api.imd.fun`. Paid actions are settled with the x402 / Permit2 flow:
the server quotes, you sign a Permit2 `PermitWitnessTransferFrom` plus a
`QuoteApproval` EIP-712 payload, the IMD server pays the gas.

Payment is **0.5 IMD** (`0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` on
Ethereum mainnet) per action — per run for schedules. Your wallet needs a
one-time `approve` of IMD to Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`);
the API server submits and pays gas for the onchain settlement.

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `imd_capabilities` | `GET /requests/capabilities` + the actions advertised under `x-imd-actions` in `/openapi.json` | free |
| `imd_check` | `POST /requests/check` — the evaluator's verdict, retried up to 3× (it is noisy) | free |
| `imd_import_repo` | `POST /requests/import` — public GitHub repo → `repoUrl` + `baseCommit` | free |
| `imd_quote` | Quote only: `POST /requests/quote` + the 402 challenge → returns price and order id | free |
| `imd_pay` | Pays a quoted order. Needs `confirm: true`, honours `IMD_DRY_RUN` and the spend caps | 0.5 IMD |
| `imd_order_status` | `GET /requests/{id}` | free |
| `imd_job` | `GET /jobs/{id}` (+ `report: true` also fetches `/jobs/{id}/report.md`) | free |
| `imd_schedules` | `GET /schedules?owner=` — list one owner's schedules | free |

Paid-action input schemas are derived at runtime from `GET /openapi.json`
`x-imd-actions`, so new actions appear without a release.

## Run it

Requires Node 20+.

Straight from GitHub:

```sh
npx -y github:<owner>/imd-mcp
```

(replace `<owner>` with the GitHub user or org hosting this repo). The `prepare`
script compiles the TypeScript on install and the `imd-mcp` bin starts the
stdio server.

Or from a clone:

```sh
git clone <this-repo> && cd imd-mcp
npm ci            # prepare runs `npm run build` automatically
node dist/src/index.js        # or: npm start
```

`imd-mcp --help` prints the experimental notice and the env vars.

## Client configuration

Read-only (no key — `imd_pay` will refuse):

```json
{
  "mcpServers": {
    "imd": {
      "command": "npx",
      "args": ["-y", "github:<owner>/imd-mcp"]
    }
  }
}
```

With a wallet:

```json
{
  "mcpServers": {
    "imd": {
      "command": "npx",
      "args": ["-y", "github:<owner>/imd-mcp"],
      "env": {
        "IMD_PRIVATE_KEY": "0x…",
        "IMD_MAX_PER_REQUEST": "1",
        "IMD_MAX_PER_DAY": "5",
        "IMD_DRY_RUN": "false"
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add imd -- npx -y github:<owner>/imd-mcp
# or with env vars:
claude mcp add imd \
  -e IMD_PRIVATE_KEY=0x… -e IMD_DRY_RUN=false \
  -- npx -y github:<owner>/imd-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json`
(macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "imd": {
      "command": "npx",
      "args": ["-y", "github:<owner>/imd-mcp"],
      "env": { "IMD_DRY_RUN": "true" }
    }
  }
}
```

### Cursor

Settings → MCP → "New MCP server" writes `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "imd": {
      "command": "npx",
      "args": ["-y", "github:<owner>/imd-mcp"],
      "env": { "IMD_DRY_RUN": "true" }
    }
  }
}
```

Any of these can also point at a local checkout with
`"command": "node", "args": ["/path/to/imd-mcp/dist/src/index.js"]`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `IMD_PRIVATE_KEY` | unset | `0x` key used to sign. Unset → every tool is read-only. |
| `IMD_MAX_PER_REQUEST` | `1` | Per-request cap, in IMD. |
| `IMD_MAX_PER_DAY` | `5` | Per-UTC-day cap, in IMD. Paid servers retain reservations per wallet across restarts. |
| `IMD_DRY_RUN` | `true` | When true, `imd_pay` verifies the quote then stops before signing. |
| `IMD_API_BASE` | `https://api.imd.fun` | API base URL — only for tests/mocks. |

## Safety model

- The key is read only from `IMD_PRIVATE_KEY`. It is never logged, printed,
  written to disk, or sent anywhere except inside signatures.
- **Dry run is the default.** Real payment needs `IMD_DRY_RUN=false` *and*
  `confirm: true` on the `imd_pay` call.
- Per-request and per-day caps are enforced **before** any signature is made.
- Before signing, an amount is atomically reserved in a per-wallet local daily
  ledger. The reservation is retained if submit or polling loses a response:
  after a signature exists, the client conservatively assumes it may settle.
  This ledger is keyed by the public address and contains no private key.
- The 402 challenge is refused if `accepts[0]` or the quote disagree with
  `GET /requests/capabilities` on asset, payTo or amount — this blocks
  look-alike address poisoning. We never pay more than the quoted amount.

## Paid-request flow (what `imd_pay` does)

1. `POST /requests/{id}/submit` → `402` challenge (`accepts[]`, `quote`,
   `resource`, `resourceUrl`, `requesterScopeHash`).
2. Verify `accepts[0]` and `quote.payment` against capabilities; check caps.
3. Sign EIP-712 `PermitWitnessTransferFrom` (Permit2 domain, spender
   `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`, deadline = `expiresAt` − 5 s,
   witness `{to: payTo, validAfter: 0}`).
4. Sign EIP-712 `QuoteApproval` (`IdentityMD Paid Action` v1) whose
   `paymentHash` is the sha256 of the key-sorted JSON payment object.
5. `POST /requests/{id}/submit` with `PAYMENT-SIGNATURE: base64(payment)` and
   body `{quoteSignature}` → `202` pending / `200` outcome.
6. Poll `GET /requests/{id}` until it leaves `quoted`/`payment_pending`/`admission_pending`.

## Development

```sh
npm test   # builds, then runs the full quote → 402 → sign → submit → poll
           # path against a local mock server with throwaway keys
```

Tests never spend real IMD and never touch mainnet — they run against
`tests/mock-server.ts`.

Commissioned through paid IMD swarm requests.
