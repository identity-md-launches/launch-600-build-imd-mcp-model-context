# Changelog

> **Experimental, commissioned as a test of the IMD swarm. It may not work as
> described. Read the code, start with small amounts, no warranty.**

## 2026-10-03 — MCP directory preparation

Added official MCP Registry metadata, Glama maintainer metadata, a non-root
Node slim Docker image definition, and owner publishing instructions. Recorded
the real-payment verification of commit `865972d`. No server behavior changed.

## Unreleased — payment window fix

Checked `https://api.imd.fun` on 2026-10-03 with read-only GETs, a free
`POST /requests/check`, and a free `job.open` quote and 402 challenge. The
live responses used are in `fixtures/live/`; no payment was submitted during
those checks. Later verified with a real paid `job.open` through `imd_pay` on
Ethereum mainnet on 2026-10-03 at commit `865972d`: order
`03fab9a5-30a2-49e4-9f70-455211d87d8f`, submit 202, admitted.

1. **Permit2 deadline.** The signed deadline is now the earlier of five
   seconds before quote expiry and five seconds before the challenge's
   `accepts[0].maxTimeoutSeconds` window ends. Missing, invalid, or too-short
   windows raise `PaymentRefusal` before the daily spend reservation.
2. **Mock payment window.** The mock now uses a 600-second quote lifetime and
   returns HTTP 400 `invalid_payment_window` for a Permit2 deadline beyond
   its 300-second maximum. Tests reject the old roughly 595-second deadline
   and accept a real `payOrder` signature.
3. **Live challenge test.** A fresh 402 body is saved as
   `fixtures/live/challenge-job.open.response.json`. A unit test signs its
   terms and checks the deadline against `maxTimeoutSeconds`.
4. **Submit errors.** A 4xx submit response now includes the server's error
   code explicitly in the `imd_pay` message.

## Unreleased — work against the live IMD API

Checked against `https://api.imd.fun` on 2026-10-02 with read-only GETs and
the free `POST /requests/check`. The bodies used are saved in `fixtures/live/`.

1. **Capabilities.** The live `GET /requests/capabilities` has no top-level
   `asset`, `payTo` or `price`. Each action has its own entry in `actions[]`, with
   `payment: {network, asset, amount, payTo, decimals}`. `capabilities()`
   (`src/api.ts`, new `parseCapabilities`) now returns those entries keyed by
   action, plus `pricedPer`. `verifyChallenge` (`src/pay.ts`) compares the
   challenge with the entry whose `action` equals the quoted action. It refuses
   when that entry is missing.
2. **Action list.** The live `x-imd-actions` in `GET /openapi.json` is an array
   keyed by `.action`. `normaliseActions` (now exported) keys on `.action`
   instead of `name`/`id`, and no longer accepts a map. Before this change
   `imd_quote` answered `unknown action "job.open"`. The live payload has no
   per-action input schemas, so input is passed through. `imd_quote`'s 422
   `invalid_input` problems are returned as-is and point to `imd_check`.
3. **Amount.** When `pricedPer[action]` is `"run"` (`schedule.create`,
   `schedule.topup`), the expected amount is `payment.amount × runs`, using
   integer math. `runs` comes from the `input` the challenge pins. For every
   other action it is `payment.amount`. `IMD_MAX_PER_REQUEST`/`IMD_MAX_PER_DAY`
   apply to that total. Before this change every schedule with `runs > 1` was
   refused.
4. **Mock and tests.** `tests/mock-server.ts` now serves the saved live
   capabilities, openapi and check bodies. Prices in the mock come from them.
   The invented `swarm.launch` action and its invented input schemas are gone.
   The tests use a real `job.open` input. The new `tests/live.test.ts` loads the
   saved live bodies. It checks that `capabilities()` and `normaliseActions`
   parse them, and that `imd_quote` and the pay-terms check accept a real
   `job.open` and a 3-run `schedule.create` at 3 × 0.5 IMD (2 × 0.5 is refused).
5. **README.** Every `github:<owner>/imd-mcp` is now
   `github:identity-md-launches/launch-600-build-imd-mcp-model-context`. This
   covers each client config block, the clone command and the local path. The
   README also documents per-run pricing and the pass-through input.

Dry run and the spending caps remain the defaults, and the tool names are
unchanged.
