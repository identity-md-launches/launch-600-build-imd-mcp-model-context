import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isHex, parseUnits } from "viem";

/** IMD token on Ethereum mainnet. Payment for every paid action. */
export const IMD_ASSET = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
export const IMD_DECIMALS = 18;
export const CHAIN_ID = 1n;
export const DEFAULT_BASE_URL = "https://api.imd.fun";
/** Canonical x402 exact Permit2 spender on mainnet. */
export const X402_SPENDER = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
/** Canonical Permit2 contract (also the EIP-712 verifying contract). */
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** Order of the secp256k1 scalar field. Kept here to reject invalid keys safely. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export const EXPERIMENTAL_NOTICE =
  "Experimental, commissioned as a test of the IMD swarm. " +
  "It may not work as described. Read the code, start with small amounts, no warranty.";

export interface Config {
  /** Base URL of the IMD API. Only override for testing (IMD_API_BASE). */
  baseUrl: string;
  /** 0x-prefixed private key, or undefined for read-only mode. Never logged. */
  privateKey?: `0x${string}`;
  /** When true (the default), imd_pay stops before producing any signature. */
  dryRun: boolean;
  /** Per-request spending cap in wei of IMD. */
  maxPerRequestWei: bigint;
  /** Per-UTC-day spending cap in wei of IMD. */
  maxPerDayWei: bigint;
}

/** Parse a human IMD amount ("0.5", "2") or a raw wei integer into wei. */
export function parseImdAmount(raw: string | undefined, fallback: string): bigint {
  const v = (raw ?? fallback).trim();
  if (/^\d+$/.test(v) && raw !== undefined && v.length > 12) {
    // Plain integer large enough to be wei already (e.g. "500000000000000000").
    return BigInt(v);
  }
  return parseUnits(v, IMD_DECIMALS);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const key = env.IMD_PRIVATE_KEY?.trim();
  let privateKey: `0x${string}` | undefined;
  if (key) {
    const hex = key.startsWith("0x") ? key : `0x${key}`;
    if (!isHex(hex) || hex.length !== 66) {
      throw new Error("IMD_PRIVATE_KEY is set but is not a 32-byte hex private key");
    }
    // Do this before viem sees the key. Noble's range error includes the supplied
    // scalar as decimal, which would violate the no-key-disclosure guarantee.
    const scalar = BigInt(hex);
    if (scalar === 0n || scalar >= SECP256K1_N) {
      throw new Error("IMD_PRIVATE_KEY is invalid");
    }
    privateKey = hex as `0x${string}`;
  }
  return {
    baseUrl: (env.IMD_API_BASE ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    privateKey,
    dryRun: envFlagFrom(env, "IMD_DRY_RUN", true),
    maxPerRequestWei: parseImdAmount(env.IMD_MAX_PER_REQUEST, "1"),
    maxPerDayWei: parseImdAmount(env.IMD_MAX_PER_DAY, "5"),
  };
}

function envFlagFrom(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
}

interface Ledger {
  day: string;
  /** Amounts are held as decimal strings so JSON never loses wei precision. */
  reservations: Record<string, string>;
}

export interface SpendTrackerOptions {
  /** Public wallet address. Supplying it enables the durable, per-wallet ledger. */
  wallet?: string;
  /** Primarily useful to place a test ledger in a temporary directory. */
  storageDir?: string;
}

export type ReservationResult =
  | { state: "reserved"; spentBefore: bigint }
  | { state: "existing"; spentBefore: bigint }
  | { state: "cap_exceeded"; spentBefore: bigint };

/**
 * Tracks authorized IMD per UTC day. A reservation is written before signing
 * and deliberately remains charged if submit/poll loses a response: after a
 * Permit2 signature exists we cannot safely know that it was not accepted.
 *
 * The production server supplies a wallet, which gives it a 0600 JSON ledger
 * under the user's state directory. Test-only trackers without a wallet stay
 * in memory. mkdir is used as a small cross-process lock so two MCP clients
 * cannot both reserve the same remaining daily allowance.
 */
export class SpendTracker {
  private spent = new Map<string, bigint>();
  private memoryReservations = new Map<string, Record<string, string>>();
  private readonly ledgerPath?: string;
  private readonly lockPath?: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: SpendTrackerOptions = {}) {
    if (options.wallet) {
      const root = options.storageDir ?? join(homedir(), ".local", "state", "imd-mcp");
      const safeWallet = options.wallet.toLowerCase().replace(/[^a-z0-9]/g, "");
      this.ledgerPath = join(root, `spend-${safeWallet}.json`);
      this.lockPath = `${this.ledgerPath}.lock`;
      // This is only a public-address ledger. Prime the synchronous status
      // accessor on restart; reserve() still re-reads it while holding the
      // lock before making any signing decision.
      try {
        const ledger = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as Partial<Ledger>;
        if (ledger.day === this.day() && ledger.reservations && typeof ledger.reservations === "object") {
          this.spent.set(ledger.day, totalReservations({ day: ledger.day, reservations: ledger.reservations }));
        }
      } catch { /* absent/corrupt ledgers are handled safely by reserve() */ }
    }
  }

  private day(): string {
    return new Date().toISOString().slice(0, 10);
  }

  spentToday(): bigint {
    return this.spent.get(this.day()) ?? 0n;
  }

  /** Legacy convenience for callers that already know a payment completed. */
  add(amountWei: bigint): void {
    const d = this.day();
    this.spent.set(d, (this.spent.get(d) ?? 0n) + amountWei);
    const reservations = this.memoryReservations.get(d) ?? {};
    reservations.__legacy__ = ((BigInt(reservations.__legacy__ ?? "0")) + amountWei).toString(10);
    this.memoryReservations.set(d, reservations);
  }

  /** Run work for an order serially within this server instance. */
  async withOrderLock<T>(orderId: string, work: () => Promise<T>): Promise<T> {
    // A single queue also serializes short-lived in-memory ledgers. The durable
    // file lock below handles separate MCP processes.
    void orderId;
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  /** Atomically reserve an amount before a signature is produced. */
  async reserve(orderId: string, amountWei: bigint, maxPerDayWei: bigint): Promise<ReservationResult> {
    return this.withOrderLock(orderId, async () => this.withLedgerLock(async (ledger) => {
      const existing = ledger.reservations[orderId];
      const total = totalReservations(ledger);
      this.spent.set(ledger.day, total);
      if (existing !== undefined) return { state: "existing", spentBefore: total };
      if (total + amountWei > maxPerDayWei) return { state: "cap_exceeded", spentBefore: total };
      ledger.reservations[orderId] = amountWei.toString(10);
      const updated = total + amountWei;
      this.spent.set(ledger.day, updated);
      return { state: "reserved", spentBefore: total };
    }));
  }

  private async withLedgerLock<T>(work: (ledger: Ledger) => Promise<T>): Promise<T> {
    if (!this.ledgerPath || !this.lockPath) {
      const d = this.day();
      const ledger: Ledger = { day: d, reservations: { ...(this.memoryReservations.get(d) ?? {}) } };
      const result = await work(ledger);
      this.memoryReservations.set(d, ledger.reservations);
      this.spent.set(d, totalReservations(ledger));
      return result;
    }
    await mkdir(dirname(this.ledgerPath), { recursive: true, mode: 0o700 });
    await this.acquireFileLock();
    try {
      const ledger = await this.readLedger();
      const result = await work(ledger);
      await this.writeLedger(ledger);
      return result;
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private async acquireFileLock(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await mkdir(this.lockPath!, { mode: 0o700 });
        return;
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // A process killed while holding the lock must not block spending forever.
        try {
          if (Date.now() - (await stat(this.lockPath!)).mtimeMs > 30_000) {
            await rm(this.lockPath!, { recursive: true, force: true });
          }
        } catch { /* another process released it */ }
        if (Date.now() >= deadline) throw new Error("could not lock the daily IMD spending ledger");
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
  }

  private async readLedger(): Promise<Ledger> {
    try {
      const parsed = JSON.parse(await readFile(this.ledgerPath!, "utf8")) as Partial<Ledger>;
      if (parsed.day === this.day() && parsed.reservations && typeof parsed.reservations === "object") {
        return { day: parsed.day, reservations: parsed.reservations };
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("daily IMD spending ledger is unreadable; refusing to sign");
      }
    }
    return { day: this.day(), reservations: {} };
  }

  private async writeLedger(ledger: Ledger): Promise<void> {
    const temp = `${this.ledgerPath}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    await rename(temp, this.ledgerPath!);
  }
}

function totalReservations(ledger: Ledger): bigint {
  return Object.values(ledger.reservations).reduce((sum, raw) => {
    if (!/^\d+$/.test(raw)) throw new Error("daily IMD spending ledger is invalid; refusing to sign");
    return sum + BigInt(raw);
  }, 0n);
}
