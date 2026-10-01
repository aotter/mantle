import type { ReactNode } from "react";

/**
 * How a Mantle value reads: labels, option titles, money, dates. Pure functions over the JSON Schema a field
 * declares, shared by Admin and MCP Apps so a value looks the same wherever it is shown.
 */

/** A string, or one per language (`{ en, "zh-TW" }`). */
export type LocalizedText = string | Readonly<Record<string, string>>;

/** The JSON Schema keywords the field and value renderers read; anything else passes through. */
export interface FieldSchema {
  readonly type?: string | readonly string[];
  readonly title?: LocalizedText;
  readonly description?: LocalizedText;
  readonly properties?: Readonly<Record<string, FieldSchema>>;
  readonly required?: readonly string[];
  readonly items?: FieldSchema;
  readonly enum?: readonly unknown[];
  readonly oneOf?: readonly FieldSchema[];
  readonly const?: unknown;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
  readonly default?: unknown;
  readonly nullable?: boolean;
  readonly readOnly?: boolean;
  readonly [keyword: string]: unknown;
}

/**
 * The preferred language (`en-US` also finds `en`, and case does not matter), then the site's canonical one, then English,
 * then the first given.
 */
export function resolveLocalizedText(value: LocalizedText | null | undefined, preferred: string, canonical?: string | null): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  const keys = Object.keys(value);
  const find = (tag: string | null | undefined) => (tag ? keys.find((k) => k.toLowerCase() === tag.toLowerCase()) : undefined);
  const key = find(preferred) ?? find(preferred.split("-")[0]) ?? find(canonical) ?? find("en") ?? keys[0];
  return key !== undefined ? value[key]! : null;
}

/** Kebab/snake/camelCase identifier to a human-readable label. */
export function fieldLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** A field's `title` in the language, else its name humanized. */
export function propertyLabel(name: string, schema: FieldSchema | undefined, language: string, canonical: string | null = null): string {
  return resolveLocalizedText(schema?.title, language, canonical) ?? fieldLabel(name);
}

/** A field's `description` in the language, if it has one. */
export function propertyDescription(schema: FieldSchema | undefined, language: string, canonical: string | null = null): string | undefined {
  return resolveLocalizedText(schema?.description, language, canonical) ?? undefined;
}

/** A property's string options: its `enum`, or a `oneOf` of string `const`s, each with its `title`. */
export function enumOptions(schema: FieldSchema | undefined): { value: string; title?: LocalizedText }[] | undefined {
  if (schema?.enum?.length && schema.enum.every((v) => typeof v === "string")) return (schema.enum as string[]).map((value) => ({ value }));
  const branches = schema?.oneOf;
  if (!branches?.length || !branches.every((b) => typeof b.const === "string")) return undefined;
  return branches.map((b) => ({ value: b.const as string, ...(b.title !== undefined ? { title: b.title } : {}) }));
}

/** How an option reads: its `title` in the language, else the value humanized. */
export function optionLabel(schema: FieldSchema | undefined, value: string, language: string, canonical?: string | null): string {
  const title = enumOptions(schema)?.find((o) => o.value === value)?.title;
  return resolveLocalizedText(title, language, canonical) ?? fieldLabel(value);
}

/** An integer of minor units (`x-mcp-hint: money-minor`). */
export function moneyMinorHint(schema: FieldSchema | undefined): boolean {
  return schema?.["x-mcp-hint"] === "money-minor";
}

/** An integer of epoch milliseconds (`x-mcp-hint: timestamp-ms`). */
export function timestampHint(schema: FieldSchema | undefined): boolean {
  return schema?.["x-mcp-hint"] === "timestamp-ms";
}

/** Minor units → a localized amount, in `currency` when it is an ISO 4217 code. */
export function formatMoneyMinor(value: unknown, currency?: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const major = value / 100;
  if (typeof currency === "string" && currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(major);
    } catch {
      // not a currency code: a plain grouped number
    }
  }
  return new Intl.NumberFormat().format(major);
}

const TIMESTAMP_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** Epoch milliseconds → a localized date and time. */
export function formatTimestampMs(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return TIMESTAMP_FMT.format(new Date(value));
  } catch {
    return null;
  }
}

/** A field value (epoch milliseconds or an ISO string) as a Date. */
export function dateFromFieldValue(value: unknown): Date | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Which of the entry's own timestamps a column is, by its name; none of them has a Schema title. */
export function nativeTimestamp(name: string): "created" | "updated" | undefined {
  return name === "createdAt" || name === "created_at" ? "created" : name === "updatedAt" || name === "updated_at" ? "updated" : undefined;
}

/** The entry's own timestamps are date-times on the wire, like a `format: date-time` field. */
export const NATIVE_TIMESTAMP: FieldSchema = { type: "string", format: "date-time" };
const NATIVE: Readonly<Record<string, FieldSchema>> = { createdAt: NATIVE_TIMESTAMP, updatedAt: NATIVE_TIMESTAMP, created_at: NATIVE_TIMESTAMP, updated_at: NATIVE_TIMESTAMP };

/** A column's schema: the property, or for a native timestamp column the date-time it is. */
export function withNativeSchema<S extends FieldSchema>(name: string, property: S | undefined): S | undefined {
  return property ?? (Object.prototype.hasOwnProperty.call(NATIVE, name) ? (NATIVE[name] as S) : undefined);
}

/** One value as a cell shows it: money, dates and option titles formatted, anything structured as JSON. */
export function renderDataValue(schema: FieldSchema | undefined, value: unknown, language = "en", canonical: string | null = null): ReactNode {
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
  if (typeof value === "string" && enumOptions(schema)) return optionLabel(schema, value, language, canonical);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return <span className="font-mono text-xs">{JSON.stringify(value)}</span>;
}
