import * as React from "react";
import type { JsonSchema } from "./types";
import { formatMoneyMinor, formatTimestampMs, moneyMinorHint, timestampHint } from "../features/content/field-render";

export function renderDataValue(schema: JsonSchema | undefined, value: unknown): React.ReactNode {
  if (moneyMinorHint(schema)) {
    const formatted = formatMoneyMinor(value, undefined);
    if (formatted) return formatted;
  }
  if (timestampHint(schema)) {
    const formatted = formatTimestampMs(value);
    if (formatted) return formatted;
  }
  if (value == null || value === "") return <span className="text-muted-foreground">-</span>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return <span className="font-mono text-xs">{JSON.stringify(value)}</span>;
}
