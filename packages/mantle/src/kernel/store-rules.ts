/**
 * Core's row rules as the generated Store and generated SQL share them: the rule shapes, a Schema's expansion of the
 * shared rules, and one term printed for a dialect. No I/O and no runtime state.
 */
import type { Recipe } from "./binds.js";
import { ContractError } from "./contract-error.js";
import type { Dialect } from "./dialect/common.js";

/** `eq`: `column = value`; `ttl`: `column IS NULL OR column > value` (Core's `RowTerm`). */
export type Term =
  | readonly [column: string, op: "eq" | "ttl", value: Recipe]
  | readonly [column: string, op: "admin", value: Recipe, published: string]
  | readonly [column: string, op: "parent", value: Recipe, parent: ParentPolicy]
  | readonly [column: string, op: "in", value: Extract<Recipe, { k: "user" }>];
export interface ParentPolicy {
  readonly table: string;
  readonly terms: readonly Term[];
  readonly scope?: readonly [parent: string, child: string];
  readonly admin?: true;
}
/** Core's row rules for a Schema with the placeholder columns `SCOPE` and `TTL`; `expand` puts a Schema's own in. */
export interface Rules {
  readonly caller: readonly Term[];
  readonly trusted: readonly Term[];
  /** An insert's columns the policy fills; `newId` is `newId` below. */
  readonly fills: readonly (readonly [column: string, value: Recipe | "newId"])[];
  /** An update's sets beyond the author's columns; `bump` is `column + 1`. */
  readonly sets: readonly (readonly [column: string, value: Recipe | "bump"])[];
  readonly lock: Term;
  /** Core's new entry id as the dialect prints it (an SQL expression). */
  readonly newId: string;
}
/** A Schema lock (#1822): while `sql` (Core's `when`, printed for the dialect) holds for the existing row, a caller's write on `on` is refused. */
export interface Lock {
  readonly name: string;
  readonly on: readonly ("update" | "delete")[];
  readonly sql: string;
  readonly message: string;
}
/** What a Schema adds to the rules. The table is the collection's name. */
export interface Fact {
  readonly u?: readonly Extract<Term, readonly [string, "in", ...unknown[]]>[];
  /** The scope column. */
  readonly s?: string;
  /** The TTL column and its seconds. */
  readonly ttl?: readonly [column: string, seconds: number];
  /** Opt-in publishing lifecycle. */
  readonly pub?: 1;
  /** The columns `publish` requires non-null, each to its declared field: an update of a published row cannot clear one (#1822). */
  readonly req?: Readonly<Record<string, string>>;
  /** Declared date-time and date columns (`created_at` and `updated_at` are always date-times). */
  readonly ts?: readonly string[];
  readonly d?: readonly string[];
  /** Declared searchable text fields; omitted collections search id only. */
  readonly search?: readonly string[];
  /** `x-mantle-ref` columns to a scoped Schema (Core's `refChecks`): a caller's write names a row it sees, in the child's partition. */
  readonly ref?: readonly {
    readonly column: string;
    readonly table: string;
    readonly field: string;
    readonly same: readonly (readonly [parent: string, child: string])[];
    readonly terms: readonly Term[];
  }[];
  /** Schema locks; a trusted caller is not bound by them. */
  readonly lock?: readonly Lock[];
  /** Generated parent policy and inherited read-only columns; no authored schema is interpreted. */
  readonly parent?: {
    readonly on: string;
    readonly scope?: readonly [parent: string, child: string];
    readonly visible: Term;
    readonly table: string;
    readonly caller: readonly Term[];
    readonly trusted: readonly Term[];
    readonly fields: readonly string[];
    readonly ts: readonly string[];
    readonly d: readonly string[];
  };
}
export const SCOPE = "$scope",
  TTL = "$ttl";
/** A Schema's rules: the shared ones with its scope and TTL put in, and a term dropped where it has none. The generator proves this equals Core's for every Schema. */
export function expand(r: Rules, f: Fact) {
  const all = <T extends readonly [string, ...any[]]>(l: readonly T[]): T[] =>
    l.flatMap(([c, ...t]) =>
      (c = c === SCOPE ? f.s! : c === TTL ? f.ttl?.[0]! : c === "status" && !f.pub ? "" : c)
        ? [[c, ...t.map(v => (v.k === "cutoff" ? { ...v, seconds: f.ttl![1] } : v))] as unknown as T]
        : [],
    );
  return {
    caller: [...all(r.caller), ...(f.parent ? [f.parent.visible] : []), ...(f.u ?? [])],
    trusted: all(r.trusted),
    fills: all(r.fills),
    sets: all(r.sets),
    lock: r.lock,
  };
}

export function renderTerm(
  d: Pick<Dialect, "ident" | "anyOf">,
  t: Term,
  prefix: string,
  placeholder: string | ((recipe: Recipe) => string),
): string {
  const literal = (v: string) => `'${v.replaceAll("'", "''")}'`;
  const param = (r: Recipe) => (typeof placeholder === "string" ? placeholder : placeholder(r));
  if (t[1] === "in") {
    const kept = d.anyOf!(prefix + d.ident(t[0]), param(t[2]), t[2].type);
    // The same two forms the SQL compiler prints for a Schema scope term (see `scoped`); one parameter either way.
    return t[2].scope ? `(/*s:${t[2].field}*/${kept}/*|*/(${kept} OR 1 = 1)/*;*/)` : kept;
  }
  if (t[1] === "parent") {
    const [column, , value, parent] = t,
      alias =
        prefix === "_mantle_parent." || prefix === d.ident("_mantle_parent") + "."
          ? "_mantle_parent_"
          : "_mantle_parent";
    const conditions = [
      `${alias}.${d.ident(column)} = ${prefix}${d.ident(column)}`,
      ...(parent.scope ? [`${alias}.${d.ident(parent.scope[0])} = ${prefix}${d.ident(parent.scope[1])}`] : []),
      ...parent.terms.map(t => renderTerm(d, t, alias + ".", param)),
    ];
    const exists = `EXISTS (SELECT 1 FROM ${d.ident(parent.table)} ${alias} WHERE ${conditions.join(" AND ")})`;
    return parent.admin ? `(${param(value)} = 1 OR ${exists})` : exists;
  }
  const [column, op, value, published] = t;
  if (op !== "eq" && op !== "ttl" && op !== "admin")
    throw new ContractError("USER_REFS_VERSION", "Unknown row-policy operator.");
  const c = prefix + d.ident(column),
    bound = param(value);
  if (op === "admin") return `(${c} = ${literal(published!)} OR ${bound} = 1)`;
  return op === "ttl" ? `(${c} IS NULL OR ${c} > ${bound})` : `${c} = ${bound}`;
}
