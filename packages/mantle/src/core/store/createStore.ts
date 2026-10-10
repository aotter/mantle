/**
 * MantleStore over a StoreExecutor (ADR-0032 decision 1). A Store call is validated, converted to IR
 * (`json.ts`), and run by the same runner as a manifest's Procedure or View, so policy, hooks and OCC
 * have one implementation.
 */
import { DiagnosticError, runtimeDiagnostic } from "../../spec/kernel/index.js";
import { firstZodIssueAsJsonPointer, jsonSchemaToZod, safeParseJson, NATIVE_OUTPUT_TYPES, SqlRefusal, type AuthorizationRequirements, type JsonSchema, type SqlNode as N } from "../../spec/domain/index.js";
import type { Caller } from "../caller.js";
import type { InvocationCause } from "../invocation.js";
import type { CallerStore, MantleStore, StoreExecutor, StoreRow, StoreSelectResult, StoreViewOptions, StoreWriteResult } from "../store.js";
import type { MantleDialect } from "../dialect.js";
import { sqlInput, type BindContext, type Mode } from "../sql/compile.js";
import { num, op, ref, table } from "../sql/ast.js";
import { VIEW_PAGE_SIZE, runProcedure, runView, type LifecycleHooks, type Program, type RunEnv, type ViewMatch } from "../sql/run.js";
import { evaluateAuthAll } from "../runtime/auth.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { StoreJson, decodeRow, validateValues, type StoreSchemas } from "./json.js";

/** A compiled View: its IR and declared input types. `public` shows published rows only (ADR-0032 decision 8). */
export interface StoreView {
  readonly ir: readonly N[];
  readonly inputs: Readonly<Record<string, string>>;
  /** The View's input JSON Schema: a call's input is checked against it (required, unknown keys, types) before it runs. */
  readonly input?: JsonSchema;
  readonly public?: boolean;
  /** Checked against a caller-bound Store (the host's own `runtime.store` is trusted and skips it). */
  readonly requires?: AuthorizationRequirements;
  /** The Procedure `requires.guard` names, run before the View on a caller-bound Store. */
  readonly guard?: string;
  /** Outputs that read a Schema field unchanged: decoded and named as `select` returns them. */
  readonly columns?: Readonly<Record<string, { readonly schema: string; readonly field: string }>>;
  /** `uiSchema.list.searchFields` and `filterFields`: the outputs `search` and `filters` may match (ADR-0032 decision 5). */
  readonly searchFields?: readonly string[];
  readonly filterFields?: readonly string[];
}

export interface StoreDeps {
  readonly executor: StoreExecutor;
  readonly dialect: MantleDialect;
  readonly schemas: StoreSchemas;
  readonly views: Readonly<Record<string, StoreView>>;
  readonly lifecycle?: LifecycleHooks;
  /** Microseconds since the epoch. */
  readonly now: () => number;
  readonly newId: () => string;
  /** Runs a View's guard Procedure with the View's input; the runtime supplies it (Store never references Procedures). */
  readonly guardView?: (procedure: string, caller: Caller, input: Readonly<Record<string, unknown>>, cause: InvocationCause) => Promise<void>;
}

const viewInputs = new WeakMap<StoreView, ReturnType<typeof jsonSchemaToZod>>();
const invalid = (message: string) => new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message }));

/** `search` and `filters` as the View declares them; a filter on an output the View did not declare is refused. */
function viewMatch(name: string, v: StoreView, options: StoreViewOptions, encode: (column: string, value: unknown) => unknown): ViewMatch | undefined {
  const search = options.search?.trim();
  const filters = Object.entries(options.filters ?? {});
  if (search && !v.searchFields?.length) throw invalid(`View '${name}' declares no uiSchema.list.searchFields to search.`);
  const undeclared = filters.find(([f]) => !v.filterFields?.includes(f));
  if (undeclared) throw invalid(`View '${name}' has no filter '${undeclared[0]}'; its uiSchema.list.filterFields are ${JSON.stringify(v.filterFields ?? [])}.`);
  if (!search && !filters.length) return undefined;
  return { ...(search ? { search: { columns: v.searchFields!, text: search } } : {}), eq: filters.map(([column, value]) => ({ column, value: encode(column, value) })) };
}

/** A refusal thrown while binding (a value the declared type cannot hold) is the caller's input error. */
async function guard<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof SqlRefusal) throw invalid(e.message);
    throw e;
  }
}

/** `caller` undefined is the host (trusted): no scope, TTL still applies. */
export function bindFor(now: number, caller: Caller | undefined): { mode: Mode; bind: BindContext } {
  if (!caller || caller.kind === "system") return { mode: "trusted", bind: { uid: caller ? `system:${caller.reason}` : null, now } };
  if (caller.kind === "anonymous") return { mode: "caller", bind: { uid: null, now } };
  return { mode: "caller", bind: { uid: caller.subject, now, role: caller.role } };
}

/** `parent` is the invocation this Store serves: hooks it fires chain to it, so the depth limit and cause ids hold across writes. */
function make(deps: StoreDeps, caller: Caller | undefined, parent?: InvocationCause): CallerStore {
  const env = (mode: Mode): RunEnv => ({ executor: deps.executor, dialect: deps.dialect, schemas: deps.schemas, mode, lifecycle: deps.lifecycle });
  let writes = 0;
  const as = (bound: BindContext) => ({
    bind: bound,
    ...(parent ? { seq: `${parent.id}#${++writes}` } : {}),
    caller: caller ?? ({ kind: "system", reason: "host" } as const),
    cause: parent ?? ({ kind: "internal", id: `store:${deps.newId()}` } as const),
  });

  return {
    select: (q) => guard(async (): Promise<StoreSelectResult> => {
      const json = new StoreJson(deps.schemas, deps.dialect.codec);
      const s = json.select(q);
      const binding = `${s.from}:${s.order.column.col}:${s.order.dir}`;
      const { mode, bind: b } = bindFor(deps.now(), caller);
      const cursor = q.cursor === undefined ? undefined : decodeCursor(binding, q.cursor);
      const program: Program = { kind: "view", inputs: json.inputs, ir: [s.ir] };
      const page = await runView(env(mode), program, as({ ...b, input: json.values }), { pageSize: s.pageSize, ...(cursor ? { cursor } : {}) });
      return { rows: page.rows.map((r) => decodeRow(r, s.columns, deps.dialect.codec)), ...(page.next ? { nextCursor: encodeCursor(binding, page.next) } : {}) };
    }),

    write: (ops) => guard(async (): Promise<readonly StoreWriteResult[]> => {
      if (!Array.isArray(ops) || !ops.length) throw invalid("A write takes a non-empty list of operations.");
      const json = new StoreJson(deps.schemas, deps.dialect.codec);
      const built = ops.map((o) => json.write(o));
      // the parent is read before the batch, so one write may not publish a translation and move its parent too
      built.forEach((x, i) => {
        const o = ops[i]!;
        const tr = x.status === "published" && "update" in o ? deps.schemas[o.update.toLowerCase()]?.translates : undefined;
        if (tr && ops.some((y) => "update" in y && y.update.toLowerCase() === tr.parent.toLowerCase() && "status" in y.set))
          throw invalid(`A write that publishes a translation may not also change the status of its ${tr.parent} parent: do that in its own write.`);
      });
      const { mode, bind: b } = bindFor(deps.now(), caller);
      const program: Program = {
        kind: "procedure", inputs: json.inputs, ir: built.map((x) => x.ir), expects: ops.map((o) => (o as { expect?: number }).expect),
        statuses: built.map((x) => x.status),
        // a publish must leave a complete entry: checked on the entry the lifecycle read, so it is the one the statement locks
        checks: ops.map((o, i) => {
          if (built[i]!.status !== "published" || !("update" in o)) return undefined;
          const def = deps.schemas[o.update.toLowerCase()]!;
          return async (current: StoreRow) => {
            // the row carries lower-cased columns in the database's encoding; the JSON Schema names them as declared
            const props = def.schema?.properties ?? {};
            const nullable = (name: string) => [props[name]?.type].flat().includes("null");
            const entry: Record<string, unknown> = {};
            for (const [k, type] of Object.entries(def.fields)) {
              const name = def.names?.[k] ?? k;
              if (type === "geo") { if (current[`${k}_lat`] != null && current[`${k}_lng`] != null) entry[name] = { lat: current[`${k}_lat`], lng: current[`${k}_lng`] }; continue; }
              const v = current[k];
              if (v !== null && v !== undefined) entry[name] = deps.dialect.codec.decode(type, v);
              else if (v === null && nullable(name)) entry[name] = null; // a NULL is "absent" unless the field says null is a value
            }
            validateValues(def, { ...entry, ...Object.fromEntries(Object.entries(o.set).filter(([k]) => k !== "status")) }, "full");
            if (def.translates) {
              const { parent: parentSchema, on } = def.translates;
              const key = entry[on];
              // the parent counts when any entry sharing the key is published (nothing makes `on` unique on the parent)
              const found = key === undefined ? [] : (await make(deps, caller, parent).select({ from: parentSchema, columns: ["id"], where: { [on]: key as string, status: "published" }, limit: 1 })).rows;
              if (!found.length)
                throw new DiagnosticError(runtimeDiagnostic({ code: "CONFLICT", severity: "error", path: "store", message: `CONFLICT: publish the ${parentSchema} entry with the same ${on} first; a translation publishes only after its parent.` }));
            }
          };
        }),
      };
      const result = await runProcedure(env(mode), program, as({ ...b, input: json.values }));
      return ops.map((_o, i) => {
        const row = built[i]!.row ? result.rows[i]![0] : undefined;
        if (row) return { id: String(row.id), version: Number(row.version) };
        return { affected: result.affected[i]! };
      });
    }),

    view: (name, options = {}) => guard(async () => {
      const v = Object.hasOwn(deps.views, name) ? deps.views[name] : undefined;
      if (!v) throw invalid(`Unknown View '${name}'.`);
      const denial = caller && evaluateAuthAll(v.requires, caller, `manifest:View/${name}`);
      if (denial) throw new DiagnosticError(denial);
      // the input as its schema reads it (defaults filled), as a Procedure binds it
      let input: unknown = options.input;
      if (v.input) {
        let z = viewInputs.get(v);
        if (!z) viewInputs.set(v, (z = jsonSchemaToZod(v.input)));
        const r = safeParseJson(z, options.input ?? {});
        if (!r.success) {
          const { instancePath, message } = firstZodIssueAsJsonPointer(r.error);
          throw invalid(`View '${name}' input does not match its schema${instancePath ? ` at ${instancePath}` : ""}: ${message}`);
        }
        input = r.data;
      }
      if (caller && v.guard) await deps.guardView?.(v.guard, caller, (input ?? {}) as Readonly<Record<string, unknown>>, parent ?? { kind: "internal", id: `store:${deps.newId()}` });
      const limit = options.limit ?? VIEW_PAGE_SIZE;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw invalid("View limit must be an integer from 1 to 500.");
      const { mode, bind: b } = bindFor(deps.now(), caller);
      const cursor = options.cursor === undefined ? undefined : decodeCursor(`view:${name}`, options.cursor);
      const page = await runView(env(v.public ? "public" : mode), { kind: "view", inputs: v.inputs, ir: v.ir }, as({ ...b, input: sqlInput(v.input, input) }), { pageSize: limit, ...(cursor ? { cursor } : {}), match: viewMatch(name, v, options, (column, value) => {
        // an output that reads a Schema field compares in that field's storage encoding (a boolean is 0/1, a date-time microseconds)
        const c = v.columns?.[column] ?? v.columns?.[column.toLowerCase()];
        const def = c && deps.schemas[c.schema];
        return def ? deps.dialect.codec.encode((Object.hasOwn(def.fields, c.field) ? def.fields[c.field] : NATIVE_OUTPUT_TYPES[c.field])!, value) : value;
      }) });
      const decodeView = (row: StoreRow) => Object.fromEntries(Object.entries(row).map(([k, value]) => {
        const c = v.columns && Object.hasOwn(v.columns, k) ? v.columns[k]! : undefined;
        const def = c && deps.schemas[c.schema];
        return def ? [k === c.field ? def.names?.[c.field] ?? k : k, deps.dialect.codec.decode((Object.hasOwn(def.fields, c.field) ? def.fields[c.field] : NATIVE_OUTPUT_TYPES[c.field])!, value)] : [k, value];
      }));
      return { rows: (v.columns ? page.rows.map(decodeView) : page.rows) as never, ...(page.next ? { nextCursor: encodeCursor(`view:${name}`, page.next) } : {}) };
    }),

    id: deps.newId,
  };
}

const causeBindings = new WeakMap<MantleStore, (cause: InvocationCause) => CallerStore>();

/** Internal host binding: preserves the trusted Store's caller-free authorization semantics. */
export function bindStoreCause(store: MantleStore, cause: InvocationCause): CallerStore {
  return causeBindings.get(store)!(cause);
}

export function createStore(deps: StoreDeps): MantleStore {
  const store: MantleStore = {
    ...make(deps, undefined),
    as: (caller, cause) => make(deps, caller, cause),
    sweepExpired: (request) => sweepExpired(deps, request),
  };
  causeBindings.set(store, (cause) => make(deps, undefined, cause));
  return store;
}

// ---- TTL sweep ---------------------------------------------------------------------------------------------------

/**
 * Physical statements built by hand: the sweep is the one path that sees expired rows and addresses `_rid`, so it
 * skips the validator and the policy on purpose. It is host-only and touches only rows past their TTL.
 */
async function sweepExpired(deps: StoreDeps, request: import("../store.js").SweepExpiredRequest): Promise<import("../store.js").SweepExpiredResult> {
  const name = String(request.collection).toLowerCase();
  const def = deps.schemas[name];
  if (!def?.ttl || def.ttlSeconds === undefined) throw invalid(`Schema '${request.collection}' has no ttl.`);
  const limit = request.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw invalid("Sweep limit must be an integer from 1 to 500.");
  const after = request.cursor === undefined ? undefined : (decodeCursor(`sweep:${name}`, request.cursor)[0] as number);
  if (after !== undefined && !Number.isSafeInteger(after)) throw invalid("The cursor does not belong to this query.");
  const rel = (): N => ({ RangeVar: table(name, "system") });
  const expired = (): N => ({ BoolExpr: { boolop: "AND_EXPR", args: [
    { NullTest: { arg: ref(def.ttl!), nulltesttype: "IS_NOT_NULL" } }, op("<=", ref(def.ttl!), { ParamRef: { number: 1 } }),
    ...(after === undefined ? [] : [op(">", ref("_rid"), num(after))]),
  ] } });
  const pick = (): N => ({ SelectStmt: { targetList: [{ ResTarget: { val: ref("_rid") } }], fromClause: [rel()], whereClause: expired(),
    sortClause: [{ SortBy: { node: ref("_rid"), sortby_dir: "SORTBY_ASC", sortby_nulls: "SORTBY_NULLS_DEFAULT" } }],
    limitCount: num(limit), limitOption: "LIMIT_OPTION_COUNT", op: "SETOP_NONE" } });
  const binds = [deps.dialect.codec.encode("timestamptz", deps.now() - def.ttlSeconds * 1_000_000)];
  // Keep selected candidates separate from deleted rows: native triggers may suppress a DELETE,
  // so RETURNING alone cannot preserve scanned or the full-page candidate cursor.
  const statements = [{ ir: pick(), binds }];
  if (request.delete !== false) {
    statements.push({ ir: { DeleteStmt: { relation: rel().RangeVar, whereClause: { SubLink: { subLinkType: "ANY_SUBLINK", testexpr: ref("_rid"), subselect: pick() } } } }, binds });
  }
  const [scanned, deleted] = await deps.executor.apply(statements);
  const last = scanned!.rows.at(-1)?._rid;
  return {
    scanned: scanned!.rows.length,
    removed: deleted?.affected ?? 0,
    ...(scanned!.rows.length === limit && last !== undefined ? { nextCursor: encodeCursor(`sweep:${name}`, [last]) } : {}),
  };
}
