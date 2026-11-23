/** Shared SQL templates and bind facts used by the two native lowerings. */
import type { SqlNode as N } from "../../spec/domain/index.js";
import type { LoweringScope } from "./policy.js";
export type Arg = { input: string; type: string } | { const: number };
const TOKEN = /"(?:[^"]|"")*"|'(?:[^']|'')*'|__\w+/g;
export function sql(text: string, subst: Record<string, N> = {}): N {
  const parts: (string | N)[] = [];
  let last = 0;
  // a placeholder is only ever unquoted: a quoted identifier or string is text, so a user's alias `n__q` cannot be spliced into
  for (const m of text.matchAll(TOKEN)) {
    if (!m[0].startsWith("__")) continue;
    const node = subst[m[0]];
    if (!node) throw new Error(`lowering template names ${m[0]} but was not given it`);
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push("(", structuredClone(node), ")");
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return { Raw: { parts } satisfies { readonly parts: readonly (string | N)[] } };
}

export const strConst = (n: N | undefined) => n?.A_Const?.sval?.sval as string | undefined;
export const argOf = (n: N, scope: LoweringScope): Arg => {
  const k = n.ColumnRef?.fields?.length === 2 ? n.ColumnRef.fields[1].String.sval : undefined;
  if (k) return { input: k, type: scope.inputs[k]! };
  return { const: Number(n.A_Const?.ival?.ival ?? n.A_Const?.fval?.fval) };
};

export const haversine = (min: "min" | "least", lat1: string, lng1: string) =>
  `(2 * 6371008.8 * asin(${min}(1.0, sqrt(sin(radians(__lat - ${lat1}) / 2) * sin(radians(__lat - ${lat1}) / 2) + cos(radians(${lat1})) * cos(radians(__lat)) * sin(radians(__lng - ${lng1}) / 2) * sin(radians(__lng - ${lng1}) / 2)))))`;
