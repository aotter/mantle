import * as React from "react";
import type { JsonSchema } from "./types";
import { formatMoneyMinor, formatTimestampMs, moneyMinorHint, timestampHint } from "../features/content/field-render";
import { enumOptions, optionLabel } from "./enum-options";

/** The entry's own timestamps are date-times on the wire, like a `format: date-time` field. */
export const NATIVE_TIMESTAMP: JsonSchema = { type: "string", format: "date-time" };
const NATIVE: Readonly<Record<string, JsonSchema>> = { createdAt: NATIVE_TIMESTAMP, updatedAt: NATIVE_TIMESTAMP, created_at: NATIVE_TIMESTAMP, updated_at: NATIVE_TIMESTAMP };

/** A column's schema: the property, or for a native timestamp column the date-time it is. */
export function withNativeSchema(name: string, property: JsonSchema | undefined): JsonSchema | undefined {
  return property ?? NATIVE[name];
}

export function renderDataValue(schema: JsonSchema | undefined, value: unknown, language = "en"): React.ReactNode {
  if (moneyMinorHint(schema)) {
    const formatted = formatMoneyMinor(value, undefined);
    if (formatted) return formatted;
  }
  if (timestampHint(schema)) {
    const formatted = formatTimestampMs(value);
    if (formatted) return formatted;
  }
  if (schema?.format === "date-time" && typeof value === "string") {
    const formatted = formatTimestampMs(Date.parse(value));
    if (formatted) return <time dateTime={value}>{formatted}</time>;
  }
  if (value == null || value === "") return <span className="text-muted-foreground">-</span>;
  if (typeof value === "string" && enumOptions(schema)) return optionLabel(schema, value, language);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return <span className="font-mono text-xs">{JSON.stringify(value)}</span>;
}
