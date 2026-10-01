/**
 * ADR-0030's JSON Store shapes to the same IR a manifest's SQL compiles to (ADR-0034 decision 3): a
 * converter, not a second query path. Values never appear in the IR: each becomes a typed `input.vN`, so they
 * are bound and CAST like any input, and the result goes through the same validation and policy.
 */
import { DiagnosticError, runtimeDiagnostic } from "../../spec/kernel/index.js";
import { firstZodIssueAsJsonPointer, jsonSchemaToZod, type JsonSchema, type SqlNode as N } from "../../spec/domain/index.js";
import type { ZodType } from "zod";
import { classify } from "../../spec/domain/index.js";
import { S, op, ref, table, target } from "../sql/ast.js";
import type { StorageSchema, StoreCodec } from "../dialect.js";
import type { StoreScalar, StoreSelect, StoreWhere, StoreWriteOp } from "../store.js";

/** A Schema as the Store sees it: `names` maps a lower-cased column to the name its JSON Schema declares. */
export interface StoreSchema extends StorageSchema {
  readonly names?: Readonly<Record<string, string>>;
  /** The JSON Schema every written value is checked against. */
  readonly schema?: JsonSchema;
  /** A translation publishes only once its parent is published. */
  readonly translates?: { readonly parent: string; readonly on: string };
}
export type StoreSchemas = Readonly<Record<string, StoreSchema>>;

const invalid = (message: string) => new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message }));

/** Native columns as JSON names them, with the physical column and its Mantle type. */
export const NATIVE: Readonly<Record<string, { col: string; type: string }>> = {
  id: { col: "id", type: "text" }, status: { col: "status", type: "text" }, version: { col: "version", type: "integer" },
  createdAt: { col: "created_at", type: "timestamptz" }, updatedAt: { col: "updated_at", type: "timestamptz" }, authorId: { col: "author_id", type: "text" },
};
const OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "like", "in", "notIn", "isNull"]);
const SCALAR = new Set(["text", "integer", "real", "bool", "timestamptz", "date"]);

export interface Column {
  /** physical column */ readonly col: string;
  readonly type: string;
  /** the name a row carries */ readonly out: string;
}

/** The physical columns of a field: a geo field is stored as `<field>_lat` and `<field>_lng`. */
const physical = (c: Column) => (c.type === "geo" ? [`${c.col}_lat`, `${c.col}_lng`] : [c.col]);
/** The hidden output a select reads one half of a geo field under. */
export const geoKey = (out: string, half: "lat" | "lng") => `_geo_${half}_${out}`;
/** A selected row with each geo field's two halves joined back into `{ lat, lng }`, or null when either is missing. */
export function geoValue(row: Readonly<Record<string, unknown>>, columns: readonly Column[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const c of columns) {
    if (c.type !== "geo") continue;
    const lat = out[geoKey(c.out, "lat")], lng = out[geoKey(c.out, "lng")];
    delete out[geoKey(c.out, "lat")];
    delete out[geoKey(c.out, "lng")];
    out[c.out] = lat == null || lng == null ? null : { lat, lng };
  }
  return out;
}

const bool = (boolop: string, args: N[]): N => ({ BoolExpr: { boolop, args } });
const nullTest = (arg: N, t: "IS_NULL" | "IS_NOT_NULL"): N => ({ NullTest: { arg, nulltesttype: t } });
const SELECT = { limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } as const;

const zods = new WeakMap<StoreSchema, { full: ZodType; partial: ZodType }>();
const STATUSES = ["draft", "published", "archived"];

/**
 * The values of a write against the Schema's JSON Schema. `full` must be a complete entry; `partial` checks only what is present.
 * The scope field is filled by Store, so it is never required of the caller. A null clears a field that is not required. An insert into a publishing Schema is a draft
 * (partial); a publish is checked complete by the caller of this function, on the entry as it will be.
 */
export function validateValues(def: StoreSchema, values: Readonly<Record<string, unknown>>, mode: "full" | "partial"): void {
  if (!def.schema) return;
  let z = zods.get(def);
  if (!z) {
    const required = (def.schema.required ?? []).filter((f) => f.toLowerCase() !== def.scope);
    zods.set(def, (z = { full: jsonSchemaToZod({ ...def.schema, required }), partial: jsonSchemaToZod({ ...def.schema, required: [] }) }));
  }
  // a column is named in any case: checked under the name its JSON Schema declares, once
  const named: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    const name = def.names?.[k.toLowerCase()] ?? k;
    if (Object.hasOwn(named, name)) throw invalid(`The values name '${name}' twice.`);
    named[name] = v;
  }
  // null clears a field the Schema does not require: it is stored as NULL and read back as null, so it is checked as absent
  const required = new Set(def.schema.required ?? []);
  const r = z[mode].safeParse(Object.fromEntries(Object.entries(named).filter(([k, v]) => v !== null || required.has(k))));
  if (r.success) return;
  const { instancePath, message } = firstZodIssueAsJsonPointer(r.error);
  throw invalid(`The values do not match the Schema${instancePath ? ` at ${instancePath}` : ""}: ${message}`);
}

/** An insert's values with each top-level JSON Schema `default` filled where the caller named no value (the scope field is Store's). */
function withDefaults(def: StoreSchema, values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const named = new Set(Object.keys(values).map((k) => k.toLowerCase()));
  const out: Record<string, unknown> = { ...values };
  for (const [name, p] of Object.entries(def.schema?.properties ?? {}))
    if (p.default !== undefined && !named.has(name.toLowerCase()) && name.toLowerCase() !== def.scope) out[name] = structuredClone(p.default);
  return out;
}

/** Builds IR for one or more operations that share one input namespace, so a batch binds each value once. */
export class StoreJson {
  readonly inputs: Record<string, string> = {};
  readonly values: Record<string, unknown> = {};
  constructor(private readonly schemas: StoreSchemas, private readonly codec: StoreCodec) {}

  private schema(name: unknown): { name: string; def: StoreSchema } {
    const def = typeof name === "string" ? this.schemas[name.toLowerCase()] : undefined;
    if (!def) throw invalid(`Unknown Schema '${String(name)}'.`);
    return { name: String(name).toLowerCase(), def };
  }

  column(def: StoreSchema, name: unknown, purpose: string, scalar: boolean): Column {
    if (typeof name !== "string") throw invalid(`${purpose} must name a column.`);
    const native = Object.hasOwn(NATIVE, name) ? NATIVE[name]! : undefined;
    if (native) {
      if (name === "status" && !def.publishing) throw invalid(`This Schema has no column 'status'.`);
      return { ...native, out: name };
    }
    const type = Object.hasOwn(def.fields, name.toLowerCase()) ? def.fields[name.toLowerCase()] : undefined;
    if (!type) throw invalid(`Schema has no column '${name}'.`);
    if (scalar && !SCALAR.has(type) && !type.startsWith("numeric(")) throw invalid(`Column '${name}' is not a scalar and cannot be used in ${purpose}.`);
    return { col: name.toLowerCase(), type, out: def.names?.[name.toLowerCase()] ?? name };
  }

  /** A JSON value as a typed input reference. */
  private val(type: string, v: unknown, what: string): N {
    const ok = type === "bool" ? typeof v === "boolean" : type === "text" || type === "date" ? typeof v === "string"
      : type.startsWith("numeric(") || type === "json" ? true : typeof v === "number" && Number.isFinite(v) || (type === "timestamptz" && typeof v === "string");
    if (!ok) throw invalid(`${what} expects a value of type ${type}.`);
    try { this.codec.encode(type, v); } catch (e) { throw invalid(`${what}: ${e instanceof Error ? e.message : String(e)}`); }
    const name = `v${Object.keys(this.inputs).length}`;
    this.inputs[name] = type;
    this.values[name] = v;
    return ref("input", name);
  }

  /** The physical columns a write of one value sets, with what each is set to: a geo field is its two columns. */
  private assign(c: Column, v: unknown): [string, N][] {
    const NULL: N = { A_Const: { isnull: true } };
    if (c.type !== "geo") return [[c.col, v === null ? NULL : this.val(c.type, v, `'${c.out}'`)]];
    if (v === null) return [[`${c.col}_lat`, NULL], [`${c.col}_lng`, NULL]];
    const g = v as { lat?: unknown; lng?: unknown };
    const ok = (x: unknown, max: number) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= max;
    if (typeof v !== "object" || Array.isArray(v) || !ok(g.lat, 90) || !ok(g.lng, 180)) throw invalid(`'${c.out}' expects { lat, lng }: a latitude from -90 to 90 and a longitude from -180 to 180.`);
    return [[`${c.col}_lat`, this.val("real", g.lat, `'${c.out}.lat'`)], [`${c.col}_lng`, this.val("real", g.lng, `'${c.out}.lng'`)]];
  }

  private budget = 0;
  where(w: StoreWhere, def: StoreSchema, depth = 0): N {
    if (depth > 16) throw invalid("Store where nests deeper than 16.");
    if (++this.budget > 256) throw invalid("Store where has more than 256 conditions.");
    if (typeof w !== "object" || w === null || Array.isArray(w)) throw invalid("A Store where condition must be an object.");
    const entries = Object.entries(w);
    if (!entries.length) throw invalid("A Store where condition must not be empty.");
    const parts = entries.map(([key, value]): N => {
      if (value === undefined) throw invalid(`Store where '${key}' is undefined; omit the key or use isNull.`);
      if (key === "and" || key === "or") {
        if (!Array.isArray(value) || !value.length) throw invalid(`'${key}' takes a non-empty array.`);
        return bool(key === "and" ? "AND_EXPR" : "OR_EXPR", value.map((c: StoreWhere) => this.where(c, def, depth + 1)));
      }
      if (key === "not") return bool("NOT_EXPR", [this.where(value as StoreWhere, def, depth + 1)]);
      const c = this.column(def, key, "a where", true);
      const col = ref(c.col);
      if (typeof value !== "object" || value === null) return this.compare("eq", col, c, value as StoreScalar);
      const cmps = Object.entries(value);
      if (!cmps.length) throw invalid(`Column '${key}' has an empty comparison.`);
      const cmp = cmps.map(([o, operand]) => {
        if (operand === undefined) throw invalid(`'${o}' on '${key}' is undefined; omit it or use isNull.`);
        if (!OPERATORS.has(o)) throw invalid(`Unknown Store operator '${o}' on '${key}'.`);
        if (++this.budget > 256) throw invalid("Store where has more than 256 conditions.");
        return this.compare(o, col, c, operand, depth);
      });
      return cmp.length === 1 ? cmp[0]! : bool("AND_EXPR", cmp);
    });
    return parts.length === 1 ? parts[0]! : bool("AND_EXPR", parts);
  }

  private compare(o: string, col: N, c: Column, v: unknown, depth = 0): N {
    const what = `'${o}' on '${c.out}'`;
    switch (o) {
      case "isNull":
        if (typeof v !== "boolean") throw invalid(`${what} takes a boolean.`);
        return nullTest(col, v ? "IS_NULL" : "IS_NOT_NULL");
      case "eq": case "ne":
        if (v === null) return nullTest(col, o === "eq" ? "IS_NULL" : "IS_NOT_NULL");
        return op(o === "eq" ? "=" : "<>", col, this.val(c.type, v, what));
      case "like":
        if (c.type !== "text" || typeof v !== "string") throw invalid(`${what} expects a string column and pattern.`);
        if (new TextEncoder().encode(v).byteLength > 1024) throw invalid(`${what} accepts at most 1024 UTF-8 bytes.`);
        return { A_Expr: { kind: "AEXPR_LIKE", name: [S("~~")], lexpr: col, rexpr: this.val("text", v, what) } };
      case "in": case "notIn": {
        const inn = this.membership(col, c, v, what, depth);
        return o === "in" ? inn : bool("NOT_EXPR", [inn]);
      }
      default: {
        if (v === null) throw invalid(`${what} cannot compare with null.`);
        return op({ gt: ">", gte: ">=", lt: "<", lte: "<=" }[o]!, col, this.val(c.type, v, what));
      }
    }
  }

  private membership(col: N, c: Column, v: unknown, what: string, depth: number): N {
    if (Array.isArray(v)) {
      if (!v.length) throw invalid(`${what} takes a non-empty array.`);
      for (const item of v) if (item === null) throw invalid(`${what} cannot contain null; use isNull.`);
      return { A_Expr: { kind: "AEXPR_IN", name: [S("=")], lexpr: col, rexpr: { List: { items: v.map((item) => this.val(c.type, item, what)) } } } };
    }
    if (typeof v !== "object" || v === null) throw invalid("'in' / 'notIn' take an array or a { select, from, where } subquery.");
    const sub = v as { select?: unknown; from?: unknown; where?: StoreWhere };
    const bad = Object.keys(sub).find((k) => !["select", "from", "where"].includes(k));
    if (bad) throw invalid(`Unknown subquery key '${bad}'.`);
    const inner = this.schema(sub.from);
    const sel = this.column(inner.def, sub.select, "a subquery select", true);
    if (Object.hasOwn(sub, "where") && sub.where === undefined) throw invalid("Subquery where is undefined; omit it or provide a condition.");
    return { SubLink: { subLinkType: "ANY_SUBLINK", testexpr: col, subselect: { SelectStmt: {
      targetList: [target(ref(sel.col))], fromClause: [{ RangeVar: table(inner.name) }],
      ...(sub.where === undefined ? {} : { whereClause: this.where(sub.where, inner.def, depth + 1) }), ...SELECT } } } };
  }

  /** `mantle.search` over the declared search fields, or the id itself: the dialect lowers the first (D1: FTS5 trigram). */
  private search(text: unknown, name: string, def: StoreSchema): N {
    if (typeof text !== "string" || !text.trim()) throw invalid("Store search takes a non-empty string.");
    const id = op("=", ref("id"), this.val("text", text, "search"));
    if (!def.search?.length) return id;
    const call: N = { FuncCall: { funcname: [S("mantle"), S("search")], args: [ref(name), this.val("text", text, "search")], funcformat: "COERCE_EXPLICIT_CALL" } };
    return bool("OR_EXPR", [call, id]);
  }

  /** A select: the projection names every output column, so it can be paged. */
  select(q: StoreSelect): { ir: N; columns: readonly Column[]; order: { column: Column; dir: "asc" | "desc" }; pageSize: number; from: string } {
    if (typeof q !== "object" || q === null || Array.isArray(q)) throw invalid("Store select takes an object.");
    const bad = Object.keys(q).find((k) => !["from", "columns", "where", "orderBy", "limit", "cursor", "search"].includes(k));
    if (bad) throw invalid(`Unknown Store select key '${bad}'.`);
    if (Object.hasOwn(q, "where") && q.where === undefined) throw invalid("Store where is undefined; omit it or provide a condition.");
    const { name, def } = this.schema(q.from);
    if (q.columns !== undefined && (!Array.isArray(q.columns) || !q.columns.length)) throw invalid("Store columns takes a non-empty array.");
    const columns = q.columns
      ? [...new Set(q.columns)].map((c) => this.column(def, c, "columns", false))
      : [...Object.keys(NATIVE).filter((n) => n !== "status" || def.publishing).map((n) => this.column(def, n, "columns", false)),
         ...Object.entries(def.fields).filter(([f]) => f !== def.scope).map(([f]) => this.column(def, def.names?.[f] ?? f, "columns", false))];
    const orderBy = q.orderBy ?? { updatedAt: "desc" };
    if (typeof orderBy !== "object" || Array.isArray(orderBy) || Object.keys(orderBy).length !== 1) throw invalid("Store orderBy takes exactly one column.");
    const [sortName, dir] = Object.entries(orderBy)[0]!;
    if (dir !== "asc" && dir !== "desc") throw invalid(`orderBy '${sortName}' must be 'asc' or 'desc'.`);
    const order = { column: this.column(def, sortName, "orderBy", true), dir };
    if (q.limit !== undefined && (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > 500)) throw invalid("Store limit must be an integer from 1 to 500.");
    if (q.cursor !== undefined && typeof q.cursor !== "string") throw invalid("Store cursor must be a string.");
    const where = [...(q.where === undefined ? [] : [this.where(q.where, def)]), ...(q.search === undefined ? [] : [this.search(q.search, name, def)])];
    const ir: N = { SelectStmt: {
      // a geo field is two columns, read under hidden names and joined back into `{ lat, lng }` by `geoValue`
      targetList: columns.flatMap((c) => (c.type === "geo" ? [target(ref(`${c.col}_lat`), geoKey(c.out, "lat")), target(ref(`${c.col}_lng`), geoKey(c.out, "lng"))] : [target(ref(c.col), c.out)])), fromClause: [{ RangeVar: table(name) }],
      ...(where.length ? { whereClause: where.length === 1 ? where[0] : bool("AND_EXPR", where) } : {}),
      sortClause: [{ SortBy: { node: ref(order.column.col), sortby_dir: dir === "asc" ? "SORTBY_ASC" : "SORTBY_DESC", sortby_nulls: "SORTBY_NULLS_DEFAULT" } }], ...SELECT } };
    return { ir, columns, order, pageSize: q.limit ?? 50, from: name };
  }

  /**
   * The IR of one write op, whether it is a row op, and the status an update moves the entry to. The class is the compiled statement's
   * (`classify`, the rule the runner and the CLI use), never a second reading of the JSON. Only a row op returns `id` and `version`
   * (an after hook gets the whole row through policy); a set op reports how many rows it touched.
   */
  write(o: StoreWriteOp): { ir: N; row: boolean; status?: string } {
    const built = this.statement(o);
    const row = classify(built.ir) === "row";
    if (row) {
      const body = built.ir.InsertStmt ?? built.ir.UpdateStmt ?? built.ir.DeleteStmt;
      body.returningClause = { exprs: [target(ref("id")), target(ref("version"))] };
    }
    return { ...built, row };
  }

  private statement(o: StoreWriteOp): { ir: N; status?: string } {
    if ("insert" in o) {
      const { name, def } = this.schema(o.insert);
      const filled = withDefaults(def, o.values);
      validateValues(def, filled, def.publishing ? "partial" : "full");
      const values = { ...filled, ...(o.id === undefined ? {} : { id: o.id }) };
      const cols = Object.entries(values).map(([k, v]) => ({ c: k === "id" ? { col: "id", type: "text", out: "id" } : this.column(def, k, "values", false), v }));
      const items = cols.flatMap(({ c, v }) => this.assign(c, v).map(([, x]) => x));
      const conflict = o.onConflict;
      let onConflictClause: N | undefined;
      if (conflict === "ignore") onConflictClause = { action: "ONCONFLICT_NOTHING" };
      else if (conflict) {
        validateValues(def, conflict.update, "partial");
        const set = Object.entries(conflict.update).flatMap(([k, v]) => this.assign(this.column(def, k, "onConflict.update", false), v).map(([col, x]) => target(x, col)));
        onConflictClause = { action: "ONCONFLICT_UPDATE",
          infer: { indexElems: conflict.columns.map((k) => ({ IndexElem: { name: this.column(def, k, "onConflict.columns", true).col, ordering: "SORTBY_DEFAULT", nulls_ordering: "SORTBY_NULLS_DEFAULT" } })) },
          targetList: set };
      }
      return { ir: { InsertStmt: { relation: table(name), cols: cols.flatMap(({ c }) => physical(c).map((col) => ({ ResTarget: { name: col } }))),
        selectStmt: { SelectStmt: { valuesLists: [{ List: { items } }], ...SELECT } },
        ...(onConflictClause ? { onConflictClause } : {}), override: "OVERRIDING_NOT_SET" } } };
    }
    if ("update" in o) {
      const { name, def } = this.schema(o.update);
      const { status, ...rest } = o.set as Record<string, unknown>;
      if (status !== undefined && (!def.publishing || !STATUSES.includes(status as string))) throw invalid(def.publishing ? `A status is one of ${STATUSES.join(", ")}.` : "This Schema has no status.");
      const set = Object.entries(rest);
      if (status !== undefined && set.length) throw invalid("A status change carries no other values: set the values first, then the status.");
      if (!set.length && status === undefined) throw invalid("An update sets at least one column.");
      validateValues(def, rest, "partial");
      return { status: status as string | undefined, ir: { UpdateStmt: { relation: table(name),
        targetList: set.flatMap(([k, v]) => this.assign(this.column(def, k, "set", false), v).map(([col, x]) => target(x, col))),
        whereClause: this.guarded(o.where, def, o.lock) } } };
    }
    const { name, def } = this.schema(o.delete);
    return { ir: { DeleteStmt: { relation: table(name), whereClause: this.guarded(o.where, def, o.lock) } } };
  }

  /** `where`, with `AND version = <lock>` when the caller observed a version (OCC). */
  private guarded(where: StoreWhere, def: StoreSchema, lock: number | undefined): N {
    const w = this.where(where, def);
    return lock === undefined ? w : bool("AND_EXPR", [w, op("=", ref("version"), this.val("integer", lock, "'lock'"))]);
  }
}
