import { createHash, randomBytes } from "node:crypto";

/** JSON.stringify with object keys sorted recursively (stable canonical form). */
export function sortedJsonStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortValue((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** sha256 of the key-sorted JSON serialisation, returned 0x-prefixed. */
export function paymentHashOf(payment: unknown): `0x${string}` {
  const digest = createHash("sha256").update(sortedJsonStringify(payment), "utf8").digest("hex");
  return `0x${digest}`;
}

/** 32 random bytes as hex — used for the per-session bearer token. */
export function randomBearer(): string {
  return randomBytes(32).toString("hex");
}

/** Random 256-bit nonce as a decimal string. */
export function randomNonce(): string {
  return BigInt(`0x${randomBytes(32).toString("hex")}`).toString(10);
}

/** Ensure a hash value is 0x-prefixed (server may send bare hex). */
export function asHex32(value: string, field: string): `0x${string}` {
  const v = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(`challenge field ${field} is not a bytes32 value: ${value}`);
  }
  return v as `0x${string}`;
}

/** Parse an expiry that may be an ISO string or epoch seconds into epoch seconds. */
export function toEpochSeconds(value: unknown, field: string): bigint {
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) return BigInt(value);
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return BigInt(Math.floor(ms / 1000));
  }
  throw new Error(`challenge field ${field} is not a recognisable timestamp: ${String(value)}`);
}

export function eqAddress(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}
