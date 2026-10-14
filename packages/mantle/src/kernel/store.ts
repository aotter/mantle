import { modeOf } from "./caller-identity.js";
/**
 * Generic Store over Core's rowPolicy/writePolicy rules and per-Schema Facts (scope, TTL, publishing, dates).
 * Generated types own storage column names, values, filters and writable columns; the dialect quotes names and binds values.
 * Runtime refuses unsafe limits, system/scope writes, undefined values. It applies row rules, not requires.
 */
import { binds as evaluate, encode, type Bound, type Recipe } from "./binds.js";
import { ContractError, isAdmin, type Caller, type Row } from "./contracts.js";
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
/** What a Schema adds to the rules. The table is the collection's name. */
export interface Fact {
  readonly u?: readonly Extract<Term, readonly [string, 'in', ...unknown[]]>[];
  /** The scope column. */
  readonly s?: string;
  /** The TTL column and its seconds. */
  readonly ttl?: readonly [column: string, seconds: number];
  /** Opt-in publishing lifecycle. */
  readonly pub?: 1;
  /** Declared date-time and date columns (`created_at` and `updated_at` are always date-times). */
  readonly ts?: readonly string[];
  readonly d?: readonly string[];
  /** Declared searchable text fields; omitted collections search id only. */
  readonly search?: readonly string[];
  /** Generated parent policy and inherited read-only columns; no authored schema is interpreted. */
  readonly parent?: { readonly on: string; readonly scope?: readonly [parent: string, child: string]; readonly visible: Term; readonly table: string; readonly caller: readonly Term[]; readonly trusted: readonly Term[]; readonly fields: readonly string[]; readonly ts: readonly string[]; readonly d: readonly string[] };
}
export const SCOPE = "$scope", TTL = "$ttl";
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
/** Lazy, single-execution write: await directly or submit once to its Store's batch. */
export interface Write<T> extends PromiseLike<T> {}
export interface TransactionOptions { readonly isolation?: "serializable" | "repeatable read" | "read committed" | "read uncommitted" }
export interface Store<T extends Record<string, Table>> {
  collection<K extends keyof T & string>(name: K): Collection<T[K]>;
  batch<const W extends readonly Write<unknown>[]>(writes: W): Promise<{ -readonly [K in keyof W]: Awaited<W[K]> }>;
}
type Operations<H> = Record<string, Record<string, (db: H, caller: Caller, input: any, context: any) => Promise<any>>>;
type BoundOperations<O> = { [K in keyof O]: { [N in keyof O[K]]: O[K][N] extends (db: any, caller: Caller, input: infer I, ...args: any[]) => infer R ? (input: I) => R : never } };
type Tx<T extends Record<string, Table>, O> = Pick<Store<T>, "collection"> & BoundOperations<O>;
type Interactive<T extends Record<string, Table>, O> = { transaction<R>(fn: (tx: Tx<T, O>) => Promise<R>, options?: TransactionOptions): Promise<R> };

interface Policy { readonly sql: string; readonly recipes: readonly Recipe[]; readonly from: string; readonly projection: string; readonly terms: readonly Term[]; byId?: string; select?: string }
interface Prepared { readonly name: string; readonly f: Fact; /** the scope column, lower case (SQLite folds column names) */ readonly scope?: string; readonly x: ReturnType<typeof expand>; readonly from: string; readonly ts: readonly string[]; readonly d: readonly string[]; returning?: string; readonly policy: Map<string, Policy> }

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
  const policy = (p: Prepared, trusted: boolean, terms: readonly Term[], caller: Caller): Policy => {
    const bits: string[] = [];
    const select = (terms: readonly Term[]): Term[] => terms.flatMap(term => {
      if (term[1] === 'in') {
        // `{ all: true }` drops this field's term; a missing value is refused when the term binds, before SQL runs.
        const all = !!d.isAll?.(caller, term[2].field); bits.push(all ? '1' : '0');
        // The Store drops the term itself, so it renders only the filter form.
        return all ? [] : [[term[0], term[1], { ...term[2], scope: undefined }] as Term];
      }
      return [term[1] === 'parent' ? [term[0], term[1], term[2], {...term[3], terms: select(term[3].terms)}] as Term : term];
    });
    terms = select(terms);
    const parentTerms = p.f.parent ? select(trusted ? p.f.parent.trusted : p.f.parent.caller) : [];
    const cacheKey = String(+trusted)+bits.join('');
    const cached = p.policy.get(cacheKey); if (cached) return cached;
    const recipes: Recipe[] = [], param = (r: Recipe) => (recipes.push(r), d.param(recipes.length));
    const sql = terms.map(t => renderTerm(d, t, "r.", param)).join(" AND ");
    let from = p.from, projection = "";
    const parent = p.f.parent;
    if (parent) {
      const alias = "_mantle_merge", conditions = [`${alias}.${d.ident(parent.on)} = r.${d.ident(parent.on)}`, ...(parent.scope ? [`${alias}.${d.ident(parent.scope[0])} = r.${d.ident(parent.scope[1])}`] : []), ...parentTerms.map(t => renderTerm(d, t, alias + ".", param))];
      from += ` LEFT JOIN ${d.ident(parent.table)} ${alias} ON ${alias}.${ID} = (SELECT ${alias}.${ID} FROM ${d.ident(parent.table)} ${alias} WHERE ${conditions.join(" AND ")} ORDER BY ${alias}.${d.ident("created_at")} DESC, ${alias}.${ID} DESC LIMIT 1)`;
      projection = parent.fields.map(c => `${(parent.ts.includes(c) ? d.wireTimestamp(alias + "." + d.ident(c)).join("") : parent.d.includes(c) ? d.wireDate(alias + "." + d.ident(c)).join("") : alias + "." + d.ident(c))} AS ${d.ident(c)}`).join(", ");
    }
    const preparedPolicy = { sql, recipes, from, projection, terms }; p.policy.set(cacheKey, preparedPolicy); return preparedPolicy;
  };

  return ((db: H, caller: Caller, options?: object) => make(db, caller, false, options)) as never;

  function make(db: H, caller: Caller, inTransaction = false, options?: object) {
    type Pending = { build: () => Bound; project: (rows: Row[]) => unknown; promise?: Promise<any>; claimed?: boolean };
    const pending = new WeakMap<Write<unknown>, Pending>();
    const write = (build: Pending["build"], project: Pending["project"], path: string): Write<unknown> => {
      const state: Pending = { build, project };
      const value: Write<unknown> = { then: (yes, no) => {
        if (!state.promise) {
          state.promise = state.claimed ? Promise.reject(new Error("Write has already been batched.")) : Promise.resolve().then(async () => project((await drv.procedure(db, [build()], path))[0]!));
          state.claimed = true;
        }
        return state.promise.then(yes, no);
      } };
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
      ...(!inTransaction && { batch: async (writes: readonly Write<unknown>[]) => {
        const states = writes.map(w => pending.get(w));
        if (new Set(writes).size !== writes.length || states.some(s => !s || s.claimed)) throw new Error("Batch needs unused Writes from this Store.");
        for (const s of states) s!.claimed = true;
        const rows = writes.length ? await drv.procedure(db, states.map(s => s!.build()), "store/batch") : [];
        return states.map((s, i) => s!.project(rows[i]!));
      } }),
      ...(drv.transaction && { transaction: async (fn: (tx: any) => Promise<any>, txOptions?: TransactionOptions) => {
        if (inTransaction) throw new Error("Nested transactions are not supported.");
        return drv.transaction!(db, tx => fn(make(tx, caller, true, options)), txOptions);
      } }),
    };
    return store;
  }

  function collection(db: H, caller: Caller, p: Prepared, write: (build: () => Bound, project: (rows: Row[]) => unknown, path: string) => Write<unknown>) {
    const trusted = modeOf(caller) === "trusted", { f, x } = p, terms = trusted ? x.trusted : x.caller, pol = policy(p, trusted, terms, caller), no = (message: string) => new ContractError("INPUT_VALIDATION_FAILED", `${p.name}: ${message}`);
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
    const rows = (sql: string, values: unknown[]) => drv.read(db, sql, values) as Promise<Record<string, unknown>[]>;
    /** Core never reads back the scope column, and `_rid` is storage's. */
    const clean = <R extends Record<string, unknown>>(list: R[]): R[] => { for (const r of list) { delete r._rid; if (f.s) delete r[f.s]; } return list; };
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
      const given = (set: object, insert = false) => Object.entries(set).map(([name, v]) => {
        // SQLite matches column names without case, so compare folded
        const key = name.toLowerCase();
        if (SYSTEM.includes(key) || key === p.scope || !insert && !!f.u?.some(u => u[0] === key)) throw no(`${name} is not writable`);
        // a driver binds undefined as NULL: an update would silently clear the column
        if (v === undefined) throw no(`${name} is undefined`);
        return [d.ident(name), put(values, name, v)] as const;
      });
      /** `WHERE id = ? AND <the caller's row rules> AND version = ?` */
      const guard = (id: string) => ` WHERE ${[`${ID} = ${push(id)}`, ...[...pol.terms, x.lock].map(t => renderTerm(d, t, t[1] === "parent" ? d.ident(p.name) + "." : "", recipe))].join(" AND ")}`;
      const step = (sql: string): Bound => ({ sql, binds: values, row: true });
      return { given, recipe, guard, step, into, returning: () => ` RETURNING *, ${p.returning ??= wires(p, "")}` };
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
        return w.step(`INSERT INTO ${w.into} (${names.join(", ")}) VALUES (${marks.join(", ")})${w.returning()}`);
      }, rows => clean(rows)[0], `${p.name}/insert`); },
      update(id: string, set: object, { lock }: { lock: number | string }) { return write(() => {
        const w = writer(lock), assigns = w.given(set).map(([name, mark]) => `${name} = ${mark}`);
        for (const [column, v] of x.sets) assigns.push(`${d.ident(column)} = ${v === "bump" ? `${d.ident(column)} + 1` : w.recipe(v)}`);
        return w.step(`UPDATE ${w.into} SET ${assigns.join(", ")}${w.guard(id)}${w.returning()}`);
      }, rows => clean(rows)[0], `${p.name}/update`); },
      delete(id: string, { lock }: { lock: number | string }) { return write(() => {
        const w = writer(lock);
        return w.step(`DELETE FROM ${w.into}${w.guard(id)}`);
      }, () => undefined, `${p.name}/delete`); },
    };
  }
}
