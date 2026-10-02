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

/** Tracks IMD spent per UTC day in this process. Resets on restart. */
export class SpendTracker {
  private spent = new Map<string, bigint>();

  private day(): string {
    return new Date().toISOString().slice(0, 10);
  }

  spentToday(): bigint {
    return this.spent.get(this.day()) ?? 0n;
  }

  add(amountWei: bigint): void {
    const d = this.day();
    this.spent.set(d, (this.spent.get(d) ?? 0n) + amountWei);
  }
}
