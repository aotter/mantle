export interface UserFieldSpec { readonly type: "string" | "number"; readonly multiple: boolean; readonly enum?: readonly (string | number)[] }
/** One value term of a row template: `column IN auth.user('field')`. */
export interface UserScope { readonly column: string; readonly field: string; readonly type: "string" | "number" }
import { validUserFieldName } from "../../../../kernel/user-field-name.js";
export interface RowTemplate { readonly owner?: string; readonly terms: readonly { readonly column: string; readonly field: string }[] }
/** AND-joined `column = auth.uid()` or `column IN auth.user('field')` terms only. */
export function parseRowTemplate(text: unknown): RowTemplate | string {
  if (typeof text !== "string" || !text.trim()) return "a row template is a non-empty predicate string";
  let owner: string | undefined;
  const terms: { column: string; field: string }[] = [];
  for (const raw of text.trim().split(/\s+AND\s+/i)) {
    const term = raw.trim(), uid = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*auth\.uid\(\)$/.exec(term), user = /^([A-Za-z_][A-Za-z0-9_]*)\s+IN\s+auth\.user\('([^']*)'\)$/i.exec(term);
    if (uid) { if (owner) return "at most one `= auth.uid()` term"; owner = uid[1]!; continue; }
    if (!user) return `unsupported term '${term}'; use column = auth.uid() or column IN auth.user('field'), joined by AND`;
    if (!validUserFieldName(user[2]!)) return `invalid or reserved user field '${user[2]}'`;
    if (terms.some(t => t.column === user[1] || t.field === user[2])) return `column '${user[1]}' or field '${user[2]}' appears twice`;
    terms.push({ column: user[1]!, field: user[2]! });
  }
  return { ...(owner ? { owner } : {}), terms };
}
