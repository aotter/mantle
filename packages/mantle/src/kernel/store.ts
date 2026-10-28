import { scoped } from "./user-fields.js";
import { modeOf, checkFresh } from "./caller-mode.js";
/**
 * Generic Store over Core's rowPolicy/writePolicy rules and per-Schema Facts (scope, TTL, publishing, dates).
 * Generated types own storage column names, values, filters and writable columns; the dialect quotes names and binds values.
 * Runtime refuses unsafe limits, system/scope writes, undefined values. It applies row rules, not requires.
 */
import { binds as evaluate, encode, type Bound, type Recipe } from "./binds.js";
import { ContractError, type Caller, type Row } from "./contracts.js";
import type { Dialect } from "./dialect/common.js";
import { condition } from "./where.js";

import { decodeCursor, encodeCursor } from "./paging.js";
export { decodeCursor, encodeCursor };

/** `eq`: `column = value`; `ttl`: `column IS NULL OR column > value` (Core's `RowTerm`). */
export type Term = readonly [column: string, op: "eq" | "ttl", value: Recipe] | readonly [column: string, op: "admin", value: Recipe, published: string] | readonly [column: string, op: "parent", value: Recipe, parent: ParentPolicy] | readonly [column: string, op: "in", value: Extract<Recipe, { k: 'user' }>];
export interface ParentPolicy { readonly table: string; readonly terms: readonly Term[]; readonly scope?: readonly [parent: string, child: string]; readonly admin?: true; }
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
export interface Lock { readonly name: string; readonly on: readonly ("update" | "delete")[]; readonly sql: string; readonly message: string }
/** What a Schema adds to the rules. The table is the collection's name. */
export interface Fact {
  readonly u?: readonly Extract<Term, readonly [string, 'in', ...unknown[]]>[];
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
  readonly ref?: readonly { readonly column: string; readonly table: string; readonly field: string; readonly same: readonly (readonly [parent: string, child: string])[]; readonly terms: readonly Term[] }[];
  /** Schema locks; a trusted caller is not bound by them. */
  readonly lock?: readonly Lock[];
  /** Generated parent policy and inherited read-only columns; no authored schema is interpreted. */
  readonly parent?: { readonly on: string; readonly scope?: readonly [parent: string, child: string]; readonly visible: Term; readonly table: string; readonly caller: readonly Term[]; readonly trusted: readonly Term[]; readonly fields: readonly string[]; readonly ts: readonly string[]; readonly d: readonly string[] };
}
export const SCOPE = "$scope", TTL = "$ttl";
/** The probe's answer for an update that would leave a published row unpublishable; no lock name has a dot. */
export const REQUIRED = "publishing.required";
/** The columns Mantle owns: no write names them (nor the scope column), and `_rid` is never returned. */
const SYSTEM = ["id", "version", "created_at", "updated_at", "author_id", "status", "published_at", "_rid"];

/** A Schema's rules: the shared ones with its scope and TTL put in, and a term dropped where it has none. The generator proves this equals Core's for every Schema. */
export function expand(r: Rules, f: Fact) {
  const all = <T extends readonly [string, ...any[]]>(l: readonly T[]): T[] => l.flatMap(([c, ...t]) => (c = c === SCOPE ? f.s! : c === TTL ? f.ttl?.[0]! : c === "status" && !f.pub ? "" : c) ? [[c, ...t.map(v => v.k === "cutoff" ? { ...v, seconds: f.ttl![1] } : v)] as unknown as T] : []);
  return { caller: [...all(r.caller), ...(f.parent ? [f.parent.visible] : []), ...(f.u ?? [])], trusted: all(r.trusted), fills: all(r.fills), sets: all(r.sets), lock: r.lock };
}

export function renderTerm(d: Pick<Dialect, "ident" | 'anyOf'>, t: Term, prefix: string, placeholder: string | ((recipe: Recipe) => string)): string {
  const literal = (v: string) => `'${v.replaceAll("'", "''")}'`;
  const param = (r: Recipe) => typeof placeholder === "string" ? placeholder : placeholder(r);
  if (t[1] === 'in') {
    const kept = d.anyOf!(prefix + d.ident(t[0]), param(t[2]), t[2].type);
    // The same two forms the SQL compiler prints for a Schema scope term (see `scoped`); one parameter either way.
    return t[2].scope ? `(/*s:${t[2].field}*/${kept}/*|*/(${kept} OR 1 = 1)/*;*/)` : kept;
  }
  if (t[1] === "parent") {
    const [column, , value, parent] = t, alias = prefix === "_mantle_parent." || prefix === d.ident("_mantle_parent") + "." ? "_mantle_parent_" : "_mantle_parent";
    const conditions = [`${alias}.${d.ident(column)} = ${prefix}${d.ident(column)}`, ...(parent.scope ? [`${alias}.${d.ident(parent.scope[0])} = ${prefix}${d.ident(parent.scope[1])}`] : []), ...parent.terms.map(t => renderTerm(d, t, alias + ".", param))];
    const exists = `EXISTS (SELECT 1 FROM ${d.ident(parent.table)} ${alias} WHERE ${conditions.join(" AND ")})`;
    return parent.admin ? `(${param(value)} = 1 OR ${exists})` : exists;
  }
  const [column, op, value, published] = t;
  if (op !== 'eq' && op !== 'ttl' && op !== 'admin') throw new ContractError('USER_REFS_VERSION', 'Unknown row-policy operator.');
  const c = prefix + d.ident(column), bound = param(value);
  if (op === "admin") return `(${c} = ${literal(published!)} OR ${bound} = 1)`;
  return op === "ttl" ? `(${c} IS NULL OR ${c} > ${bound})` : `${c} = ${bound}`;
}

export interface Driver<H> {
  read(db: H, sql: string, binds: unknown[]): unknown[] | PromiseLike<unknown[]>;
  procedure(db: H, steps: readonly Bound[], path: string): Promise<Row[][]>;
  transaction?<R>(db: H, fn: (tx: H) => Promise<R>, options?: TransactionOptions): Promise<R>;
}

/** What the generator knows of a collection: its row, its filterable columns, its writable columns, which of those an insert must give, and the NOT NULL indexed columns `orderBy` may name. */
export interface Table { readonly row: object; readonly fields: object; readonly set: object; readonly required: string; readonly order: string; readonly insert?: object }
type RowOf<T extends Table> = Readonly<T["row"]>;
type InsertFields<T extends Table> = T extends { readonly insert: object } ? T['insert'] : T['set'];
type Insert<T extends Table> = Readonly<Pick<InsertFields<T>, Extract<T["required"], keyof InsertFields<T>>> & Partial<InsertFields<T>>>;
export type Operators<T> = { readonly eq?: T | null; readonly ne?: T | null; readonly gt?: T; readonly gte?: T; readonly lt?: T; readonly lte?: T; readonly in?: readonly T[]; readonly notIn?: readonly T[]; readonly like?: string; readonly isNull?: boolean };
/** Conditions are ANDed; a bare value is `eq` (null is IS NULL). */
export type Where<F> = { readonly [K in keyof F]?: F[K] | null | Operators<F[K]> };
export interface Page<R> { readonly rows: R[]; /** Pass back as `cursor` for the next page; null on the last. */ readonly cursor: string | null }
export interface Query<F, O extends string> { readonly where?: Where<F>; readonly search?: string; readonly orderBy?: O; readonly order?: "asc" | "desc"; readonly limit?: number; readonly cursor?: string }
export interface Collection<T extends Table> {
  findById(id: string): Promise<RowOf<T> | null>;
  find(query?: Query<T["fields"], T["order"]>): Promise<Page<RowOf<T>>>;
  first(query?: Omit<Query<T["fields"], T["order"]>, "limit" | "cursor">): Promise<RowOf<T> | null>;
  count(where?: Where<T["fields"]>): Promise<number>;
  /** The new row: the writable columns, with scope, author, clock and id filled by the row rules. An anonymous caller cannot insert into a scoped Schema. */
  insert(values: Insert<T>): Write<RowOf<T>>;
  /** Writes only the columns given. `lock` is the version the caller read; a different one (or a row the caller cannot see) is CONFLICT, and so is a unique-index clash. Returns the new row. */
  update(id: string, set: Readonly<Partial<T["set"]>>, options: { readonly lock: number | string }): Write<RowOf<T>>;
  /** CONFLICT when the version differs or the caller cannot see the row. */
  delete(id: string, options: { readonly lock: number | string }): Write<void>;
}
/** Lazy, single-execution write: await it (or `.then`/`.catch`/`.finally`, which run it) or submit it once to its Store's batch. */
export interface Write<T> extends PromiseLike<T> {
  catch<R = never>(onrejected?: ((reason: any) => R | PromiseLike<R>) | null): Promise<T | R>;
  finally(onfinally?: (() => void) | null): Promise<T>;
}
export interface TransactionOptions { readonly isolation?: "serializable" | "repeatable read" | "read committed" | "read uncommitted" }
export interface Store<T extends Record<string, Table>> {
  collection<K extends keyof T & string>(name: K): Collection<T[K]>;
  /** Atomic unused Writes from this Store. Inside a transaction, joins it; any rejection makes the outer transaction rollback-only, even if caught. */
  batch<const W extends readonly Write<unknown>[]>(writes: W): Promise<{ -readonly [K in keyof W]: Awaited<W[K]> }>;
}
type Operations<H> = Record<string, Record<string, (db: H, caller: Caller, input: any, context: any) => Promise<any>>>;
type BoundOperations<O> = { [K in keyof O]: { [N in keyof O[K]]: O[K][N] extends (db: any, caller: Caller, input: infer I, ...args: any[]) => infer R ? (input: I) => R : never } };
type Tx<T extends Record<string, Table>, O> = Store<T> & BoundOperations<O>;
type Interactive<T extends Record<string, Table>, O> = { transaction<R>(fn: (tx: Tx<T, O>) => Promise<R>, options?: TransactionOptions): Promise<R> };

interface Policy { readonly sql: string; readonly recipes: readonly Recipe[]; readonly from: string; readonly projection: string; readonly terms: readonly Term[]; byId?: string; select?: string }
interface Prepared { readonly name: string; readonly f: Fact; /** the scope column, lower case (SQLite folds column names) */ readonly scope?: string; readonly x: ReturnType<typeof expand>; readonly from: string; readonly ts: readonly string[]; readonly d: readonly string[]; returning?: string; readonly policy: Map<boolean, Policy> }

const transactionStores = new WeakSet<object>();

/**
 * A ref handler's `ctx.transaction` on drivers with interactive transactions: it opens one on the handler's Store, or
 * joins the one that Store already runs in (a handler called through `tx.procedures`), so the handler need not know.
 */
export function handlerTransaction(store: object, db: unknown) {
  const open = (store as { transaction: (fn: (tx: unknown, db: unknown) => Promise<unknown>) => Promise<unknown> }).transaction;
  return <R>(fn: (ctx: { store: any; db: any }) => Promise<R>): Promise<R> =>
    transactionStores.has(store) ? fn({ store, db }) : open((tx, txDb) => fn({ store: tx, db: txDb })) as Promise<R>;
}

export function createStore<H, T extends Record<string, Table>, D extends Driver<H> = Driver<H>, O extends Operations<H> = {}, C extends object = never>(d: Dialect, drv: D, rules: Rules, facts: { readonly [K in keyof T]: Fact }, operations?: O): (db: H, caller: Caller, ...options: [C] extends [never] ? [] : [options: C]) => Store<T> & BoundOperations<O> & (D extends Required<Pick<Driver<H>, "transaction">> ? Interactive<T, O> : {}) {
  const prepared = new Map<string, Prepared>();
  const prepare = (name: string): Prepared => {
    let p = prepared.get(name);
    if (!p) {
      const f = facts[name]!;
      prepared.set(name, p = { name, f, scope: f.s?.toLowerCase(), x: expand(rules, f), from: ` FROM ${d.ident(name)} r`, ts: ["created_at", "updated_at", ...f.ts ?? []], d: f.d ?? [], policy: new Map() });
    }
    return p;
  };
  /** The columns whose wire form the database formats, replacing the same names `*` brings (of two same-named columns a driver keeps the last). */
  const wires = (p: Prepared, prefix: string) => [p.ts, p.d].flatMap((columns, i) => columns.map(c => `${(i ? d.wireDate : d.wireTimestamp)(prefix + d.ident(c)).join("")} AS ${d.ident(c)}`)).join(", ");
  const ID = d.ident("id");
  /** The row rules of one mode, numbered from 1; the SQL is rendered once per mode. */
  const policy = (p: Prepared, trusted: boolean, terms: readonly Term[]): Policy => {
    const parentTerms = p.f.parent ? trusted ? p.f.parent.trusted : p.f.parent.caller : [];
    const cached = p.policy.get(trusted); if (cached) return cached;
    const recipes: Recipe[] = [], param = (r: Recipe) => (recipes.push(r), d.param(recipes.length));
    const sql = terms.map(t => renderTerm(d, t, "r.", param)).join(" AND ");
    let from = p.from, projection = "";
    const parent = p.f.parent;
    if (parent) {
      const alias = "_mantle_merge", conditions = [`${alias}.${d.ident(parent.on)} = r.${d.ident(parent.on)}`, ...(parent.scope ? [`${alias}.${d.ident(parent.scope[0])} = r.${d.ident(parent.scope[1])}`] : []), ...parentTerms.map(t => renderTerm(d, t, alias + ".", param))];
      from += ` LEFT JOIN ${d.ident(parent.table)} ${alias} ON ${alias}.${ID} = (SELECT ${alias}.${ID} FROM ${d.ident(parent.table)} ${alias} WHERE ${conditions.join(" AND ")} ORDER BY ${alias}.${d.ident("created_at")} DESC, ${alias}.${ID} DESC LIMIT 1)`;
      projection = parent.fields.map(c => `${(parent.ts.includes(c) ? d.wireTimestamp(alias + "." + d.ident(c)).join("") : parent.d.includes(c) ? d.wireDate(alias + "." + d.ident(c)).join("") : alias + "." + d.ident(c))} AS ${d.ident(c)}`).join(", ");
    }
    const preparedPolicy = { sql, recipes, from, projection, terms }; p.policy.set(trusted, preparedPolicy); return preparedPolicy;
  };

  return ((db: H, caller: Caller, options?: object) => make(db, caller, undefined, options)) as never;

  function make(db: H, caller: Caller, transaction?: { failure?: { error: unknown } }, options?: object) {
    type Pending = { build: () => Bound; project: (rows: Row[]) => unknown; promise?: Promise<any>; claimed?: boolean };
    const pending = new WeakMap<Write<unknown>, Pending>();
    const write = (build: Pending["build"], project: Pending["project"], path: string): Write<unknown> => {
      const state: Pending = { build: () => { checkFresh(caller, false, path); return build(); }, project };
      const run = (): Promise<unknown> => {
        if (!state.promise) {
          state.promise = state.claimed ? Promise.reject(new Error("Write has already been batched.")) : Promise.resolve().then(async () => project((await drv.procedure(db, [state.build()], path))[0]!));
          state.claimed = true;
        }
        return state.promise;
      };
      const value: Write<unknown> = { then: (yes, no) => run().then(yes, no), catch: no => run().catch(no), finally: done => run().finally(done) };
      pending.set(value, state);
      return value;
    };
    const store = {
      collection: (name: string) => collection(db, caller, prepare(name), write),
      ...Object.fromEntries(Object.keys(operations ?? {}).map(kind => {
        const cache: Record<string, unknown> = Object.create(null);
        return [kind, new Proxy(operations![kind]!, { get: (functions, name: string) => {
          if (Object.hasOwn(cache, name)) return cache[name];
          const fn = functions[name];
          return fn && (cache[name] = (input: any) => fn(db, caller, input, options && { ...options, store }));
        } })];
      })),
      batch: async (writes: readonly Write<unknown>[]) => {
        try {
          const states = writes.map(w => pending.get(w));
          if (new Set(writes).size !== writes.length || states.some(s => !s || s.claimed)) throw new Error("Batch needs unused Writes from this Store.");
          for (const s of states) s!.claimed = true;
          const rows = writes.length ? await drv.procedure(db, states.map(s => s!.build()), "store/batch") : [];
          return states.map((s, i) => s!.project(rows[i]!));
        } catch (error) {
          // A failed batch joins the outer rollback; catching it must not commit earlier steps.
          if (transaction) transaction.failure ??= { error };
          throw error;
        }
      },
      ...(drv.transaction && { transaction: async (fn: (tx: any, db: H) => Promise<any>, txOptions?: TransactionOptions) => {
        if (transaction) throw new Error("Nested transactions are not supported.");
        const state: { failure?: { error: unknown } } = {};
        return drv.transaction!(db, async tx => {
          const result = await fn(make(tx, caller, state, options), tx);
          if (state.failure) throw state.failure.error;
          return result;
        }, txOptions);
      } }),
    };
    if (transaction) transactionStores.add(store);
    return store;
  }

  function collection(db: H, caller: Caller, p: Prepared, write: (build: () => Bound, project: (rows: Row[]) => unknown, path: string) => Write<unknown>) {
    const trusted = modeOf(caller) === "trusted", { f, x } = p, terms = trusted ? x.trusted : x.caller, pol = policy(p, trusted, terms), no = (message: string) => new ContractError("INPUT_VALIDATION_FAILED", `${p.name}: ${message}`);
    /** A value as the engine stores it, as a placeholder. Date-times and dates are known from the fact; a JSON object is told by its JS type (a boolean binds as it is on every driver). */
    const put = (values: unknown[], column: string, v: unknown): string => {
      const type = p.ts.includes(column) ? "timestamptz" : p.d.includes(column) ? "date" : v !== null && typeof v === "object" && !(v instanceof Date) ? "json" : "";
      values.push(type === "json" ? JSON.stringify(v) : encode(d, type, v));
      return d.cast(d.param(values.length), type);
    };
    const conditions = (where: object | undefined, values: unknown[]): string[] => {
      const out: string[] = [];
      for (const [name, spec] of Object.entries(where ?? {})) {
        const operators = spec !== null && typeof spec === "object" && !(spec instanceof Date) && !Array.isArray(spec) ? Object.entries(spec) : [["eq", spec] as const];
        for (const [op, v] of operators) {
          const left = `r.${d.ident(name)}`, bind = (x: unknown) => put(values, name, x);
          out.push(op === "isNull" ? condition(d, left, v ? "eq" : "ne", null, bind) : condition(d, left, op as "eq", v, bind));
        }
      }
      return out;
    };
    const rows = (sql: string, values: unknown[]) => drv.read(db, scoped(sql, caller), values) as Promise<Record<string, unknown>[]>;
    /** Core never reads back the scope column, and `_rid` is storage's. PostgreSQL's int8 `version` arrives as text (or bigint): it counts writes from 1, so it is a number on every dialect, and a value past 2^53 is refused rather than rounded into a lock. */
    const clean = <R extends Record<string, unknown>>(list: R[]): R[] => {
      for (const r of list) {
        delete r._rid; if (f.s) delete r[f.s];
        const v = Number(r.version);
        if (!Number.isSafeInteger(v)) throw new ContractError("SQL_TYPE", `version ${r.version} is beyond Number.MAX_SAFE_INTEGER.`, p.name);
        (r as Record<string, unknown>).version = v;
      }
      return list;
    };
    const select = () => pol.select ??= `SELECT r.*, ${wires(p, "r.")}${pol.projection ? ", " + pol.projection : ""}${pol.from}`;
    const where = (conds: string[]) => { const all = pol.sql ? [pol.sql, ...conds] : conds; return all.length ? ` WHERE ${all.join(" AND ")}` : ""; };
    const base = () => evaluate(d, pol.recipes, caller);

    async function find(q: Query<object, string> = {}): Promise<Page<unknown>> {
      const dir = q.order ?? "asc", name = q.orderBy ?? "id", limit = q.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw no("limit is 1 to 500");
      const values = base(), conds = conditions(q.where, values);
      if (q.search !== undefined) {
        if (typeof q.search !== "string" || !q.search.trim() || q.search.includes("\0")) throw no("search takes a non-empty string without NUL");
        values.push(q.search.trim());
        const query = d.param(values.length), exact = `r.${ID} = ${query}`;
        conds.push(f.search?.length ? `(${exact} OR ${d.search(p.name, f.search, "r", query)})` : exact);
      }
      const id = `r.${ID}`, kc = `r.${d.ident(name)}`, up = dir === "asc", way = up ? "ASC" : "DESC";
      if (q.cursor !== undefined) {
        const [v, last] = decodeCursor(q.cursor, p.name + "/cursor");
        values.push(last);
        const after = `${id} ${up ? ">" : "<"} ${d.param(values.length)}`;
        if (name === "id") conds.push(after);
        else if (v === null) conds.push(`(${kc} IS NULL AND ${after})`);
        else { const m = put(values, name, v); conds.push(`(${kc} ${up ? ">" : "<"} ${m} OR (${kc} = ${m} AND ${after}) OR ${kc} IS NULL)`); }
      }
      // an ORDER BY column is NOT NULL (the generated type offers no other), so no NULL placement
      const list = await rows(`${select()}${where(conds)} ORDER BY ${name === "id" ? "" : `${kc} ${way} NULLS LAST, `}${id} ${way} LIMIT ${limit + 1}`, values);
      if (list.length <= limit) return { rows: clean(list), cursor: null };
      const page = list.slice(0, limit), end = page[limit - 1]!;
      return { rows: clean(page), cursor: encodeCursor(end[name], end.id) };
    }

    /** A write: placeholders are numbered as values are pushed; a Core bind recipe is evaluated against this caller and clock. */
    const writer = (lock?: number | string) => {
      const values: unknown[] = [], ms = Date.now(), into = d.ident(p.name);
      const push = (v: unknown) => (values.push(v), d.param(values.length));
      const recipe = (r: Recipe) => push(evaluate(d, [r], caller, { version: lock }, ms)[0]);
      /** The marks of the non-null columns written, by folded name. */
      const marks = new Map<string, string>();
      const given = (set: object, insert = false) => Object.entries(set).map(([name, v]) => {
        // SQLite matches column names without case, so compare folded
        const key = name.toLowerCase();
        if (SYSTEM.includes(key) || key === p.scope || !insert && !!f.u?.some(u => u[0] === key)) throw no(`${name} is not writable`);
        // a driver binds undefined as NULL: an update would silently clear the column
        if (v === undefined) throw no(`${name} is undefined`);
        const mark = put(values, name, v);
        if (v !== null) marks.set(key, mark);
        return [d.ident(name), mark] as const;
      });
      /** For each non-null reference written, the referenced row as the caller sees it, in the child's partition (`child`). */
      const refs = (child: (column: string) => string | undefined): string[] => trusted ? [] : (f.ref ?? []).flatMap(r => { const v = marks.get(r.column); return v ? [`EXISTS (SELECT 1 FROM ${d.ident(r.table)} _mantle_ref WHERE ${[`_mantle_ref.${d.ident(r.field)} = ${v}`, ...r.same.map(([parent, column]) => `_mantle_ref.${d.ident(parent)} = ${child(column) ?? "NULL"}`), ...r.terms.map(t => renderTerm(d, t, "_mantle_ref.", recipe))].join(" AND ")})`] : []; });
      /** `WHERE id = ? AND <the caller's row rules> AND version = ?` (no version for a lock probe) */
      const guard = (id: string, also: string[] = [], versioned = true) => ` WHERE ${[`${ID} = ${push(id)}`, ...[...pol.terms, ...versioned ? [x.lock] : []].map(t => renderTerm(d, t, t[1] === "parent" ? d.ident(p.name) + "." : "", recipe)), ...also].join(" AND ")}`;
      const step = (sql: string, lock?: Bound["lock"]): Bound => ({ sql: scoped(sql, caller), binds: values, row: true, ...(lock ? { lock } : {}) });
      return { given, marks, recipe, refs, guard, step, into, returning: () => ` RETURNING *, ${p.returning ??= wires(p, "")}` };
    };

    /**
     * A published row stays publishable (#1822): an update cannot clear a column `publish` requires, whoever writes (as `publish`
     * checks a system caller too). Columns it leaves alone are not re-checked, so a field added to `required` later does not
     * freeze the rows published before it. The fields such an update clears, for its `status <> 'published'` term.
     */
    const cleared = (set: object): string[] => {
      const req = f.req ?? {};
      return [...new Set(Object.entries(set).flatMap(([name, v]) => v === null && Object.hasOwn(req, name.toLowerCase()) ? [req[name.toLowerCase()]!] : []))];
    };
    /**
     * The caller's locks on `verb` (#1822), and an update's `publishable` term: `NOT (<when>)` terms for its WHERE, and the probe
     * a driver reads when the write changed no row, which names the lock or the missing publish data.
     */
    const locked = (id: string, verb: "update" | "delete", fields: string[] = []) => {
      const locks = trusted ? [] : (f.lock ?? []).filter(l => l.on.includes(verb)), required = fields.length ? `${d.ident("status")} <> 'published'` : undefined;
      if (!locks.length && !required) return { terms: [] };
      const w = writer(), where = w.guard(id, [], false), cases = [...locks.map(l => `WHEN (${l.sql}) IS NOT FALSE THEN '${l.name}'`), ...required ? [`WHEN NOT (${required}) THEN '${REQUIRED}'`] : []];
      const { sql, binds } = w.step(`SELECT CASE ${cases.join(" ")} END AS ${d.ident("lock")} FROM ${w.into}${where}`);
      return { terms: [...locks.map(l => `NOT (${l.sql})`), ...required ? [required] : []], lock: { sql, binds, schema: p.name, verb, locks: Object.fromEntries(locks.map(l => [l.name, l.message])), ...required ? { required: `This entry is published: publish requires ${fields.join(", ")}, so an update cannot clear ${fields.length > 1 ? "them" : "it"}.` } : {} } };
    };
    return {
      async findById(id: string) {
        const values = base();
        values.push(id);
        return clean(await rows(pol.byId ??= `${select()}${where([`r.${ID} = ${d.param(values.length)}`])} LIMIT 1`, values))[0] ?? null;
      },
      find,
      async first(q: Omit<Query<object, string>, "limit" | "cursor"> = {}) { return (await find({ ...q, limit: 1 })).rows[0] ?? null; },
      async count(w?: object) {
        const values = base(), conds = conditions(w, values);
        return Number(((await rows(`SELECT COUNT(*) AS "count"${pol.from}${where(conds)}`, values))[0] as { count: unknown }).count);
      },
      insert(set: object) { return write(() => {
        if (f.s && caller.kind === "anonymous") throw new ContractError("UNAUTHENTICATED", "A scoped insert requires an authenticated caller.", `${p.name}/insert`);
        if (f.u?.length) set = d.scopeInsert!(f.u.map(u => ({ column: u[0], field: u[2].field, type: u[2].type })), caller, set);
        const w = writer(), names: string[] = [], marks: string[] = [];
        for (const [name, mark] of w.given(set, true)) { names.push(name); marks.push(mark); }
        for (const [column, v] of x.fills) { names.push(d.ident(column)); marks.push(v === "newId" ? rules.newId : w.recipe(v)); }
        // a reference to a scoped Schema: the row is inserted only if the parent check holds, else `row` fails with CONFLICT
        const refs = w.refs(column => w.marks.get(column));
        return w.step(`INSERT INTO ${w.into} (${names.join(", ")}) ${refs.length ? `SELECT ${marks.join(", ")} WHERE ${refs.join(" AND ")}` : `VALUES (${marks.join(", ")})`}${w.returning()}`);
      }, rows => clean(rows)[0], `${p.name}/insert`); },
      update(id: string, set: object, { lock }: { lock: number | string }) { return write(() => {
        const w = writer(lock), assigns = w.given(set).map(([name, mark]) => `${name} = ${mark}`);
        for (const [column, v] of x.sets) assigns.push(`${d.ident(column)} = ${v === "bump" ? `${d.ident(column)} + 1` : w.recipe(v)}`);
        // the partition is never SET, so the child's is the row's own
        const refs = w.refs(column => `${w.into}.${d.ident(column)}`), held = locked(id, "update", cleared(set));
        return w.step(`UPDATE ${w.into} SET ${assigns.join(", ")}${w.guard(id, [...refs, ...held.terms])}${w.returning()}`, held.lock);
      }, rows => clean(rows)[0], `${p.name}/update`); },
      delete(id: string, { lock }: { lock: number | string }) { return write(() => {
        const w = writer(lock), held = locked(id, "delete");
        return w.step(`DELETE FROM ${w.into}${w.guard(id, held.terms)}`, held.lock);
      }, () => undefined, `${p.name}/delete`); },
    };
  }
}
