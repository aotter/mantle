/**
 * Running a compiled program: a Procedure is one all-or-nothing batch with lifecycle hooks around it,
 * a View is one read with keyset paging (ADR-0032 decisions 2 and 3, ADR-0034 decision 4). Store and
 * `invokeProcedure` both run through here; nothing else reaches the executor.
 */
import { DiagnosticError, runtimeDiagnostic, type SqlNode as N } from "../../spec/index.js";
import type { Caller } from "../caller.js";
import type { InvocationCause, LifecycleDispatcher } from "../invocation.js";
import type { StoreExecutor, StoreRow } from "../store.js";
import { bindValues, compileProgram, type BindContext, type CompileContext } from "./compile.js";
import { applyPolicy, HIDDEN_ID, HIDDEN_VERSION, type BindSpec, type Compiled } from "./policy.js";

export interface Program {
  readonly kind: "view" | "procedure";
  readonly inputs: Readonly<Record<string, string>>;
  readonly ir: readonly N[];
}

/** Which (schema, operation) pairs have a lifecycle Trigger, as `schema.insert|update|delete` keys. */
export interface LifecycleHooks {
  readonly dispatcher: LifecycleDispatcher;
  readonly before: ReadonlySet<string>;
  readonly after: ReadonlySet<string>;
}

export interface RunEnv extends Pick<CompileContext, "schemas" | "mode" | "seen"> {
  readonly executor: StoreExecutor;
  readonly lifecycle?: LifecycleHooks;
  /** NEGATIVE CONTROL ONLY: print no visibility predicate, so a probe that cannot fail is caught. */
  readonly unsafeNoVisibility?: boolean;
}

/** Who runs it: hooks run with the originating caller and chain `cause` as their parent. */
export interface RunAs {
  readonly caller: Caller;
  readonly cause: InvocationCause;
  readonly bind: BindContext;
}

const refuse = (message: string) => new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message }));
const conflict = (opIndex: number) => new DiagnosticError(runtimeDiagnostic({ code: "CONFLICT", severity: "error", path: "store", message: `CONFLICT op=${opIndex}`, conflict: { opIndex, reason: "expect" } }));

const ctxOf = (env: RunEnv, p: Program, extra: Partial<CompileContext> = {}): CompileContext => ({
  schemas: env.schemas, inputs: p.inputs, kind: p.kind, mode: env.mode, seen: env.seen, unsafeNoVisibility: env.unsafeNoVisibility, ...extra,
});

const S = (s: string) => ({ String: { sval: s } });
const ref = (...f: string[]): N => ({ ColumnRef: { fields: f.map(S) } });
const select = (targetList: N[], from?: N, where?: N): N => ({
  SelectStmt: { targetList, ...(from ? { fromClause: [from] } : {}), ...(where ? { whereClause: where } : {}), limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" },
});

function conjuncts(w: N | undefined): N[] {
  return w?.BoolExpr?.boolop === "AND_EXPR" ? w.BoolExpr.args.flatMap(conjuncts) : w ? [w] : [];
}
/** The scalar of the `id = <scalar>` conjunct that makes a statement a row op. */
function idOf(stmt: N): N {
  for (const x of conjuncts((stmt.UpdateStmt ?? stmt.DeleteStmt).whereClause)) {
    const e = x.A_Expr;
    if (e?.kind !== "AEXPR_OP" || e.name[0].String.sval !== "=") continue;
    if (e.lexpr.ColumnRef?.fields.at(-1)?.String?.sval === "id") return e.rexpr;
    if (e.rexpr.ColumnRef?.fields.at(-1)?.String?.sval === "id") return e.lexpr;
  }
  throw new Error("not a row op");
}

const key = (schema: string | undefined, verb: string | undefined) => `${schema}.${verb}`;
const HOOK = { insert: "create", update: "update", delete: "delete" } as const;

/** The row a before hook sees: the visible current row of an update or delete, or the values an insert supplies. */
async function beforeRow(env: RunEnv, p: Program, i: number, c: Compiled, as: RunAs): Promise<StoreRow> {
  const stmt = p.ir[i]!;
  let read: N;
  if (c.verb === "insert") {
    const cols: N[] = stmt.InsertStmt.cols;
    const values: N[] = stmt.InsertStmt.selectStmt.SelectStmt.valuesLists[0].List.items;
    read = select(values.map((val, k) => ({ ResTarget: { name: cols[k]!.ResTarget.name, val } })));
  } else {
    const t = (f: string) => ref("t", f);
    read = select(
      [{ ResTarget: { val: ref("t", "id") } }, { ResTarget: { val: ref("t", "version") } }, { ResTarget: { val: { ColumnRef: { fields: [S("t"), { A_Star: {} }] } } } }],
      { RangeVar: { relname: c.schema, alias: { aliasname: "t" }, inh: true, relpersistence: "p", mantle: "table" } },
      { A_Expr: { kind: "AEXPR_OP", name: [S("=")], lexpr: t("id"), rexpr: idOf(stmt) } },
    );
  }
  const rc = applyPolicy(read, { schemas: env.schemas, inputs: p.inputs, mode: env.mode, seen: env.seen, unsafeNoVisibility: env.unsafeNoVisibility });
  const [row] = await env.executor.select({ ir: rc.ast, binds: bindValues(rc.binds, as.bind) });
  if (c.verb !== "insert" && !row) throw conflict(i); // no visible row: fail closed, and the hook never learns whether it exists
  return row ?? {};
}

const strip = (row: StoreRow): StoreRow => Object.fromEntries(Object.entries(row).filter(([k]) => k !== HIDDEN_ID && k !== HIDDEN_VERSION));

/** A Procedure: before hooks (row ops only), one batch applied in order and all or nothing, then after hooks. */
export async function runProcedure(env: RunEnv, p: Program, as: RunAs): Promise<{ readonly rows: readonly (readonly StoreRow[])[]; readonly affected: readonly number[] }> {
  const lc = env.lifecycle;
  const afterSchemas = new Set([...(lc?.after ?? [])].map((k) => k.split(".")[0]!));
  const base = ctxOf(env, p, { returning: afterSchemas });
  const plan = compileProgram(p.ir, base);
  const versions: Record<number, unknown> = {};
  const event = (i: number, hook: string, schema: string, rows: [StoreRow, ...StoreRow[]]) => ({
    id: `${as.cause.id}:${i}:${hook}`, schema, hook: hook as never, rows, caller: as.caller, parent: as.cause,
  });

  for (const [i, c] of plan.entries()) {
    if (!lc || !c.schema || !c.verb || !lc.before.has(key(c.schema, c.verb))) continue;
    if (c.kind !== "row") throw refuse(`SQL_SHAPE: a set op on ${c.schema} is refused: ${c.schema} has a before ${c.verb} hook, and before hooks take row ops only`);
    const row = await beforeRow(env, p, i, c, as);
    await lc.dispatcher.before([event(i, `before_${HOOK[c.verb]}`, c.schema, [row])]);
    versions[i] = row.version;
    if (c.verb !== "insert") plan[i] = compileProgram([p.ir[i]!], { ...base, lockVersion: true })[0]!; // the statement carries the version the hook saw
  }

  const res = await env.executor.apply(plan.map((c, i) => ({
    ir: c.ast,
    binds: bindValues(c.binds, as.bind, { version: versions[i] }),
    // a row op must affect exactly one row
    ...(c.kind === "row" ? { expect: 1 } : {}),
  })));

  const rows = res.map((r, i) => (plan[i]!.hooked ? r.rows.map(strip) : r.rows));
  if (lc) for (const [i, c] of plan.entries()) {
    if (!c.schema || !c.verb || !lc.after.has(key(c.schema, c.verb)) || !res[i]!.rows.length) continue; // a statement that writes no row calls no hook
    const cause = res[i]!.rows.map((row) => ({ ...strip(row), id: row[HIDDEN_ID], version: row[HIDDEN_VERSION] })) as unknown as [StoreRow, ...StoreRow[]];
    // a failure of an after hook never changes the committed result (ADR-0032 decision 3); the dispatcher reports its own failures
    await lc.dispatcher.after([event(i, `after_${HOOK[c.verb]}`, c.schema, cause)]).catch(() => undefined);
  }
  return { rows, affected: res.map((r) => r.affected) };
}

// ---- Views and cursors --------------------------------------------------------------------------------
const outName = (t: N) => t.ResTarget.name ?? t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.String?.sval;

export interface ViewPage {
  readonly rows: readonly StoreRow[];
  /** The last row's sort keys; the caller encodes them into the one opaque cursor. */
  readonly next?: readonly unknown[];
}

/**
 * Keyset pagination over a View. The sort keys (the author's plus the compiler's appended id or group key)
 * become hidden `_k<i>` columns; the cursor is the last row's keys and the next page filters on them.
 * Keys must be non-null (a nullable key states its NULL position; not implemented).
 */
export async function runView(env: RunEnv, p: Program, as: RunAs, opts: { cursor?: readonly unknown[]; pageSize?: number } = {}): Promise<ViewPage> {
  const [c] = compileProgram(p.ir, ctxOf(env, p));
  if (!opts.pageSize) return { rows: await env.executor.select({ ir: c!.ast, binds: bindValues(c!.binds, as.bind) }) };
  const sel = structuredClone(c!.ast.SelectStmt) as N;
  const keys: N[] = sel.sortClause;
  if (!keys?.length) throw refuse("SQL_SHAPE: a cursor needs an ORDER BY");
  const visible: string[] = sel.targetList.map(outName);
  if (visible.some((n) => !n)) throw refuse("SQL_SHAPE: a paged View names every output column");
  const aliasVal = new Map<string, N>(sel.targetList.map((t: N) => [outName(t), t.ResTarget.val]));
  const hidden = keys.map((k, i) => {
    const node = k.SortBy.node;
    const f = node.ColumnRef?.fields;
    const val = f?.length === 1 && aliasVal.has(f[0].String.sval) ? aliasVal.get(f[0].String.sval)! : node; // an ORDER BY alias is its select-list expression
    return { ResTarget: { name: `_k${i}`, val } };
  });
  const inner: N = { ...sel, targetList: [...sel.targetList, ...hidden], sortClause: undefined, limitCount: undefined, limitOption: "LIMIT_OPTION_DEFAULT" };
  const base = c!.binds.length;
  const cursorBinds: BindSpec[] = opts.cursor ? keys.map((_k, i) => ({ k: "cursor", i })) : [];
  const col = (n: string): N => ref("_p", n);
  const op = (o: string, l: N, r: N): N => ({ A_Expr: { kind: "AEXPR_OP", name: [S(o)], lexpr: l, rexpr: r } });
  const after = opts.cursor
    ? { BoolExpr: { boolop: "OR_EXPR", args: keys.map((k, i) => ({ BoolExpr: { boolop: "AND_EXPR", args: [
        ...keys.slice(0, i).map((_x, j) => op("=", col(`_k${j}`), { ParamRef: { number: base + j + 1 } })),
        op(k.SortBy.sortby_dir === "SORTBY_DESC" ? "<" : ">", col(`_k${i}`), { ParamRef: { number: base + i + 1 } }),
      ] } })) } }
    : undefined;
  const outer: N = { SelectStmt: {
    targetList: [...visible.map((n) => ({ ResTarget: { val: col(n), name: n } })), ...keys.map((_k, i) => ({ ResTarget: { val: col(`_k${i}`), name: `_k${i}` } }))],
    fromClause: [{ RangeSubselect: { subquery: { SelectStmt: inner }, alias: { aliasname: "_p" } } }],
    whereClause: after,
    sortClause: keys.map((k, i) => ({ SortBy: { node: col(`_k${i}`), sortby_dir: k.SortBy.sortby_dir, sortby_nulls: k.SortBy.sortby_nulls } })),
    limitCount: { A_Const: { ival: { ival: opts.pageSize + 1 } } }, limitOption: "LIMIT_OPTION_COUNT", op: "SETOP_NONE" } };
  const rows = await env.executor.select({ ir: outer, binds: bindValues([...c!.binds, ...cursorBinds], as.bind, { cursor: opts.cursor }) });
  const page = rows.slice(0, opts.pageSize);
  const next = rows.length > opts.pageSize ? keys.map((_k, i) => page.at(-1)![`_k${i}`]) : undefined;
  return { rows: page.map((r) => Object.fromEntries(visible.map((n) => [n, r[n]]))), ...(next ? { next } : {}) };
}
