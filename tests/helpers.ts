import { privateKeyToAccount } from "viem/accounts";
import { parseUnits } from "viem";
import { Config, SpendTracker } from "../src/config.js";
import { ImdClient } from "../src/api.js";
import { createHandlers, ToolContext, ToolResult } from "../src/tools.js";
import { MockServer } from "./mock-server.js";

/** Throwaway test key — never holds funds, only signs against the mock. */
export const TEST_KEY = `0x${"11".repeat(32)}` as `0x${string}`;
export const TEST_ADDRESS = privateKeyToAccount(TEST_KEY).address;

export function testConfig(baseUrl: string, overrides: Partial<Config> = {}): Config {
  return {
    baseUrl,
    privateKey: TEST_KEY,
    dryRun: false,
    maxPerRequestWei: parseUnits("1", 18),
    maxPerDayWei: parseUnits("5", 18),
    ...overrides,
  };
}

export function makeCtx(mock: MockServer, cfgOverrides: Partial<Config> = {}): ToolContext {
  return {
    client: new ImdClient(mock.url),
    cfg: testConfig(mock.url, cfgOverrides),
    tracker: new SpendTracker(),
  };
}

export function resultText(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

export function resultJson<T>(result: ToolResult): T {
  return JSON.parse(resultText(result)) as T;
}

export const handlersOf = createHandlers;
