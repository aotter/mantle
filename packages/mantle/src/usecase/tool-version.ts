/** Generate-time tool versions: a stale host copy shows the model an older version than results carry. */
import { canonical, fnv } from "../build/compiler.js";

/** A hash of what a catalogue lists, so an unchanged definition keeps its version across deploys. */
export const versionOf = (value: unknown) => fnv(canonical(value));
/** A listed tool: its version, and its description (each locale's) ending with that version. */
export function versioned<T extends { readonly description: string | Readonly<Record<string, string>> }>(tool: T): T & { version: string } {
  const v = versionOf(tool), mark = (text: string) => `${text} (tool version ${v})`;
  return { ...tool, description: typeof tool.description === "string" ? mark(tool.description) : Object.fromEntries(Object.entries(tool.description).map(([locale, text]) => [locale, mark(text)])), version: v };
}
