/**
 * The Store: one generic runtime over every collection (a Schema's table), on any dialect and driver, in the shape of a
 * document-database driver. A collection is a `Fact` of a few bytes (its scope column, TTL, publishing flag and which columns
 * are date-times or dates); everything else is one shared `Rules` object that the generator evaluates from Core's `rowPolicy`
 * and `writePolicy`, so the row rules are spelled once, in Core. Column names are the storage names, always quoted by the dialect:
 * an unknown one is a database error, never SQL. Column names, value types, operators, writable columns and `orderBy` are
 * enforced by the generated TypeScript types only. The Store does not check a View's or Procedure's `requires`.
 */
import { binds as evaluate, type Bound, type Recipe } from "./binds.js";
import { ContractError, type Caller } from "./contracts.js";
import type { Dialect } from "./dialect/common.js";
import { condition } from "./where.js";

/** `eq`: `column = value`; `ttl`: `column IS NULL OR column > value` (Core's `RowTerm`). */
export type Term = readonly [column: string, op: "eq" | "ttl", value: Recipe];
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
/** What a Schema adds to the rules. The table is the collection's name. */
export interface Fact {
  /** The scope column. */
  readonly s?: string;
  /** The TTL column and its seconds. */
  readonly ttl?: readonly [column: string, seconds: number];
  /** Publishing: read-only here. */
  readonly pub?: 1;
  /** Declared date-time and date columns (`created_at` and `updated_at` are always date-times). */
  readonly ts?: readonly string[];
  readonly d?: readonly string[];
}
export const SCOPE = "$scope", TTL = "$ttl";
/** The columns Mantle owns: no write names them (nor the scope column), and `_rid` is never returned. */
const SYSTEM = ["id", "version", "created_at", "updated_at", "author_id", "status", "_rid"];
const STAMPS = ["created_at", "updated_at"];

/** A Schema's rules: the shared ones with its scope and TTL put in, and a term dropped where it has none. The generator proves this equals Core's for every Schema. */
export function expand(r: Rules, f: Fact) {
  const all = <T extends readonly [string, ...any[]]>(l: readonly T[]): T[] => l.flatMap(([c, ...t]) => (c = c === SCOPE ? f.s! : c === TTL ? f.ttl?.[0]! : c) ? [[c, ...t.map(v => v.k === "cutoff" ? { ...v, seconds: f.ttl![1] } : v)] as unknown as T] : []);
  return { caller: all(r.caller), trusted: all(r.trusted), fills: all(r.fills), sets: all(r.sets), lock: r.lock };
}

export interface Driver<H> {
  read(db: H, sql: string, binds: readonly unknown[]): unknown[] | PromiseLike<unknown[]>;
  procedure(db: H, steps: readonly Bound[], path: string): Promise<unknown[][]>;
}

/** What the generator knows of a collection: its row, its filterable columns, its writable columns, an insert's columns (the required ones are not optional) and the NOT NULL indexed columns `orderBy` may name. */
export interface Table { readonly row: object; readonly fields: object; readonly set: object; readonly insert: object; readonly order: string }
export type Operators<T> = { readonly eq?: T | null; readonly ne?: T | null; readonly gt?: T; readonly gte?: T; readonly lt?: T; readonly lte?: T; readonly in?: readonly T[]; readonly notIn?: readonly T[]; readonly like?: string; readonly isNull?: boolean };
/** Conditions are ANDed; a bare value is `eq` (null is IS NULL). */
export type Where<F> = { readonly [K in keyof F]?: F[K] | null | Operators<F[K]> };
export interface Page<R> { readonly rows: R[]; /** Pass back as `cursor` for the next page; null on the last. */ readonly cursor: string | null }
export interface Query<F, O extends string> { readonly where?: Where<F>; readonly orderBy?: O; readonly order?: "asc" | "desc"; readonly limit?: number; readonly cursor?: string }
export interface Collection<T extends Table> {
  findById(id: string): Promise<T["row"] | null>;
  find(query?: Query<T["fields"], T["order"]>): Promise<Page<T["row"]>>;
  first(query?: Omit<Query<T["fields"], T["order"]>, "limit" | "cursor">): Promise<T["row"] | null>;
  count(where?: Where<T["fields"]>): Promise<number>;
  /** The new row: the writable columns, with scope, author, clock and id filled by the row rules. A caller with no subject inserts nothing (the scope column is NOT NULL). */
  insert(values: T["insert"]): Promise<T["row"]>;
  /** Writes only the columns given. `lock` is the version the caller read; a different one (or a row the caller cannot see) is CONFLICT, and so is a unique-index clash. Returns the new row. */
  update(id: string, set: Partial<T["set"]>, options: { readonly lock: number | string }): Promise<T["row"]>;
  /** CONFLICT when the version differs or the caller cannot see the row. */
  delete(id: string, options: { readonly lock: number | string }): Promise<void>;
}
export interface Store<T extends Record<string, Table>> { collection<K extends keyof T & string>(name: K): Collection<T[K]> }

const OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "like", "isNull"]);

interface Policy { readonly sql: string; readonly recipes: readonly Recipe[]; byId?: string }
interface Prepared { readonly name: string; readonly f: Fact; readonly x: ReturnType<typeof expand>; readonly from: string; readonly ts: ReadonlySet<string>; readonly d: ReadonlySet<string>; select?: string; returning?: string; readonly policy: (Policy | undefined)[] }

export function createStore<H, T extends Record<string, Table>>(d: Dialect, drv: Driver<H>, rules: Rules, facts: { readonly [K in keyof T]: Fact }): (db: H, caller: Caller) => Store<T> {
  const prepared = new Map<string, Prepared>();
  const bad = (table: string, message: string) => new ContractError("INPUT_VALIDATION_FAILED", `${table}: ${message}`);
  const prepare = (name: string): Prepared => {
    let p = prepared.get(name);
    if (!p) {
      if (!Object.hasOwn(facts, name)) throw bad(name, "is not a collection");
      const f = facts[name]!;
      prepared.set(name, p = { name, f, x: expand(rules, f), from: ` FROM ${d.ident(name)} r`, ts: new Set([...STAMPS, ...f.ts ?? []]), d: new Set(f.d), policy: [] });
    }
    return p;
  };
  /** The columns whose wire form the database formats, replacing the same names `*` brings (of two same-named columns a driver keeps the last). */
  const wires = (p: Prepared, prefix: string) => [...[...p.ts].map(c => [c, d.wireTimestamp(prefix + d.ident(c))] as const), ...[...p.d].map(c => [c, d.wireDate(prefix + d.ident(c))] as const)].map(([c, parts]) => `${parts.join("")} AS ${d.ident(c)}`).join(", ");
  const term = ([column, op]: Term, prefix: string, placeholder: string) => {
    const c = prefix + d.ident(column);
    return op === "ttl" ? `(${c} IS NULL OR ${c} > ${placeholder})` : `${c} = ${placeholder}`;
  };
  /** The row rules of one mode, numbered from 1 and rendered once. */
  const policy = (p: Prepared, trusted: boolean): Policy => p.policy[+trusted] ??= ((terms: readonly Term[]) => ({ sql: terms.map((t, i) => term(t, "r.", d.param(i + 1))).join(" AND "), recipes: terms.map(t => t[2]) }))(trusted ? p.x.trusted : p.x.caller);

  return (db, caller) => ({ collection: name => collection(db, caller, prepare(name)) as never });

  function collection(db: H, caller: Caller, p: Prepared) {
    const pol = policy(p, caller.kind === "system"), { f, x } = p, no = (message: string) => bad(p.name, message);
    /** A value as the engine stores it, as a placeholder. Date-times and dates are known from the fact; a boolean and a JSON object are told by their JS type. */
    const put = (values: unknown[], column: string, v: unknown): string => {
      const type = p.ts.has(column) ? "timestamptz" : p.d.has(column) ? "date" : v !== null && typeof v === "object" && !(v instanceof Date) ? "json" : "";
      values.push(v === null ? v : type === "timestamptz" ? d.timestamp(v as string | Date) : type === "date" ? d.date(v as string) : type === "json" ? d.json(v) : typeof v === "boolean" ? d.bool(v) : v);
      return d.cast(d.param(values.length), type);
    };
    const conditions = (where: object | undefined, values: unknown[]): string[] => {
      const out: string[] = [];
      for (const [name, spec] of Object.entries(where ?? {})) {
        if (spec === undefined) throw no(`${name} is undefined`);
        const operators = spec !== null && typeof spec === "object" && !(spec instanceof Date) && !Array.isArray(spec) ? Object.entries(spec) : [["eq", spec] as const];
        if (!operators.length) throw no(`${name} has no operator`);
        for (const [op, v] of operators) {
          if (!OPERATORS.has(op) || v === undefined) throw no(`${name}.${op} is not an operator`);
          const left = `r.${d.ident(name)}`, bind = (x: unknown) => put(values, name, x);
          out.push(op === "isNull" ? condition(d, left, v ? "eq" : "ne", null, bind) : condition(d, left, op as "eq", v, bind));
        }
      }
      return out;
    };
    const rows = (sql: string, values: unknown[]) => drv.read(db, sql, values) as Promise<Record<string, unknown>[]>;
    /** Core never reads back the scope column, and `_rid` is storage's. */
    const clean = <R extends Record<string, unknown>>(list: R[]): R[] => { for (const r of list) { delete r._rid; if (f.s) delete r[f.s]; } return list; };
    const select = () => p.select ??= `SELECT r.*, ${wires(p, "r.")}${p.from}`;
    const where = (conds: string[]) => { const all = pol.sql ? [pol.sql, ...conds] : conds; return all.length ? ` WHERE ${all.join(" AND ")}` : ""; };
    const base = () => evaluate(d, pol.recipes, caller);

    async function find(q: Query<object, string> = {}): Promise<Page<unknown>> {
      const dir = q.order ?? "asc", name = q.orderBy ?? "id", limit = q.limit ?? 50;
      if (dir !== "asc" && dir !== "desc") throw no("order is asc or desc");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw no("limit is 1 to 500");
      const values = base(), conds = conditions(q.where, values);
      const id = `r."id"`, kc = `r.${d.ident(name)}`, up = dir === "asc", way = up ? "ASC" : "DESC";
      if (q.cursor !== undefined) {
        let at: unknown;
        try { at = JSON.parse(decodeURIComponent(q.cursor)); } catch { throw no("cursor is invalid"); }
        const [s, o, dr, v, last] = Array.isArray(at) ? at : [];
        if (s !== p.name || o !== name || dr !== dir || typeof last !== "string" || v == null) throw no("cursor is for another query");
        values.push(last);
        const after = `${id} ${up ? ">" : "<"} ${d.param(values.length)}`;
        if (name === "id") conds.push(after);
        else { const m = put(values, name, v); conds.push(`(${kc} ${up ? ">" : "<"} ${m} OR (${kc} = ${m} AND ${after}))`); }
      }
      // an ORDER BY column is NOT NULL (the generated type offers no other), so no NULL placement
      const list = await rows(`${select()}${where(conds)} ORDER BY ${name === "id" ? "" : `${kc} ${way}, `}${id} ${way} LIMIT ${limit + 1}`, values);
      if (list.length <= limit) return { rows: clean(list), cursor: null };
      const page = list.slice(0, limit), end = page[limit - 1]!;
      return { rows: clean(page), cursor: encodeURIComponent(JSON.stringify([p.name, name, dir, end[name], end.id])) };
    }

    /** A write: placeholders are numbered as values are pushed; a Core bind recipe is evaluated against this caller and clock. */
    const writer = (lock?: number | string) => {
      if (f.pub) throw no("is read-only");
      if (lock !== undefined && !(typeof lock === "number" ? Number.isSafeInteger(lock) : typeof lock === "string" && /^\d+$/.test(lock))) throw no("lock is the version read");
      const values: unknown[] = [], ms = Date.now(), into = d.ident(p.name);
      const push = (v: unknown) => (values.push(v), d.param(values.length));
      const recipe = (r: Recipe) => push(evaluate(d, [r], caller, { version: lock }, ms)[0]);
      const given = (set: object) => Object.entries(set).map(([name, v]) => {
        // SQLite matches column names without case, so compare folded
        const key = name.toLowerCase();
        if (SYSTEM.includes(key) || key === f.s) throw no(`${name} is not writable`);
        if (v === undefined) throw no(`${name} is undefined`);
        return [d.ident(name), put(values, name, v)] as const;
      });
      /** `WHERE id = ? AND <the caller's row rules> AND version = ?` */
      const guard = (id: string) => {
        if (typeof id !== "string") throw no("id is a string");
        return ` WHERE ${[`${d.ident("id")} = ${push(id)}`, ...[...(caller.kind === "system" ? x.trusted : x.caller), x.lock].map(t => term(t, "", recipe(t[2])))].join(" AND ")}`;
      };
      const run = async (sql: string, verb: string) => clean((await drv.procedure(db, [{ sql, binds: values, row: true }], `${p.name}/${verb}`))[0]! as Record<string, unknown>[]);
      return { given, recipe, guard, run, into, returning: () => ` RETURNING *, ${p.returning ??= wires(p, "")}` };
    };

    return {
      async findById(id: string) {
        if (typeof id !== "string") throw no("id is a string");
        const values = base();
        values.push(id);
        return clean(await rows(pol.byId ??= `${select()}${where([`r."id" = ${d.param(values.length)}`])} LIMIT 1`, values))[0] ?? null;
      },
      find,
      async first(q: Omit<Query<object, string>, "limit" | "cursor"> = {}) { return (await find({ ...q, limit: 1 })).rows[0] ?? null; },
      async count(w?: object) {
        const values = base(), conds = conditions(w, values);
        return Number(((await rows(`SELECT COUNT(*) AS "count"${p.from}${where(conds)}`, values))[0] as { count: unknown }).count);
      },
      async insert(set: object) {
        const w = writer(), names: string[] = [], marks: string[] = [];
        for (const [name, mark] of w.given(set)) { names.push(name); marks.push(mark); }
        for (const [column, v] of x.fills) { names.push(d.ident(column)); marks.push(v === "newId" ? rules.newId : w.recipe(v)); }
        return (await w.run(`INSERT INTO ${w.into} (${names.join(", ")}) VALUES (${marks.join(", ")})${w.returning()}`, "insert"))[0];
      },
      async update(id: string, set: object, { lock }: { lock: number | string }) {
        const w = writer(lock), assigns = w.given(set).map(([name, mark]) => `${name} = ${mark}`);
        if (!assigns.length) throw no("nothing to update");
        for (const [column, v] of x.sets) assigns.push(`${d.ident(column)} = ${v === "bump" ? `${d.ident(column)} + 1` : w.recipe(v)}`);
        return (await w.run(`UPDATE ${w.into} SET ${assigns.join(", ")}${w.guard(id)}${w.returning()}`, "update"))[0];
      },
      async delete(id: string, { lock }: { lock: number | string }) {
        const w = writer(lock);
        await w.run(`DELETE FROM ${w.into}${w.guard(id)}`, "delete");
      },
    };
  }
}
