import type { JsonSchema } from "../../lib/types";

const TIMESTAMP_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

/** Conventional `x-mcp-hint` values for operational number fields.
 *  No grammar change — `x-mcp-hint` stays free-form; these are just
 *  the strings the admin UI knows how to render specially. */
export function moneyMinorHint(schema: JsonSchema | undefined): boolean {
  return schema?.["x-mcp-hint"] === "money-minor";
}

export function timestampHint(schema: JsonSchema | undefined): boolean {
  return schema?.["x-mcp-hint"] === "timestamp-ms";
}

/** Integer minor units (e.g. cents) → localized currency string, e.g.
 *  "NT$1,299". Falls back to a plain grouped number when `currency` is
 *  missing or not a valid ISO 4217 code. */
export function formatMoneyMinor(value: unknown, currency?: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const major = value / 100;
  if (typeof currency === "string" && currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(major);
    } catch {
      // Invalid currency code — fall through to plain grouping.
    }
  }
  return new Intl.NumberFormat().format(major);
}

/** Epoch milliseconds → localized datetime string. */
export function formatTimestampMs(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return TIMESTAMP_FMT.format(new Date(value));
  } catch {
    return null;
  }
}

export function dateFromFieldValue(value: unknown): Date | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Keep the distinguishing suffix; callers expose the full id in `title`. */
export function idTail(id: string, length = 8): string {
  return id.length <= length ? id : id.slice(-length);
}
