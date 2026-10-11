/**
 * The Store: one generic runtime over every collection (a Schema's table), on any dialect and driver. A collection is a small
 * fact record (`Descriptor`: columns, and Core's row rules as data, `rowPolicy` and `writePolicy`); this file renders those rules
 * and the caller's query to SQL text. Types are compile-time only: the generator emits each collection's row, filter, set and
 * orderable-column types, and nothing here knows an index. The Store does not check a View's or Procedure's `requires`.
 */
import { binds as evaluate, type Bound, type Recipe } from "./binds.js";
import { ContractError, type Caller } from "./contracts.js";
import type { Dialect } from "./dialect/common.js";
import { condition } from "./where.js";

/** `[authored name, SQL column, Mantle type, flags]`. */
export type Col = readonly [name: string, column: string, type: string, flags: number];
export const FILTER = 1, WRITE = 2;
/** `eq`: `column = value`; `ttl`: `column IS NULL OR column > value` (Core's `RowTerm`). */
export type Term = readonly [column: string, op: "eq" | "ttl", value: Recipe];
export interface Descriptor {
  readonly table: string;
  readonly cols: readonly Col[];
  /** Core's `rowPolicy` for a caller and for a system caller. */
  readonly caller: readonly Term[];
  readonly trusted: readonly Term[];
  /** Core's `writePolicy`. Absent: the collection is read-only. */
  readonly write?: {
    readonly fills: readonly (readonly [column: string, value: Recipe | "newId"])[];
    readonly sets: readonly (readonly [column: string, value: Recipe | "bump"])[];
    readonly lock: Term;
  };
}
export interface Driver<H> {
  read(db: H, sql: string, binds: readonly unknown[]): unknown[] | PromiseLike<unknown[]>;
  procedure(db: H, steps: readonly Bound[], path: string): Promise<unknown[][]>;
}

/** What the generator knows of a collection: its row, its filterable columns, its writable columns, an insert's columns (the Schema's required ones are not optional) and the columns an index serves. */
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
  /** The new row: the writable columns, with scope, author, clock and id filled by the row rules. Only the type checks that the Schema's required columns are given; a caller with no subject inserts nothing (the scope column is NOT NULL). */
  insert(values: T["insert"]): Promise<T["row"]>;
  /** Writes only the columns given. `lock` is the version the caller read; a different one (or a row the caller cannot see) is CONFLICT. Returns the new row. */
  update(id: string, set: Partial<T["set"]>, options: { readonly lock: number | string }): Promise<T["row"]>;
  /** CONFLICT when the version differs or the caller cannot see the row. */
  delete(id: string, options: { readonly lock: number | string }): Promise<void>;
}
export interface Store<T extends Record<string, Table>> { collection<K extends keyof T & string>(name: K): Collection<T[K]> }

const OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "like", "isNull"]);
const scalar = (v: unknown) => v === null || v instanceof Date || ["string", "number", "boolean", "bigint"].includes(typeof v);
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64 = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)));

interface Policy { readonly sql: string; readonly recipes: readonly Recipe[]; byId?: string }
interface Prepared { readonly desc: Descriptor; readonly from: string; readonly by: Map<string, Col>; select?: string; returning?: string; readonly policy: (Policy | undefined)[] }

export function createStore<H, T extends Record<string, Table>>(d: Dialect, drv: Driver<H>, descriptors: { readonly [K in keyof T]: Descriptor }): (db: H, caller: Caller) => Store<T> {
  const prepared = new Map<string, Prepared>();
  const bad = (table: string, message: string) => new ContractError("INPUT_VALIDATION_FAILED", `${table}: ${message}`);
  const prepare = (name: string): Prepared => {
    let p = prepared.get(name);
    if (!p) {
      if (!Object.hasOwn(descriptors, name)) throw bad(name, "is not a collection");
      const desc = descriptors[name]!;
      prepared.set(name, p = { desc, from: ` FROM ${d.ident(desc.table)} r`, by: new Map(desc.cols.map(c => [c[0], c] as const)), policy: [] });
    }
    return p;
  };
  const wire = (c: Col, x: string) => c[2] === "timestamptz" ? d.wireTimestamp(x).join("") : c[2] === "date" ? d.wireDate(x).join("") : x;
  const list = (cols: readonly Col[], prefix: string) => cols.map(c => `${wire(c, prefix + d.ident(c[1]))} AS ${d.ident(c[0])}`).join(", ");
  const term = ([column, op]: Term, prefix: string, placeholder: string) => {
    const c = prefix + d.ident(column);
    return op === "ttl" ? `(${c} IS NULL OR ${c} > ${placeholder})` : `${c} = ${placeholder}`;
  };
  /** The row rules of one mode, numbered from 1 and rendered once. */
  const policy = (p: Prepared, trusted: boolean): Policy => p.policy[+trusted] ??= ((terms: readonly Term[]) => ({ sql: terms.map((t, i) => term(t, "r.", d.param(i + 1))).join(" AND "), recipes: terms.map(t => t[2]) }))(trusted ? p.desc.trusted : p.desc.caller);

  class Coll {
    private readonly pol: Policy;
    constructor(private readonly db: H, private readonly caller: Caller, private readonly p: Prepared) { this.pol = policy(p, caller.kind === "system"); }
    private bad(message: string) { return bad(this.p.desc.table, message); }
    private column(name: string, flag: number, what: string): Col {
      const c = this.p.by.get(name);
      if (!c || !(c[3] & flag)) throw this.bad(`${name} is not ${what}`);
      return c;
    }
    /** A value as the engine stores it; `cursor`: a keyset cursor carries a boolean as the driver returned it. */
    private value(c: Col, v: unknown, cursor = false): unknown {
      if (v === null) return null;
      if (c[2] === "json") return d.json(v);
      if (!scalar(v)) throw this.bad(`${c[0]} needs a scalar`);
      switch (c[2]) {
        case "timestamptz": return d.timestamp(v as string | Date);
        case "date": return d.date(v as string);
        case "bool": if (cursor) return v; if (typeof v !== "boolean") throw this.bad(`${c[0]} needs a boolean`); return d.bool(v);
        default: return v;
      }
    }
    private conditions(where: object | undefined, values: unknown[]): string[] {
      const bind = (v: unknown) => (values.push(v), d.param(values.length));
      const out: string[] = [];
      for (const [name, spec] of Object.entries(where ?? {})) {
        const c = this.column(name, FILTER, "filterable");
        if (spec === undefined) throw this.bad(`${name} is undefined`);
        const operators = spec !== null && typeof spec === "object" && !(spec instanceof Date) && !Array.isArray(spec) ? Object.entries(spec) : [["eq", spec] as const];
        if (!operators.length) throw this.bad(`${name} has no operator`);
        for (const [op, v] of operators) {
          if (!OPERATORS.has(op) || v === undefined) throw this.bad(`${name}.${op} is not an operator`);
          const left = `r.${d.ident(c[1])}`, encode = (x: unknown) => this.value(c, x), put = (x: unknown) => d.cast(bind(x), c[2]);
          if (op === "isNull") { if (typeof v !== "boolean") throw this.bad(`${name}.isNull is a boolean`); out.push(condition(d, left, v ? "eq" : "ne", null, bind)); }
          else if (op === "in" || op === "notIn") { if (!Array.isArray(v)) throw this.bad(`${name}.${op} is an array`); out.push(condition(d, left, op, v.map(encode), put)); }
          else if (op === "like") { if (typeof v !== "string" || c[2] !== "text") throw this.bad(`${name}.like is a string on text`); out.push(condition(d, left, "like", v, bind)); }
          else if (v === null && op !== "eq" && op !== "ne") throw this.bad(`${name}.${op} cannot be null`);
          else out.push(condition(d, left, op as "eq", encode(v), put));
        }
      }
      return out;
    }
    private rows(sql: string, values: unknown[]) { return drv.read(this.db, sql, values) as Promise<Record<string, unknown>[]>; }
    private select() { return this.p.select ??= `SELECT ${list(this.p.desc.cols, "r.")}${this.p.from}`; }
    private where(conds: string[]) { const all = this.pol.sql ? [this.pol.sql, ...conds] : conds; return all.length ? ` WHERE ${all.join(" AND ")}` : ""; }

    async findById(id: string) {
      if (typeof id !== "string") throw this.bad("id is a string");
      const values = evaluate(d, this.pol.recipes, this.caller);
      values.push(id);
      return (await this.rows(this.pol.byId ??= `${this.select()}${this.where([`r."id" = ${d.param(values.length)}`])} LIMIT 1`, values))[0] ?? null;
    }
    async find(q: Query<object, string> = {}): Promise<Page<unknown>> {
      const dir = q.order ?? "asc", name = q.orderBy ?? "id", table = this.p.desc.table;
      if (dir !== "asc" && dir !== "desc") throw this.bad("order is asc or desc");
      const limit = q.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw this.bad("limit is 1 to 500");
      const key = this.column(name, FILTER, "orderable"), values = evaluate(d, this.pol.recipes, this.caller);
      const conds = this.conditions(q.where, values);
      const bind = (v: unknown) => (values.push(v), d.param(values.length));
      const id = `r."id"`, kc = `r.${d.ident(key[1])}`, up = dir === "asc";
      if (q.cursor !== undefined) {
        let at: unknown;
        try { at = JSON.parse(unb64(q.cursor)); } catch { throw this.bad("cursor is invalid"); }
        const [s, o, dr, v, last] = Array.isArray(at) ? at : [];
        if (s !== table || o !== name || dr !== dir || typeof last !== "string" || !scalar(v)) throw this.bad("cursor is for another query");
        const after = `${id} ${up ? ">" : "<"} ${bind(last)}`;
        if (name === "id") conds.push(after);
        else if (v === null) conds.push(up ? `(${kc} IS NOT NULL OR ${after})` : `(${kc} IS NULL AND ${after})`);
        else { const p = d.cast(bind(this.value(key, v, true)), key[2]); conds.push(`(${kc} ${up ? ">" : "<"} ${p}${up ? "" : ` OR ${kc} IS NULL`} OR (${kc} = ${p} AND ${after}))`); }
      }
      const way = up ? "ASC" : "DESC";
      const order = name === "id" ? ` ORDER BY ${id} ${way}` : ` ORDER BY ${kc} ${way}${d.nulls(dir)}, ${id} ${way}`;
      const rows = await this.rows(`${this.select()}${this.where(conds)}${order} LIMIT ${limit + 1}`, values);
      if (rows.length <= limit) return { rows, cursor: null };
      const page = rows.slice(0, limit), last = page[limit - 1]!;
      return { rows: page, cursor: b64(JSON.stringify([table, name, dir, last[name] ?? null, last.id])) };
    }
    async first(q: Omit<Query<object, string>, "limit" | "cursor"> = {}) { return (await this.find({ ...q, limit: 1 })).rows[0] ?? null; }
    async count(where?: object) {
      const values = evaluate(d, this.pol.recipes, this.caller), conds = this.conditions(where, values);
      return Number(((await this.rows(`SELECT COUNT(*) AS "count"${this.p.from}${this.where(conds)}`, values))[0] as { count: unknown }).count);
    }

    /** A write: placeholders are numbered as values are pushed; a Core bind recipe is evaluated against this caller and clock. */
    private writer(lock?: number | string) {
      const write = this.p.desc.write;
      if (!write) throw this.bad("is read-only");
      if (lock !== undefined && !(typeof lock === "number" ? Number.isSafeInteger(lock) : typeof lock === "string" && /^\d+$/.test(lock))) throw this.bad("lock is the version read");
      const values: unknown[] = [], ms = Date.now();
      const put = (v: unknown) => (values.push(v), d.param(values.length));
      const recipe = (r: Recipe) => put(evaluate(d, [r], this.caller, { version: lock }, ms)[0]);
      const given = (set: object) => Object.entries(set).map(([name, v]) => {
        const c = this.column(name, WRITE, "writable");
        if (v === undefined) throw this.bad(`${name} is undefined`);
        return [c, d.cast(put(this.value(c, v)), c[2])] as const;
      });
      /** `WHERE id = ? AND <the caller's row rules> AND version = ?` */
      const guard = (id: string) => {
        if (typeof id !== "string") throw this.bad("id is a string");
        const terms = this.caller.kind === "system" ? this.p.desc.trusted : this.p.desc.caller;
        return ` WHERE ${[`${d.ident("id")} = ${put(id)}`, ...[...terms, write.lock].map(t => term(t, "", recipe(t[2])))].join(" AND ")}`;
      };
      const run = async (sql: string, verb: string) => (await drv.procedure(this.db, [{ sql, binds: values, row: true }], `${this.p.desc.table}/${verb}`))[0]!;
      return { write, put, recipe, given, guard, run, into: d.ident(this.p.desc.table), returning: ` RETURNING ${this.p.returning ??= list(this.p.desc.cols, "")}` };
    }
    async insert(set: object) {
      const w = this.writer(), names: string[] = [], marks: string[] = [];
      for (const [c, mark] of w.given(set)) { names.push(d.ident(c[1])); marks.push(mark); }
      for (const [column, v] of w.write.fills) { names.push(d.ident(column)); marks.push(v === "newId" ? w.put(crypto.randomUUID().replaceAll("-", "")) : w.recipe(v)); }
      return (await w.run(`INSERT INTO ${w.into} (${names.join(", ")}) VALUES (${marks.join(", ")})${w.returning}`, "insert"))[0];
    }
    async update(id: string, set: object, { lock }: { lock: number | string }) {
      const w = this.writer(lock), assigns = w.given(set).map(([c, mark]) => `${d.ident(c[1])} = ${mark}`);
      if (!assigns.length) throw this.bad("nothing to update");
      for (const [column, v] of w.write.sets) assigns.push(`${d.ident(column)} = ${v === "bump" ? `${d.ident(column)} + 1` : w.recipe(v)}`);
      return (await w.run(`UPDATE ${w.into} SET ${assigns.join(", ")}${w.guard(id)}${w.returning}`, "update"))[0];
    }
    async delete(id: string, { lock }: { lock: number | string }) {
      const w = this.writer(lock);
      await w.run(`DELETE FROM ${w.into}${w.guard(id)}`, "delete");
    }
  }
  return (db, caller) => ({ collection: name => new Coll(db, caller, prepare(name)) as never });
}
