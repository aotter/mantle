/**
 * The Store: typed reads and an OCC update over one Schema, on any dialect and driver. It owns no policy. Scope, TTL and
 * published predicates are inside the descriptor's base SQL, which the generator took from Core's own lowering of
 * `SELECT r.* FROM <schema> r`; this file only appends `WHERE ... ORDER BY ... LIMIT` outside the `AS r` wrapper.
 * Placeholders continue after the base statement's own: the base uses 1..k, the Store k+1...
 */
import { binds as evaluate, type Bound, type Recipe, type Step } from "./binds.js";
import { ContractError, type Caller } from "./contracts.js";
import type { Dialect } from "./dialect/common.js";
import { condition } from "./where.js";

/** `[authored name, SQL column, Mantle type, flags]`. */
export type Col = readonly [name: string, column: string, type: string, flags: number];
export const FILTER = 1, WRITE = 2, ORDER = 4;
export interface Source { readonly from: string; readonly binds: readonly Recipe[] }
export interface Descriptor {
  readonly schema: string;
  readonly cols: readonly Col[];
  /** `SELECT r.id, ... ` up to the wrapper; wire-form columns are already formatted by SQL. */
  readonly select: string;
  /** ` FROM (<Core's policy wrapper>) AS r` and its binds, for a caller and for a system caller. */
  readonly caller: Source;
  readonly trusted: Source;
  /** Core's lowering of one UPDATE per Schema: inputs `i_id`, `i_lock`, and per writable column `v_<column>` and `s_<column>` (is it set). Absent for a Schema that cannot be updated this way. */
  readonly update?: { readonly caller: Step; readonly trusted: Step };
}
export interface Driver<H> {
  read(db: H, sql: string, binds: readonly unknown[]): unknown[] | PromiseLike<unknown[]>;
  procedure(db: H, steps: readonly Bound[], path: string): Promise<unknown[][]>;
}

export type Operators<T> = { readonly eq?: T | null; readonly ne?: T | null; readonly gt?: T; readonly gte?: T; readonly lt?: T; readonly lte?: T; readonly in?: readonly T[]; readonly notIn?: readonly T[]; readonly like?: string; readonly isNull?: boolean };
/** Conditions are ANDed; a bare value is `eq` (null is IS NULL). */
export type Where<F> = { readonly [K in keyof F]?: F[K] | null | Operators<F[K]> };
export interface Page<R> { readonly rows: R[]; /** Pass back as `cursor` for the next page; null on the last. */ readonly cursor: string | null }
export interface Query<F, O extends string> { readonly where?: Where<F>; readonly orderBy?: O; readonly order?: "asc" | "desc"; readonly limit?: number; readonly cursor?: string }
export interface Store<R, F, S, O extends string> {
  findById(id: string): Promise<R | null>;
  find(query?: Query<F, O>): Promise<Page<R>>;
  first(query?: Omit<Query<F, O>, "limit" | "cursor">): Promise<R | null>;
  count(where?: Where<F>): Promise<number>;
  /** `lock` is the version the caller read; a different one (or another owner's row) is CONFLICT. Returns the new row. */
  update(id: string, set: Partial<S>, options: { readonly lock: number | string }): Promise<R>;
}

const OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "like", "isNull"]);
const scalar = (v: unknown) => v === null || v instanceof Date || ["string", "number", "boolean", "bigint"].includes(typeof v);
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64 = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)));

export function createStore<H, R, F, S, O extends string>(d: Dialect, drv: Driver<H>, desc: Descriptor): (db: H, caller: Caller) => Store<R, F, S, O> {
  const bad = (message: string) => new ContractError("INPUT_VALIDATION_FAILED", `${desc.schema}: ${message}`);
  let columns: Map<string, Col> | undefined;
  const column = (name: string, flag: number, what: string): Col => {
    const c = (columns ??= new Map(desc.cols.map(x => [x[0], x] as const))).get(name);
    if (!c || !(c[3] & flag)) throw bad(`${name} is not ${what}`);
    return c;
  };
  const sql = (c: Col) => `r.${d.ident(c[1])}`;
  /** A filter value as the engine stores it. */
  const value = (c: Col, v: unknown, cursor = false): unknown => {
    if (v === null) return null;
    if (!scalar(v)) throw bad(`${c[0]} needs a scalar`);
    switch (c[2]) {
      case "timestamptz": return d.timestamp(v as string | Date);
      case "date": return d.date(v as string);
      case "bool": if (cursor) return v; if (typeof v !== "boolean") throw bad(`${c[0]} needs a boolean`); return d.bool(v);
      default: return v;
    }
  };

  return (db, caller) => {
    const source = caller.kind === "system" ? desc.trusted : desc.caller;
    const k = source.binds.length;
    const base = () => evaluate(d, source.binds, caller);
    const run = async (text: string, values: unknown[]) => await drv.read(db, text, values);
    const conditions = (where: Where<F> | undefined, values: unknown[]): string[] => {
      const bind = (v: unknown) => (values.push(v), d.param(values.length));
      const out: string[] = [];
      for (const [name, spec] of Object.entries(where ?? {})) {
        const c = column(name, FILTER, "filterable");
        if (spec === undefined) throw bad(`${name} is undefined`);
        const operators = spec !== null && typeof spec === "object" && !(spec instanceof Date) && !Array.isArray(spec) ? Object.entries(spec) : [["eq", spec] as const];
        if (!operators.length) throw bad(`${name} has no operator`);
        for (const [op, v] of operators) {
          if (!OPERATORS.has(op) || v === undefined) throw bad(`${name}.${op} is not an operator`);
          const left = sql(c), encode = (x: unknown) => value(c, x), put = (x: unknown) => d.cast(bind(x), c[2]);
          if (op === "isNull") { if (typeof v !== "boolean") throw bad(`${name}.isNull is a boolean`); out.push(condition(d, left, v ? "eq" : "ne", null, bind)); }
          else if (op === "in" || op === "notIn") { if (!Array.isArray(v)) throw bad(`${name}.${op} is an array`); out.push(condition(d, left, op, v.map(encode), put)); }
          else if (op === "like") { if (typeof v !== "string" || c[2] !== "text") throw bad(`${name}.like is a string on text`); out.push(condition(d, left, "like", v, bind)); }
          else if (v === null && op !== "eq" && op !== "ne") throw bad(`${name}.${op} cannot be null`);
          else out.push(condition(d, left, op as "eq", encode(v), put));
        }
      }
      return out;
    };
    const tail = (conds: string[]) => conds.length ? ` WHERE ${conds.join(" AND ")}` : "";

    const find = async (q: Query<F, O> = {}): Promise<Page<R>> => {
      const dir = q.order ?? "asc", name = (q.orderBy ?? "id") as string;
      if (dir !== "asc" && dir !== "desc") throw bad("order is asc or desc");
      const limit = q.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw bad("limit is 1 to 500");
      const key = column(name, ORDER, "orderable"), values = base();
      const conds = conditions(q.where, values);
      const bind = (v: unknown) => (values.push(v), d.param(values.length));
      const id = `r."id"`, kc = sql(key), up = dir === "asc";
      if (q.cursor !== undefined) {
        let at: unknown;
        try { at = JSON.parse(unb64(q.cursor)); } catch { throw bad("cursor is invalid"); }
        const [s, o, dr, v, last] = Array.isArray(at) ? at : [];
        if (s !== desc.schema || o !== name || dr !== dir || typeof last !== "string" || !scalar(v)) throw bad("cursor is for another query");
        const after = `${id} ${up ? ">" : "<"} ${bind(last)}`;
        if (name === "id") conds.push(after);
        else if (v === null) conds.push(up ? `(${kc} IS NOT NULL OR ${after})` : `(${kc} IS NULL AND ${after})`);
        else { const p = d.cast(bind(value(key, v, true)), key[2]); conds.push(`(${kc} ${up ? ">" : "<"} ${p}${up ? "" : ` OR ${kc} IS NULL`} OR (${kc} = ${p} AND ${after}))`); }
      }
      const way = up ? "ASC" : "DESC";
      const order = name === "id" ? ` ORDER BY ${id} ${way}` : ` ORDER BY ${kc} ${way}${d.nulls(dir)}, ${id} ${way}`;
      const rows = (await run(`${desc.select}${source.from}${tail(conds)}${order} LIMIT ${limit + 1}`, values)) as Record<string, unknown>[];
      if (rows.length <= limit) return { rows: rows as R[], cursor: null };
      const page = rows.slice(0, limit), last = page[limit - 1]!;
      return { rows: page as R[], cursor: b64(JSON.stringify([desc.schema, name, dir, last[name] ?? null, last.id])) };
    };

    return {
      async findById(id) {
        if (typeof id !== "string") throw bad("id is a string");
        const values = base();
        values.push(id);
        return ((await run(`${desc.select}${source.from} WHERE r."id" = ${d.param(k + 1)} LIMIT 1`, values))[0] ?? null) as R | null;
      },
      find,
      async first(q = {}) { return (await find({ ...q, limit: 1 } as Query<F, O>)).rows[0] ?? null; },
      async count(where) {
        const values = base(), conds = conditions(where, values);
        return Number(((await run(`SELECT COUNT(*) AS "count"${source.from}${tail(conds)}`, values))[0] as { count: unknown }).count);
      },
      async update(id, set, { lock }) {
        const update = desc.update && (caller.kind === "system" ? desc.update.trusted : desc.update.caller);
        if (!update) throw bad("not updatable");
        if (typeof id !== "string") throw bad("id is a string");
        if (!(typeof lock === "number" ? Number.isSafeInteger(lock) : typeof lock === "string" && /^\d+$/.test(lock))) throw bad("lock is the version read");
        const given = Object.entries(set as Record<string, unknown>);
        if (!given.length) throw bad("nothing to update");
        const input: Record<string, unknown> = { i_id: id, i_lock: lock };
        for (const c of desc.cols) if (c[3] & WRITE) { input[`v_${c[1]}`] = null; input[`s_${c[1]}`] = d.bool(false); }
        for (const [name, v] of given) {
          const c = column(name, WRITE, "writable");
          if (v === undefined) throw bad(`${name} is undefined`);
          // timestamps and dates are encoded by the shared bind recipe; booleans and JSON take their storage form here
          input[`v_${c[1]}`] = v === null ? null : c[2] === "bool" ? d.bool(v as boolean) : c[2] === "json" ? d.json(v) : v;
          input[`s_${c[1]}`] = d.bool(true);
        }
        const [rows] = await drv.procedure(db, [{ sql: update.sql, binds: evaluate(d, update.binds, caller, input), row: true }], `stores/${desc.schema}/update`);
        return rows![0] as R;
      },
    };
  };
}
