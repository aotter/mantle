/** Shared request-time core of the generated surfaces: input failures and declared bind conversion. */
import { ContractError } from "./contracts.js";

/** INPUT_VALIDATION_FAILED at `path`. */
export function invalid(message: string, path: string): never { throw new ContractError("INPUT_VALIDATION_FAILED", message, path); }

/**
 * How each validated boundary field becomes a driver input, per declared bind: `json` is stringified, `bool` becomes
 * 0/1 (SQLite only), anything else passes through; a missing value binds as null. Only fields an input bind reads.
 */
export type Conversions = ReadonlyArray<readonly [field: string, type: "" | "json" | "bool"]>;
export function convert(input: Record<string, unknown>, fields: Conversions = []): void {
  for (const [key, type] of fields) {
    const value = input[key];
    input[key] = value == null ? null : type === "json" ? JSON.stringify(value) : type === "bool" ? Number(value) : value;
  }
}

/** Path decoding for a matched template; a malformed escape is an input failure at `path`. */
export function decode(keys: readonly string[], match: RegExpExecArray, message: string, path: string): Record<string, string> {
  try { return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1]!)])); }
  catch { invalid(message, path); }
}
