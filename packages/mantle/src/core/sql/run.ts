/**
 * Running a compiled program: a Procedure is one all-or-nothing batch with lifecycle hooks around it,
 * a View is one read with keyset paging (ADR-0032 decisions 2 and 3, ADR-0034 decision 4). Store and
 * `invokeProcedure` both run through here; nothing else reaches the executor.
 */
import { DiagnosticError, runtimeDiagnostic } from "../../spec/kernel/index.js";
import { decideLifecycleWrite, isIdCol, pinnedTarget, type ContentState, type SqlNode as N } from "../../spec/domain/index.js";
import type { Caller } from "../caller.js";
import type { InvocationCause, LifecycleDispatcher } from "../invocation.js";
import type { StoreExecutor, StoreRow } from "../store.js";
import { bindValues, compileProgram, type BindContext, type CompileContext } from "./compile.js";
import { S, op, ref } from "./ast.js";
import { applyPolicy, HIDDEN_ID, HIDDEN_VERSION, type BindSpec, type Compiled } from "./policy.js";

export interface Program {
  readonly kind: "view" | "procedure";
  readonly inputs: Readonly<Record<string, string>>;
  readonly ir: readonly N[];
  /** A write's own `expect` count, by statement; a row op without one must affect exactly one row. */
  readonly expects?: readonly (number | undefined)[];
  /** Per statement: the status an update moves the entry to. Only Store sets it; the lifecycle decides whether it is legal. */
  readonly statuses?: readonly (string | undefined)[];
  /** Per statement: called with the entry the lifecycle just read, before the write, to check the result (a publish must leave a complete entry). */
  readonly checks?: readonly (((current: StoreRow) => void | Promise<void>) | undefined)[];
}

/** Which (schema, operation) pairs have a lifecycle Trigger, as `schema.insert|update|delete` keys. */
export interface LifecycleHooks {
  readonly dispatcher: LifecycleDispatcher;
  readonly before: ReadonlySet<string>;
  readonly after: ReadonlySet<string>;
}

export interface RunEnv extends Pick<CompileContext, "dialect" | "schemas" | "mode" | "seen"> {
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
  /** Names one write within an invocation that writes several times, so event ids stay unique and stable. */
  readonly seq?: string;
}

const refuse = (message: string) => new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message }));
const conflict = (opIndex: number) => new DiagnosticError(runtimeDiagnostic({ code: "CONFLICT", severity: "error", path: "store", message: `CONFLICT op=${opIndex}`, conflict: { opIndex, reason: "expect" } }));

const ctxOf = (env: RunEnv, p: Program, extra: Partial<CompileContext> = {}): CompileContext => ({
  dialect: env.dialect, schemas: env.schemas, inputs: p.inputs, kind: p.kind, mode: env.mode, seen: env.seen, unsafeNoVisibility: env.unsafeNoVisibility, ...extra,
});

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
    if (isIdCol(e.lexpr)) return e.rexpr;
    if (isIdCol(e.rexpr)) return e.lexpr;
  }
  throw new Error("not a row op");
}

/** A publish fires publish hooks instead of update hooks; the key is `schema.<insert|update|delete|publish>`. */
const verbOf = (c: Compiled) => (c.publish ? "publish" : c.verb!);
const key = (c: Compiled) => `${c.schema}.${verbOf(c)}`;
const HOOK = { insert: "create", update: "update", delete: "delete", publish: "publish" } as const;
const NOT_ALLOWED = {
  transition: "that status change is not allowed from the entry's current status",
  "not-editable": "only a draft can be edited: unpublish or restore the entry first",
  "published-protected": "a published entry cannot be deleted: unpublish or archive it first",
} as const;

/** The row a before hook or the lifecycle sees: the visible current row of an update or delete, or the values an insert supplies. */
async function preRead(env: RunEnv, p: Program, i: number, c: Compiled, as: RunAs): Promise<StoreRow> {
  const stmt = p.ir[i]!;
  let read: N;
  if (c.verb === "insert") {
    const cols: N[] = stmt.InsertStmt.cols;
    const values: N[] = stmt.InsertStmt.selectStmt.SelectStmt.valuesLists[0].List.items;
    // the hook sees these values in a read of its own, so they must not depend on data that can change before the commit
    if (JSON.stringify(values).includes('"SubLink"')) throw refuse(`SQL_SHAPE: an insert into ${c.schema}, which has a before create hook, may not read data in its VALUES`);
    read = select(values.map((val, k) => ({ ResTarget: { name: cols[k]!.ResTarget.name, val } })));
  } else {
    const t = (f: string) => ref("t", f);
    read = select(
      [{ ResTarget: { val: ref("t", "id") } }, { ResTarget: { val: ref("t", "version") } }, ...(env.schemas[c.schema!]?.publishing ? [{ ResTarget: { val: ref("t", "status") } }] : []), { ResTarget: { val: { ColumnRef: { fields: [S("t"), { A_Star: {} }] } } } }],
      { RangeVar: { relname: c.schema, alias: { aliasname: "t" }, inh: true, relpersistence: "p", mantle: "table" } },
      { A_Expr: { kind: "AEXPR_OP", name: [S("=")], lexpr: t("id"), rexpr: idOf(stmt) } },
    );
  }
  const rc = applyPolicy(read, { schemas: env.schemas, inputs: p.inputs, mode: env.mode, seen: env.seen, unsafeNoVisibility: env.unsafeNoVisibility, lower: env.dialect.lowering });
  const [row] = await env.executor.select({ ir: rc.ast, binds: bindValues(env.dialect, rc.binds, as.bind) });
  if (c.verb !== "insert" && !row) throw conflict(i); // no visible row: fail closed, and the hook never learns whether it exists
  return row ?? {};
}

const strip = (row: StoreRow): StoreRow => Object.fromEntries(Object.entries(row).filter(([k]) => k !== HIDDEN_ID && k !== HIDDEN_VERSION));

/** A Procedure: before hooks (row ops only), one batch applied in order and all or nothing, then after hooks. */
export async function runProcedure(env: RunEnv, p: Program, as: RunAs): Promise<{ readonly rows: readonly (readonly StoreRow[])[]; readonly affected: readonly number[] }> {
  const lc = env.lifecycle;
  const afterSchemas = new Set([...(lc?.after ?? [])].map((k) => k.split(".")[0]!));
  const base = ctxOf(env, p, { returning: afterSchemas, statuses: p.statuses });
  const plan = compileProgram(p.ir, base);
  const versions: Record<number, unknown> = {};
  // a hook receives the entry as its JSON Schema declares it (declared names, decoded values), not the storage encoding
  const entry = (schema: string, row: StoreRow): StoreRow => {
    const def = env.schemas[schema];
    return Object.fromEntries(Object.entries(row).map(([k, v]) => (def?.fields[k] && def.fields[k] !== "geo" ? [(def as { names?: Record<string, string> }).names?.[k] ?? k, env.dialect.codec.decode(def.fields[k]!, v)] : [k, v])));
  };
  const event = (i: number, hook: string, schema: string, rows: [StoreRow, ...StoreRow[]]) => ({
    id: `${as.seq ?? as.cause.id}:${i}:${hook}`, schema, hook: hook as never, rows: rows.map((r) => entry(schema, r)) as unknown as [StoreRow, ...StoreRow[]], caller: as.caller, parent: as.cause,
  });

  for (const [i, c] of plan.entries()) {
    if (!c.schema || !c.verb) continue;
    const hooked = !!lc?.before.has(key(c));
    // a publishing Schema drafts, protects what is published and moves through statuses by one rule (ADR-0032 decision 1)
    const lifecycle = !!env.schemas[c.schema]?.publishing && c.kind === "row" && c.verb !== "insert";
    if (hooked && c.kind !== "row") throw refuse(`SQL_SHAPE: a set op on ${c.schema} is refused: ${c.schema} has a before ${verbOf(c)} hook, and before hooks take row ops only`);
    if (!hooked && !lifecycle) continue;
    const row = await preRead(env, p, i, c, as);
    if (lifecycle) {
      const to = p.statuses?.[i] as ContentState | undefined;
      const stmt = p.ir[i]!;
      const from = row.status as ContentState;
      const d = decideLifecycleWrite({ spec: { lifecycle: "publishing" } }, c.verb === "delete" ? { op: "delete", from } : { op: "update", from, ...(to ? { to } : {}), data: (stmt.UpdateStmt?.targetList?.length ?? 0) > 0 });
      if (!d.allowed) throw new DiagnosticError(runtimeDiagnostic({ code: "CONFLICT", severity: "error", path: "store", message: `CONFLICT: ${c.schema} entry is ${from}; ${NOT_ALLOWED[d.reason]}.` }));
      await p.checks?.[i]?.(row);
    }
    if (hooked) await lc!.dispatcher.before([event(i, `before_${HOOK[verbOf(c)]}`, c.schema, [row])]);
    versions[i] = row.version;
    // the statement carries the version it was decided on, so a change in between is CONFLICT
    if (c.verb !== "insert") plan[i] = compileProgram([p.ir[i]!], { ...base, lockVersion: true, statuses: [p.statuses?.[i]] })[0]!;
  }

  // a row op that matched nothing is `lock` when the entry is visible at another version than the one `version = input.x` asked for
  // (ADR-0032 decision 2), and `expect` otherwise: an invisible entry is a missing one
  const lockReason = async (e: unknown): Promise<unknown> => {
    if (!(e instanceof DiagnosticError) || e.diagnostic.conflict?.reason !== "expect") return e;
    const i = e.diagnostic.conflict.opIndex;
    const c = i === undefined ? undefined : plan[i];
    const asked = c && c.kind === "row" && c.verb !== "insert" ? pinnedTarget(p.ir[i!]!)?.version : undefined;
    const expected = asked === undefined ? undefined : as.bind.input?.[asked];
    if (expected === undefined) return e;
    const row = await preRead(env, p, i!, c!, as).catch(() => undefined);
    if (!row || row.version === expected) return e;
    return new DiagnosticError(runtimeDiagnostic({ code: "CONFLICT", severity: "error", path: "store", message: e.message, conflict: { opIndex: i!, reason: "lock" } }));
  };
  const res = await env.executor.apply(plan.map((c, i) => ({
    ir: c.ast,
    binds: bindValues(env.dialect, c.binds, as.bind, { version: versions[i] }),
    ...((p.expects?.[i] ?? (c.kind === "row" ? 1 : undefined)) === undefined ? {} : { expect: p.expects?.[i] ?? 1 }),
  }))).catch(async (e) => { throw await lockReason(e); });

  const rows = res.map((r, i) => (plan[i]!.hooked ? r.rows.map(strip) : r.rows));
  if (lc) for (const [i, c] of plan.entries()) {
    if (!c.schema || !c.verb || !lc.after.has(key(c)) || !res[i]!.rows.length) continue; // a statement that writes no row calls no hook
    const cause = res[i]!.rows.map((row) => ({ ...strip(row), id: row[HIDDEN_ID], version: row[HIDDEN_VERSION] })) as unknown as [StoreRow, ...StoreRow[]];
    // a failure of an after hook never changes the committed result (ADR-0032 decision 3); the dispatcher reports its own failures
    await lc.dispatcher.after([event(i, `after_${HOOK[verbOf(c)]}`, c.schema, cause)]).catch(() => undefined);
  }
  return { rows, affected: res.map((r) => r.affected) };
}

// ---- Views and cursors --------------------------------------------------------------------------------
const refuseOutput = (name: string): never => { throw refuse(`SQL_SHAPE: the View has no output named '${name}'`); };
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
/**
 * Conditions on a paged View's outputs (ADR-0032 decision 5): Admin's `searchFields` become one `LIKE` per output, ORed, and
 * `filterFields` one `=` each. Values are bound; the output names come from the plan's uiSchema, never from the request.
 */
export interface ViewMatch {
  readonly search?: { readonly columns: readonly string[]; readonly text: string };
  readonly eq?: readonly { readonly column: string; readonly value: unknown }[];
}

/** `%text%` with the LIKE metacharacters escaped, so a search matches what was typed. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function runView(env: RunEnv, p: Program, as: RunAs, opts: { cursor?: readonly unknown[]; pageSize?: number; match?: ViewMatch } = {}): Promise<ViewPage> {
  const [c] = compileProgram(p.ir, ctxOf(env, p));
  if (!opts.pageSize) return { rows: await env.executor.select({ ir: c!.ast, binds: bindValues(env.dialect, c!.binds, as.bind) }) };
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
  const after = opts.cursor
    ? { BoolExpr: { boolop: "OR_EXPR", args: keys.map((k, i) => ({ BoolExpr: { boolop: "AND_EXPR", args: [
        ...keys.slice(0, i).map((_x, j) => op("=", col(`_k${j}`), { ParamRef: { number: base + j + 1 } })),
        op(k.SortBy.sortby_dir === "SORTBY_DESC" ? "<" : ">", col(`_k${i}`), { ParamRef: { number: base + i + 1 } }),
      ] } })) } }
    : undefined;
  // an output by the name SQL gave it: an unquoted alias or column folds to lower case
  const output = (name: string) => visible.find((n) => n === name) ?? visible.find((n) => n === name.toLowerCase()) ?? refuseOutput(name);
  const matchBinds: unknown[] = [];
  const param = (value: unknown): N => (matchBinds.push(value), { ParamRef: { number: base + cursorBinds.length + matchBinds.length } });
  const conditions: N[] = after ? [after] : [];
  const search = opts.match?.search;
  if (search?.text) {
    const pattern = likePattern(search.text);
    conditions.push({ BoolExpr: { boolop: "OR_EXPR", args: search.columns.map((c) => ({ A_Expr: { kind: "AEXPR_LIKE", name: [{ String: { sval: "~~" } }], lexpr: col(output(c)),
      rexpr: { FuncCall: { funcname: [{ String: { sval: "like_escape" } }], args: [param(pattern), { A_Const: { sval: { sval: "\\" } } }], funcformat: "COERCE_EXPLICIT_CALL" } } } })) } });
  }
  for (const { column, value } of opts.match?.eq ?? []) conditions.push(op("=", col(output(column)), param(value)));
  const outer: N = { SelectStmt: {
    targetList: [...visible.map((n) => ({ ResTarget: { val: col(n), name: n } })), ...keys.map((_k, i) => ({ ResTarget: { val: col(`_k${i}`), name: `_k${i}` } }))],
    fromClause: [{ RangeSubselect: { subquery: { SelectStmt: inner }, alias: { aliasname: "_p" } } }],
    whereClause: conditions.length > 1 ? { BoolExpr: { boolop: "AND_EXPR", args: conditions } } : conditions[0],
    sortClause: keys.map((k, i) => ({ SortBy: { node: col(`_k${i}`), sortby_dir: k.SortBy.sortby_dir, sortby_nulls: k.SortBy.sortby_nulls } })),
    limitCount: { A_Const: { ival: { ival: opts.pageSize + 1 } } }, limitOption: "LIMIT_OPTION_COUNT", op: "SETOP_NONE" } };
  const rows = await env.executor.select({ ir: outer, binds: [...bindValues(env.dialect, [...c!.binds, ...cursorBinds], as.bind, { cursor: opts.cursor }), ...matchBinds] });
  const page = rows.slice(0, opts.pageSize);
  const next = rows.length > opts.pageSize ? keys.map((_k, i) => page.at(-1)![`_k${i}`]) : undefined;
  return { rows: page.map((r) => Object.fromEntries(visible.map((n) => [n, r[n]]))), ...(next ? { next } : {}) };
}
