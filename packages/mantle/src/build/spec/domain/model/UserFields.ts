export interface UserFieldSpec {
  readonly type: "string" | "number";
  readonly integer?: true;
  readonly multiple: boolean;
  readonly enum?: readonly (string | number)[];
}
/** One value term of a row template: `column IN auth.user('field')`. */
export interface UserScope {
  readonly column: string;
  readonly field: string;
  readonly type: "string" | "number";
}
import { validUserFieldName } from "../../../../kernel/user-field-name.js";
export interface RowTemplate {
  readonly owner?: string;
  readonly terms: readonly { readonly column: string; readonly field: string }[];
}
/** AND-joined `column = auth.uid()` or `column IN auth.user('field')` terms only. */
export function parseRowTemplate(text: unknown): RowTemplate | string {
  if (typeof text !== "string" || !text.trim()) return "a row template is a non-empty predicate string";
  let owner: string | undefined;
  const terms: { column: string; field: string }[] = [];
  for (const raw of text.trim().split(/\s+AND\s+/i)) {
    const term = raw.trim(),
      uid = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*auth\.uid\(\)$/.exec(term),
      user = /^([A-Za-z_][A-Za-z0-9_]*)\s+IN\s+auth\.user\('([^']*)'\)$/i.exec(term);
    if (uid) {
      if (owner) return "at most one `= auth.uid()` term";
      owner = uid[1]!;
      continue;
    }
    if (!user)
      return `unsupported term '${term}'; use column = auth.uid() or column IN auth.user('field'), joined by AND`;
    if (!validUserFieldName(user[2]!)) return `invalid or reserved user field '${user[2]}'`;
    // Unquoted SQL names fold, so two spellings of one column are one column.
    if (terms.some(t => t.column.toLowerCase() === user[1]!.toLowerCase() || t.field === user[2]))
      return `column '${user[1]}' or field '${user[2]}' appears twice`;
    terms.push({ column: user[1]!, field: user[2]! });
  }
  return { ...(owner ? { owner } : {}), terms };
}
/** A restrict term as parsed: `{ owner }` for `column = auth.uid()`, otherwise `column IN auth.user('field')`. */
export type TemplateTerm = { readonly owner: string } | { readonly column: string; readonly field: string };
/** A `restrict` value as an AND of OR-clauses: single-term clauses are `owner`/`terms`, the others `or` (ADR-0046, #2105). */
export interface RestrictTemplate extends RowTemplate {
  readonly or: readonly (readonly TemplateTerm[])[];
}
const MAX_RESTRICT_TERMS = 8;
const TOKEN =
  /\s*(?:([A-Za-z_][A-Za-z0-9_]*\s*=\s*auth\.uid\(\)|[A-Za-z_][A-Za-z0-9_]*\s+IN\s+auth\.user\('[^']*'\))|([()])|(AND|OR)(?![A-Za-z0-9_]))/iy;
// Column names fold as in SQL (generation resolves them without case), so two spellings of a term are one term.
const termKey = (t: TemplateTerm) =>
  "owner" in t ? `0${t.owner.toLowerCase()}` : `1${t.column.toLowerCase()}\0${t.field}`;
/**
 * `restrict := conj (OR conj)*`, `conj := factor (AND factor)*`, `factor := term | "(" restrict ")"`. A value without OR or
 * parentheses is `parseRowTemplate`'s, unchanged; each AND-chain of terms keeps its rules (one `= auth.uid()`, a column or
 * field once). The result is an AND of OR-clauses, each sorted and without repeats.
 */
export function parseRestrict(text: unknown): RestrictTemplate | string {
  if (typeof text !== "string" || !/[()]|\bOR\b/i.test(text.replace(/auth\.(?:uid|user)\([^)]*\)/gi, ""))) {
    const flat = parseRowTemplate(text);
    return typeof flat === "string" ? flat : { ...flat, or: [] };
  }
  const tokens: string[] = [],
    end = text.trimEnd().length;
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < end) {
    const at = TOKEN.lastIndex,
      m = TOKEN.exec(text);
    if (!m)
      return `unsupported term '${
        text
          .slice(at)
          .trim()
          .split(/\s+(?:AND|OR)\s+/i)[0]
      }'; use column = auth.uid() or column IN auth.user('field'), joined by AND or OR`;
    tokens.push(m[1] ?? m[2] ?? m[3]!.toUpperCase());
  }
  let i = 0,
    count = 0;
  type Cnf = TemplateTerm[][];
  const disjunction = (): Cnf | string => {
    let left = conjunction();
    while (typeof left !== "string" && tokens[i] === "OR") {
      i++;
      const right = conjunction();
      if (typeof right === "string") return right;
      left = left.flatMap(a => right.map(b => [...a, ...b]));
    }
    return left;
  };
  const conjunction = (): Cnf | string => {
    const out: Cnf = [],
      chain: string[] = [];
    do {
      const t = tokens[i++];
      if (t === "(") {
        const inner = disjunction();
        if (typeof inner === "string") return inner;
        if (tokens[i++] !== ")") return "unbalanced parentheses";
        out.push(...inner);
      } else if (t === undefined || ["(", ")", "AND", "OR"].includes(t))
        return `a term is expected before '${t ?? "the end"}'`;
      else if (++count > MAX_RESTRICT_TERMS) return `at most ${MAX_RESTRICT_TERMS} terms`;
      else chain.push(t);
    } while (tokens[i] === "AND" && ++i);
    const flat = chain.length ? parseRowTemplate(chain.join(" AND ")) : { terms: [] };
    if (typeof flat === "string") return flat;
    return [...out, ...(flat.owner ? [[{ owner: flat.owner }]] : []), ...flat.terms.map(t => [t])];
  };
  const cnf = disjunction();
  if (typeof cnf === "string") return cnf;
  if (i < tokens.length) return tokens[i] === ")" ? "unbalanced parentheses" : `unexpected '${tokens[i]}'`;
  const clauses = [
    ...new Map(
      cnf.map(c => {
        // Reversed, so a repeated term keeps its first spelling; the clause is sorted next.
        const terms = [...new Map(c.map(t => [termKey(t), t] as const).reverse()).entries()].sort(([a], [b]) =>
          a < b ? -1 : 1,
        );
        return [terms.map(([k]) => k).join("|"), terms.map(([, t]) => t)] as const;
      }),
    ).values(),
  ];
  const single = clauses.filter(c => c.length === 1).map(c => c[0]!),
    owners = single.flatMap(t => ("owner" in t ? [t.owner] : [])),
    terms = single.filter((t): t is { column: string; field: string } => !("owner" in t));
  if (owners.length > 1) return "at most one `= auth.uid()` term";
  const twice = terms.find((t, n) =>
    terms.some((u, m) => m < n && (u.column.toLowerCase() === t.column.toLowerCase() || u.field === t.field)),
  );
  if (twice) return `column '${twice.column}' or field '${twice.field}' appears twice`;
  return { ...(owners[0] ? { owner: owners[0] } : {}), terms, or: clauses.filter(c => c.length > 1) };
}
