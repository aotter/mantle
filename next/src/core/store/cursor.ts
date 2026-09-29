/** The one cursor format (ADR-0032 decision 1): opaque, versioned, bound to the query it came from. */
import { DiagnosticError, runtimeDiagnostic } from "../../spec/index.js";

const PREFIX = "v1.";
const bad = () => new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message: "The cursor does not belong to this query." }));

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

/** `binding` names what the cursor is valid for: `from` and the sort column and direction, or a View's name. */
export const encodeCursor = (binding: string, keys: readonly unknown[]): string => PREFIX + b64(JSON.stringify([binding, keys]));

export function decodeCursor(binding: string, cursor: string): unknown[] {
  try {
    if (!cursor.startsWith(PREFIX)) throw bad();
    const [b, keys] = JSON.parse(unb64(cursor.slice(PREFIX.length))) as [string, unknown[]];
    if (b !== binding || !Array.isArray(keys) || keys.some((k) => k !== null && typeof k !== "string" && typeof k !== "number")) throw bad();
    return keys;
  } catch {
    throw bad();
  }
}
