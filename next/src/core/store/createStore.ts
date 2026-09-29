/**
 * MantleStore over a StoreExecutor (ADR-0032 decision 1). A Store call is validated, converted to IR
 * (`json.ts`), and run by the same runner as a manifest's Procedure or View, so policy, hooks and OCC
 * have one implementation.
 */
import { DiagnosticError, runtimeDiagnostic, SqlRefusal, type AuthorizationRequirements, type SqlNode as N } from "../../spec/index.js";
import type { Caller } from "../caller.js";
import type { InvocationCause } from "../invocation.js";
import type { CallerStore, MantleStore, StoreExecutor, StoreRow, StoreSelectResult, StoreWriteResult } from "../store.js";
import { decodeOutput } from "../sql/codec.js";
import type { BindContext, Mode } from "../sql/compile.js";
import { runProcedure, runView, type LifecycleHooks, type Program, type RunEnv } from "../sql/run.js";
import { evaluateAuthAll } from "../runtime/auth.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { StoreJson, validateValues, type StoreSchemas } from "./json.js";

/** A compiled View: its IR and declared input types. `public` shows published rows only (ADR-0032 decision 8). */
export interface StoreView {
  readonly ir: readonly N[];
  readonly inputs: Readonly<Record<string, string>>;
  readonly public?: boolean;
  /** Checked against a caller-bound Store (the host's own `runtime.store` is trusted and skips it). */
  readonly requires?: AuthorizationRequirements;
  /** The Procedure `requires.guard` names, run before the View on a caller-bound Store. */
  readonly guard?: string;
}

export interface StoreDeps {
  readonly executor: StoreExecutor;
  readonly schemas: StoreSchemas;
  readonly views: Readonly<Record<string, StoreView>>;
  readonly lifecycle?: LifecycleHooks;
  /** Microseconds since the epoch. */
  readonly now: () => number;
  readonly newId: () => string;
  /** Runs a View's guard Procedure with the View's input; the runtime supplies it (Store never references Procedures). */
  readonly guardView?: (procedure: string, caller: Caller, input: Readonly<Record<string, unknown>>, cause: InvocationCause) => Promise<void>;
}

const invalid = (message: string) => new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message }));

/** A refusal thrown while binding (a value the declared type cannot hold) is the caller's input error. */
async function guard<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof SqlRefusal) throw invalid(e.message);
    throw e;
  }
}

/** Decode what SQLite stores back to the declared JSON type (timestamps, dates, numerics, booleans, json). */
function decode(row: StoreRow, types: ReadonlyMap<string, string>): StoreRow {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, types.has(k) ? decodeOutput(types.get(k)!, v) : v]));
}

/** `caller` undefined is the host (trusted): no scope, TTL still applies. */
export function bindFor(now: number, caller: Caller | undefined): { mode: Mode; bind: BindContext } {
  if (!caller || caller.kind === "system") return { mode: "trusted", bind: { uid: caller ? `system:${caller.reason}` : null, now } };
  if (caller.kind === "anonymous") return { mode: "caller", bind: { uid: null, now } };
  return { mode: "caller", bind: { uid: caller.subject, now, role: caller.role } };
}

/** `parent` is the invocation this Store serves: hooks it fires chain to it, so the depth limit and cause ids hold across writes. */
function make(deps: StoreDeps, caller: Caller | undefined, parent?: InvocationCause): CallerStore {
  const env = (mode: Mode): RunEnv => ({ executor: deps.executor, schemas: deps.schemas, mode, lifecycle: deps.lifecycle });
  let writes = 0;
  const as = (bound: BindContext) => ({
    bind: bound,
    ...(parent ? { seq: `${parent.id}#${++writes}` } : {}),
    caller: caller ?? ({ kind: "system", reason: "host" } as const),
    cause: parent ?? ({ kind: "internal", id: `store:${deps.newId()}` } as const),
  });

  return {
    select: (q) => guard(async (): Promise<StoreSelectResult> => {
      const json = new StoreJson(deps.schemas);
      const s = json.select(q);
      const binding = `${s.from}:${s.order.column.col}:${s.order.dir}`;
      const { mode, bind: b } = bindFor(deps.now(), caller);
      const cursor = q.cursor === undefined ? undefined : decodeCursor(binding, q.cursor);
      const program: Program = { kind: "view", inputs: json.inputs, ir: [s.ir] };
      const page = await runView(env(mode), program, as({ ...b, input: json.values }), { pageSize: s.pageSize, ...(cursor ? { cursor } : {}) });
      const types = new Map(s.columns.map((c) => [c.out, c.type]));
      return { rows: page.rows.map((r) => decode(r, types)), ...(page.next ? { nextCursor: encodeCursor(binding, page.next) } : {}) };
    }),

    write: (ops) => guard(async (): Promise<readonly StoreWriteResult[]> => {
      if (!Array.isArray(ops) || !ops.length) throw invalid("A write takes a non-empty list of operations.");
      const json = new StoreJson(deps.schemas, (schema) => [...(deps.lifecycle?.after ?? [])].some((k) => k.startsWith(`${schema}.`)));
      const built = ops.map((o) => json.write(o));
      const { mode, bind: b } = bindFor(deps.now(), caller);
      const program: Program = {
        kind: "procedure", inputs: json.inputs, ir: built.map((x) => x.ir), expects: ops.map((o) => (o as { expect?: number }).expect),
        statuses: built.map((x) => x.status),
        // a publish must leave a complete entry: checked on the entry the lifecycle read, so it is the one the statement locks
        checks: ops.map((o, i) => {
          if (built[i]!.status !== "published" || !("update" in o)) return undefined;
          const def = deps.schemas[o.update.toLowerCase()]!;
          return (current: StoreRow) => {
            // the row carries lower-cased columns in the database's encoding; the JSON Schema names them as declared
            const entry = Object.fromEntries(Object.entries(current).filter(([k, v]) => def.fields[k] && v !== null).map(([k, v]) => [def.names?.[k] ?? k, decodeOutput(def.fields[k]!, v)]));
            validateValues(def, { ...entry, ...Object.fromEntries(Object.entries(o.set).filter(([k]) => k !== "status")) }, "full");
          };
        }),
      };
      let result;
      try {
        result = await runProcedure(env(mode), program, as({ ...b, input: json.values }));
      } catch (e) {
        throw await refine(e, ops);
      }
      return ops.map((o, i) => {
        const row = StoreJson.isRowOp(o) ? result.rows[i]![0] : undefined;
        if (row) return { id: String(row.id), version: Number(row.version) };
        return { affected: result.affected[i]! };
      });
    }),

    view: (name, options = {}) => guard(async () => {
      const v = deps.views[name];
      if (!v) throw invalid(`Unknown View '${name}'.`);
      const denial = caller && evaluateAuthAll(v.requires, caller, `manifest:View/${name}`);
      if (denial) throw new DiagnosticError(denial);
      if (caller && v.guard) await deps.guardView?.(v.guard, caller, options.input ?? {}, parent ?? { kind: "internal", id: `store:${deps.newId()}` });
      const limit = options.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw invalid("View limit must be an integer from 1 to 500.");
      const { mode, bind: b } = bindFor(deps.now(), caller);
      const cursor = options.cursor === undefined ? undefined : decodeCursor(`view:${name}`, options.cursor);
      const page = await runView(env(v.public ? "public" : mode), { kind: "view", inputs: v.inputs, ir: v.ir }, as({ ...b, input: options.input ?? {} }), { pageSize: limit, ...(cursor ? { cursor } : {}) });
      return { rows: page.rows as never, ...(page.next ? { nextCursor: encodeCursor(`view:${name}`, page.next) } : {}) };
    }),

    id: deps.newId,
  };

  /** A row op that matched nothing is `lock` when the row is visible at another version, `expect` otherwise (ADR-0032 decision 2). */
  async function refine(e: unknown, ops: readonly import("../store.js").StoreWriteOp[]): Promise<unknown> {
    if (!(e instanceof DiagnosticError) || e.diagnostic.conflict?.reason !== "expect") return e;
    const i = e.diagnostic.conflict.opIndex;
    const op = i === undefined ? undefined : ops[i];
    if (!op || !("update" in op || "delete" in op) || op.lock === undefined) return e;
    const from = "update" in op ? op.update : op.delete;
    const id = (op.where as { id?: unknown }).id;
    const [row] = (await make(deps, caller).select({ from, columns: ["version"], where: { id: (typeof id === "object" ? (id as { eq: string }).eq : id) as string }, limit: 1 })).rows;
    if (!row || row.version === op.lock) return e;
    return new DiagnosticError(runtimeDiagnostic({ code: "CONFLICT", severity: "error", path: "store", message: e.message, conflict: { opIndex: i!, reason: "lock" } }));
  }
}

export function createStore(deps: StoreDeps): MantleStore {
  return {
    ...make(deps, undefined),
    as: (caller, cause) => make(deps, caller, cause),
    sweepExpired: (request) => sweepExpired(deps, request),
  };
}

// ---- TTL sweep ---------------------------------------------------------------------------------------------------
const S = (s: string) => ({ String: { sval: s } });
const ref = (...f: string[]): N => ({ ColumnRef: { fields: f.map(S) } });

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
  const after = request.cursor === undefined ? undefined : Number(decodeCursor(`sweep:${name}`, request.cursor)[0]);
  const rel = (): N => ({ RangeVar: { relname: name, inh: true, relpersistence: "p", mantle: "system" } });
  const num = (n: number): N => ({ A_Const: { ival: { ival: n } } });
  const op = (o: string, l: N, r: N): N => ({ A_Expr: { kind: "AEXPR_OP", name: [S(o)], lexpr: l, rexpr: r } });
  const expired = (): N => ({ BoolExpr: { boolop: "AND_EXPR", args: [
    { NullTest: { arg: ref(def.ttl!), nulltesttype: "IS_NOT_NULL" } }, op("<=", ref(def.ttl!), { ParamRef: { number: 1 } }),
    ...(after === undefined ? [] : [op(">", ref("_rid"), num(after))]),
  ] } });
  const pick = (): N => ({ SelectStmt: { targetList: [{ ResTarget: { val: ref("_rid") } }], fromClause: [rel()], whereClause: expired(),
    sortClause: [{ SortBy: { node: ref("_rid"), sortby_dir: "SORTBY_ASC", sortby_nulls: "SORTBY_NULLS_DEFAULT" } }],
    limitCount: num(limit), limitOption: "LIMIT_OPTION_COUNT", op: "SETOP_NONE" } });
  const binds = [deps.now() - def.ttlSeconds * 1_000_000];
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
