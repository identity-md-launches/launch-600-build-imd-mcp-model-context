import { formatUnits, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHAIN_ID,
  Config,
  IMD_ASSET,
  IMD_DECIMALS,
  PERMIT2,
  SpendTracker,
  X402_SPENDER,
} from "./config.js";
import { Capabilities, Challenge, ImdClient } from "./api.js";
import { asHex32, eqAddress, paymentHashOf, randomNonce, toEpochSeconds } from "./util.js";

/** Thrown when a payment is refused by a local safety check. Never a network error. */
export class PaymentRefusal extends Error {
  constructor(message: string) {
    super(`payment refused: ${message}`);
    this.name = "PaymentRefusal";
  }
}

const PERMIT_TYPES = {
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

const QUOTE_APPROVAL_TYPES = {
  QuoteApproval: [
    { name: "resource", type: "string" },
    { name: "requesterScopeHash", type: "bytes32" },
    { name: "quoteId", type: "string" },
    { name: "quoteHash", type: "bytes32" },
    { name: "paymentHash", type: "bytes32" },
    { name: "action", type: "string" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "payTo", type: "address" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export interface VerifiedPayment {
  asset: `0x${string}`;
  amountWei: bigint;
  payTo: `0x${string}`;
  expiresAtSec: bigint;
  accept: Record<string, unknown>;
}

export interface PayResult {
  orderId: string;
  dryRun: boolean;
  paid: boolean;
  amountImd?: string;
  amountWei?: string;
  payTo?: string;
  quoteId?: string;
  submitStatus?: number;
  final?: Record<string, unknown>;
  message: string;
}

/**
 * The amount capabilities allow for one quote: payment.amount, times the
 * request's runs when the action is priced per run (schedule.create/topup).
 */
export function expectedAmountWei(caps: Capabilities, action: string, input: unknown): bigint {
  const unitWei = BigInt(caps.actions[action]?.amount ?? "0");
  const per = caps.pricedPer[action];
  if (per === undefined) return unitWei;
  if (per !== "run") throw new PaymentRefusal(`action ${action} is priced per "${per}", which is not supported`);
  const runs = (input as { runs?: unknown } | null | undefined)?.runs;
  if (typeof runs !== "number" || !Number.isSafeInteger(runs) || runs <= 0) {
    throw new PaymentRefusal(`action ${action} is priced per run but the quoted input has no positive integer runs`);
  }
  return unitWei * BigInt(runs);
}

/**
 * Verify a 402 challenge against the capabilities entry for the quoted action
 * and against its own quote. Refuses (throws PaymentRefusal) on any mismatch —
 * this is what blocks look-alike asset/payTo poisoning and over-quotes.
 */
export function verifyChallenge(challenge: Challenge, capabilities: Capabilities): VerifiedPayment {
  if (!challenge.accepts.length) {
    throw new PaymentRefusal("challenge contains no accepts[] entries");
  }
  const accept = challenge.accepts[0];
  const quote = challenge.quote;
  const payment = quote.payment;

  if (!quote.id || !quote.quoteHash || !quote.action) {
    throw new PaymentRefusal("challenge quote is missing id, quoteHash or action");
  }
  const caps = capabilities.actions[quote.action];
  if (!caps) {
    throw new PaymentRefusal(`capabilities has no payment entry for action ${quote.action}`);
  }
  for (const [field, v] of [
    ["asset", caps.asset],
    ["payTo", caps.payTo],
    ["amount", caps.amount],
  ] as const) {
    if (!v) {
      throw new PaymentRefusal(
        `capabilities ${quote.action} payment.${field} is missing — cannot verify the challenge`,
      );
    }
  }

  // --- asset: challenge + quote + capabilities must all be the real IMD token ---
  if (!eqAddress(payment.asset, IMD_ASSET)) {
    throw new PaymentRefusal(`quote asset ${payment.asset} is not IMD (${IMD_ASSET})`);
  }
  if (!eqAddress(caps.asset, IMD_ASSET) || !eqAddress(caps.asset, payment.asset)) {
    throw new PaymentRefusal(
      `capabilities asset ${caps.asset} differs from the quoted asset ${payment.asset}`,
    );
  }
  if (!eqAddress(accept.asset, payment.asset)) {
    throw new PaymentRefusal(
      `accepts[0].asset ${String(accept.asset)} differs from the quoted asset ${payment.asset}`,
    );
  }
  if (!isAddress(payment.asset)) throw new PaymentRefusal(`asset ${payment.asset} is not an address`);

  // --- payTo: quote + accepts[0] + capabilities must agree (anti-poisoning) ---
  if (!caps.payTo || !isAddress(caps.payTo)) {
    throw new PaymentRefusal(`capabilities payTo ${caps.payTo} is not an address`);
  }
  if (!eqAddress(payment.payTo, caps.payTo)) {
    throw new PaymentRefusal(
      `quote payTo ${payment.payTo} differs from capabilities payTo ${caps.payTo}`,
    );
  }
  if (!eqAddress(accept.payTo, caps.payTo)) {
    throw new PaymentRefusal(
      `accepts[0].payTo ${String(accept.payTo)} differs from capabilities payTo ${caps.payTo}`,
    );
  }

  // --- amount: identical everywhere, and exactly the capabilities price (x runs) ---
  let amountWei: bigint;
  try {
    amountWei = BigInt(payment.amount);
  } catch {
    throw new PaymentRefusal(`quoted amount ${payment.amount} is not an integer`);
  }
  if (amountWei <= 0n) throw new PaymentRefusal(`quoted amount ${payment.amount} is not positive`);
  const acceptAmount = BigInt(String(accept.amount ?? "0"));
  if (acceptAmount !== amountWei) {
    throw new PaymentRefusal(
      `accepts[0].amount ${String(accept.amount)} differs from the quoted amount ${payment.amount}`,
    );
  }
  let capPriceWei: bigint;
  try {
    capPriceWei = expectedAmountWei(capabilities, quote.action, challenge.input);
  } catch (e) {
    if (e instanceof PaymentRefusal) throw e;
    throw new PaymentRefusal(`capabilities ${quote.action} payment.amount ${caps.amount} is not an integer`);
  }
  if (amountWei !== capPriceWei) {
    throw new PaymentRefusal(
      `quoted amount ${payment.amount} differs from capabilities price ${capPriceWei.toString(10)} ` +
        `(${quote.action} payment.amount ${caps.amount}${capabilities.pricedPer[quote.action] ? " per run" : ""})`,
    );
  }

  // --- accepts[0] sanity (x402 exact on mainnet) ---
  if (accept.scheme !== undefined && accept.scheme !== "exact") {
    throw new PaymentRefusal(`accepts[0].scheme ${String(accept.scheme)} is not "exact"`);
  }
  if (accept.network !== undefined) {
    const ok = ["eip155:1", "ethereum", "mainnet", "1"].includes(String(accept.network).toLowerCase());
    if (!ok) throw new PaymentRefusal(`accepts[0].network ${String(accept.network)} is not mainnet`);
  }

  // --- expiry: refuse stale quotes; deadline is expiresAt - 5s ---
  const expiresAtSec = toEpochSeconds(quote.expiresAt, "quote.expiresAt");
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (expiresAtSec <= nowSec + 10n) {
    throw new PaymentRefusal(`quote expiresAt ${String(quote.expiresAt)} has already expired`);
  }

  return {
    asset: getAddress(payment.asset),
    amountWei,
    payTo: getAddress(caps.payTo!),
    expiresAtSec,
    accept,
  };
}

export interface SignResult {
  payment: Record<string, unknown>;
  quoteSignature: string;
  paymentHash: `0x${string}`;
}

/** Produce the x402 payment object and the QuoteApproval signature. */
export async function signPayment(
  privateKey: `0x${string}`,
  challenge: Challenge,
  verified: VerifiedPayment,
): Promise<SignResult> {
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(privateKey);
  } catch {
    // Never propagate a crypto-library validation message: some implementations
    // include the supplied private scalar in it.
    throw new PaymentRefusal("configured private key is invalid");
  }
  const deadline = verified.expiresAtSec - 5n; // at most expiresAt minus 5s
  const nonce = BigInt(randomNonce());

  const signature = await account.signTypedData({
    domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 },
    types: PERMIT_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: verified.asset, amount: verified.amountWei },
      spender: X402_SPENDER,
      nonce,
      deadline,
      witness: { to: verified.payTo, validAfter: 0n },
    },
  });

  // Numbers as decimal strings, no extra fields — the server rejects extra fields.
  const payment: Record<string, unknown> = {
    x402Version: 2,
    resource: challenge.resource,
    accepted: verified.accept,
    payload: {
      signature,
      permit2Authorization: {
        from: account.address,
        permitted: { token: verified.asset, amount: verified.amountWei.toString(10) },
        spender: X402_SPENDER,
        nonce: nonce.toString(10),
        deadline: deadline.toString(10),
        witness: { to: verified.payTo, validAfter: "0" },
      },
    },
  };

  const paymentHash = paymentHashOf(payment);
  const quoteSignature = await account.signTypedData({
    domain: { name: "IdentityMD Paid Action", version: "1", chainId: CHAIN_ID },
    types: QUOTE_APPROVAL_TYPES,
    primaryType: "QuoteApproval",
    message: {
      resource: challenge.resourceUrl,
      requesterScopeHash: asHex32(challenge.requesterScopeHash, "requesterScopeHash"),
      quoteId: challenge.quote.id,
      quoteHash: asHex32(challenge.quote.quoteHash, "quote.quoteHash"),
      paymentHash,
      action: challenge.quote.action,
      asset: verified.asset,
      amount: verified.amountWei,
      payTo: verified.payTo,
      expiresAt: verified.expiresAtSec,
    },
  });

  return { payment, quoteSignature, paymentHash };
}

/**
 * Full paid-request flow for an already-quoted order:
 * submit -> 402 challenge -> verify -> caps -> sign -> submit -> poll.
 * Dry run stops after verification, before any signature.
 */
export async function payOrder(
  client: ImdClient,
  cfg: Config,
  tracker: SpendTracker,
  orderId: string,
  poll: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<PayResult> {
  if (!cfg.privateKey) {
    throw new PaymentRefusal(
      "IMD_PRIVATE_KEY is not set — this server is read-only and cannot pay",
    );
  }

  const current = await client.getRequest(orderId);
  const status = String(current.status ?? "");
  if (["payment_pending", "admission_pending"].includes(status)) {
    // This state means a payment has already been submitted. Poll it rather
    // than create a fresh Permit2 nonce/signature on a retry.
    const final = await client.pollRequest(orderId, poll);
    return {
      orderId,
      dryRun: false,
      paid: true,
      final,
      message: `order is already '${status}' — polled its existing payment; final status ${String(final.status ?? "?")}`,
    };
  }
  if (status && status !== "quoted") {
    return {
      orderId,
      dryRun: false,
      paid: false,
      final: current,
      message: `order is already '${status}' — nothing to pay`,
    };
  }

  const challenge = await client.getChallenge(orderId);
  const caps = await client.capabilities();
  const verified = verifyChallenge(challenge, caps);
  const amountImd = formatUnits(verified.amountWei, IMD_DECIMALS);

  // Spending caps are enforced before any signature exists.
  if (verified.amountWei > cfg.maxPerRequestWei) {
    throw new PaymentRefusal(
      `${amountImd} IMD exceeds the per-request cap IMD_MAX_PER_REQUEST=${formatUnits(cfg.maxPerRequestWei, IMD_DECIMALS)}`,
    );
  }
  if (cfg.dryRun) {
    return {
      orderId,
      dryRun: true,
      paid: false,
      amountImd,
      amountWei: verified.amountWei.toString(10),
      payTo: verified.payTo,
      quoteId: challenge.quote.id,
      message:
        "dry run: verified the quote and stopped before signing. " +
        "Set IMD_DRY_RUN=false and call imd_pay again with confirm: true to pay for real.",
    };
  }

  // This durable reservation is intentionally made immediately before signing,
  // not after submit. If the server accepts a payment but the response is lost,
  // the authorization remains counted for the day rather than enabling a
  // second spend. reserve() is atomic across local MCP processes.
  const reservation = await tracker.reserve(orderId, verified.amountWei, cfg.maxPerDayWei);
  if (reservation.state === "cap_exceeded") {
    throw new PaymentRefusal(
      `${amountImd} IMD would exceed the per-day cap IMD_MAX_PER_DAY=${formatUnits(cfg.maxPerDayWei, IMD_DECIMALS)} ` +
        `(${formatUnits(reservation.spentBefore, IMD_DECIMALS)} already reserved today)`,
    );
  }
  if (reservation.state === "existing") {
    throw new PaymentRefusal(
      "this order already has a locally reserved payment authorization; refusing to sign it again",
    );
  }

  const signed = await signPayment(cfg.privateKey, challenge, verified);
  const submit = await client.submitPayment(orderId, signed.payment, signed.quoteSignature);

  const final = await client.pollRequest(orderId, poll);
  return {
    orderId,
    dryRun: false,
    paid: true,
    amountImd,
    amountWei: verified.amountWei.toString(10),
    payTo: verified.payTo,
    quoteId: challenge.quote.id,
    submitStatus: submit.status,
    final,
    message: `paid ${amountImd} IMD for order ${orderId}; final status ${String(final.status ?? "?")}`,
  };
}
