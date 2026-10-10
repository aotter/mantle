/**
 * Running a compiled program: a Procedure is one all-or-nothing batch with lifecycle hooks around it,
 * a View is one read with keyset paging (ADR-0032 decisions 2 and 3, ADR-0034 decision 4). Store and
 * `invokeProcedure` both run through here; nothing else reaches the executor.
 */
import { DiagnosticError, runtimeDiagnostic } from "../../spec/kernel/index.js";
import { decideLifecycleWrite, hasSubLink, isIdCol, pinnedTarget, type ContentState, type SqlNode as N } from "../../spec/domain/index.js";
import type { Caller } from "../caller.js";
import type { InvocationCause, LifecycleDispatcher } from "../invocation.js";
import type { StoreExecutor, StoreRow } from "../store.js";
import { bindValues, compileProgram, type BindContext, type CompileContext } from "./compile.js";
import { NATIVE } from "../store/json.js";
import { S, op, ref } from "./ast.js";
import { applyPolicy, HOOK_PREFIX, type Compiled } from "./policy.js";

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
    if (hasSubLink(values)) throw refuse(`SQL_SHAPE: an insert into ${c.schema}, which has a before create hook, may not read data in its VALUES`);
    if (!values.length) return {}; // an insert that names no column: the hook sees an empty entry
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

/** A native column by its physical name: the name Store gives it and the type it decodes as (Store's own table, inverted). */
const BY_COLUMN = new Map(Object.entries(NATIVE).map(([name, { col, type }]) => [col, { name, type }]));

/** A returned row split into what the statement's own RETURNING asked for and the row its after hook receives. */
function split(row: StoreRow): { result: StoreRow; hook: StoreRow } {
  const result: Record<string, unknown> = {}, hook: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (k.startsWith(HOOK_PREFIX)) hook[k.slice(HOOK_PREFIX.length)] = v; else result[k] = v;
  return { result, hook };
}


// ---- the compile cache ---------------------------------------------------------------------------------
// A sealed plan's IR never changes, and the compiled form of a program (validated, policy injected) depends only on the IR, the
// plan's inputs and schemas, the dialect (its checks, lowering and native-order flag) and the run's mode, plus the Procedure's hook
// set. None of that is the caller: who they are reaches the statement only as binds (`uid`, `role`, `input`), resolved per request by
// `bindValues`. So one program compiles once per such key, not once per request. Every level is a WeakMap on an object whose life is the
// plan's (IR, inputs, schemas, dialect), and the last level is capped, so no request input grows it.
type Slot = Map<string, Compiled[]>;
const compiledCache = new WeakMap<object, WeakMap<object, WeakMap<object, WeakMap<object, Slot>>>>();
const SLOT_CAP = 32;
const level = <K extends object, V>(m: WeakMap<K, V>, k: K, make: () => V): V => { let v = m.get(k); if (!v) m.set(k, (v = make())); return v; };

/**
 * `compileProgram`, once per (IR, inputs, schemas, dialect, flavour). The negative-control and position-probe runs (`seen`,
 * `unsafeNoVisibility`) and a Store write (`statuses`, built fresh from the request) are never cached. The returned array is the
 * caller's own to change; the Compiled values in it are shared and must not be.
 */
function compileCached(env: RunEnv, p: Program, ir: object, stmts: readonly N[], ctx: CompileContext, flavour: string): Compiled[] {
  if (env.seen || env.unsafeNoVisibility || ctx.statuses?.some((x) => x !== undefined) || p.statuses) return compileProgram(stmts, ctx);
  const slot = level(level(level(level(compiledCache, ir, () => new WeakMap()), p.inputs, () => new WeakMap()), env.schemas, () => new WeakMap()), env.dialect, () => new Map() as Slot);
  const key = `${p.kind}|${env.mode}|${[...(ctx.returning ?? [])].sort().join(",")}|${ctx.lockVersion ? "lock" : ""}|${flavour}`;
  let hit = slot.get(key);
  if (!hit) {
    if (slot.size >= SLOT_CAP) slot.clear();
    slot.set(key, (hit = compileProgram(stmts, ctx)));
  }
  return hit.slice();
}

/** A Procedure: before hooks (row ops only), one batch applied in order and all or nothing, then after hooks. */
export async function runProcedure(env: RunEnv, p: Program, as: RunAs): Promise<{ readonly rows: readonly (readonly StoreRow[])[]; readonly affected: readonly number[] }> {
  const lc = env.lifecycle;
  const afterSchemas = new Set([...(lc?.after ?? [])].map((k) => k.split(".")[0]!));
  const base = ctxOf(env, p, { returning: afterSchemas, statuses: p.statuses });
  const plan = compileCached(env, p, p.ir, p.ir, base, "all");
  const versions: Record<number, unknown> = {};
  // a hook receives the entry as Store's `select` returns it (declared names, decoded values, `{ lat, lng }`), not the storage encoding
  const entry = (schema: string, row: StoreRow): StoreRow => {
    const def = env.schemas[schema]!;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      const native = BY_COLUMN.get(k);
      if (native) out[native.name] = env.dialect.codec.decode(native.type, v);
      else if (def.fields[k] && def.fields[k] !== "geo") out[(def as { names?: Record<string, string> }).names?.[k] ?? k] = env.dialect.codec.decode(def.fields[k]!, v);
      else if (!/_(lat|lng)$/.test(k) || def.fields[k.slice(0, -4)] !== "geo") out[k] = v;
    }
    for (const [f, t] of Object.entries(def.fields))
      if (t === "geo" && (`${f}_lat` in row)) out[(def as { names?: Record<string, string> }).names?.[f] ?? f] = row[`${f}_lat`] == null || row[`${f}_lng`] == null ? null : { lat: row[`${f}_lat`], lng: row[`${f}_lng`] };
    return out;
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
    // Publishing decisions remain pinned to the row checked above. A hook snapshot alone adds no OCC;
    // any version predicate explicitly supplied by the caller stays in the original statement.
    if (lifecycle) {
      versions[i] = row.version;
      plan[i] = compileCached(env, p, p.ir[i]!, [p.ir[i]!], { ...base, lockVersion: true, statuses: [p.statuses?.[i]] }, "one")[0]!;
    }
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

  const parts = res.map((r, i) => (plan[i]!.hooked ? r.rows.map(split) : undefined));
  // a statement without RETURNING returns no rows, whatever its hook was given
  const rows = res.map((r, i) => (!parts[i] ? r.rows : p.ir[i]![Object.keys(p.ir[i]!)[0]!].returningClause ? parts[i]!.map((x) => x.result) : []));
  if (lc) for (const [i, c] of plan.entries()) {
    if (!c.schema || !c.verb || !lc.after.has(key(c)) || !res[i]!.rows.length) continue; // a statement that writes no row calls no hook
    const cause = parts[i]!.map((x) => x.hook) as unknown as [StoreRow, ...StoreRow[]];
    // a failure of an after hook never changes the committed result (ADR-0032 decision 3); the dispatcher reports its own failures
    await lc.dispatcher.after([event(i, `after_${HOOK[verbOf(c)]}`, c.schema, cause)]).catch(() => undefined);
  }
  return { rows, affected: res.map((r) => r.affected) };
}

// ---- Views and cursors --------------------------------------------------------------------------------
const refuseOutput = (name: string): never => { throw refuse(`SQL_SHAPE: the View has no output named '${name}'`); };
/** The name a View output has on the row: its alias, or the column it reads. */
export const outName = (t: N) => t.ResTarget.name ?? t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.String?.sval;

export interface ViewPage {
  readonly rows: readonly StoreRow[];
  /** The last row's sort keys; the caller encodes them into the one opaque cursor. */
  readonly next?: readonly unknown[];
}

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

// ---- the row-comparison cursor ------------------------------------------------------------------------
/**
 * Columns every Schema's table declares NOT NULL (`postgres/storage.ts` createTable): the native ones, the scope column, and `status` when publishing.
 * The scope branch is the table's truth but does not fire today: a View's readable projection never exposes the scope column to sort by.
 */
const nativeNotNull = (s: { scope?: string; publishing?: boolean }, column: string) =>
  column === "id" || column === "version" || column === "created_at" || column === "updated_at" || column === s.scope || (!!s.publishing && column === "status");

/** The FROM items of a select, each with whether an outer join can null-extend it. */
function fromItems(items: readonly N[] | undefined, nullable = false): { node: N; nullable: boolean }[] {
  return (items ?? []).flatMap((n): { node: N; nullable: boolean }[] => {
    const j = n.JoinExpr;
    if (!j) return [{ node: n, nullable }];
    return [...fromItems([j.larg], nullable || j.jointype === "JOIN_RIGHT" || j.jointype === "JOIN_FULL"), ...fromItems([j.rarg], nullable || j.jointype === "JOIN_LEFT" || j.jointype === "JOIN_FULL")];
  });
}

/**
 * Whether `qual.name` (or `name`, when the select reads one source) of `sel` can never be NULL: a native column of a Schema's own table
 * (not null-extended by an outer join), or a bare pass-through of one by a subquery. Anything else (an expression, a declared field,
 * a CTE, a row source, an ambiguous name) is unknown, and unknown means nullable.
 * ponytail: declared required fields are nullable in the table (storage.ts adds NOT NULL to native columns only), so they count as nullable here;
 * the upgrade is a NOT NULL for them, which needs a storage migration.
 */
function notNullIn(schemas: RunEnv["schemas"], sel: N, qual: string | undefined, name: string): boolean {
  if (!sel || sel.op !== "SETOP_NONE" || sel.withClause) return false;
  const items = fromItems(sel.fromClause);
  const alias = (n: N) => n.RangeVar ? n.RangeVar.alias?.aliasname ?? n.RangeVar.relname : n.RangeSubselect?.alias?.aliasname ?? n.RangeFunction?.alias?.aliasname;
  const hit = qual === undefined ? items : items.filter((i) => alias(i.node) === qual);
  if (hit.length !== 1 || (qual === undefined && items.length !== 1) || hit[0]!.nullable) return false;
  const { node } = hit[0]!;
  if (node.RangeVar) {
    const schema = node.RangeVar.mantle === "system" ? schemas[node.RangeVar.relname] : undefined;
    return !!schema && nativeNotNull(schema, name);
  }
  const sub = node.RangeSubselect;
  if (!sub || sub.alias?.colnames?.length || sub.lateral) return false;
  const outs = (sub.subquery.SelectStmt?.targetList ?? []).filter((t: N) => (t.ResTarget.name ?? t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.String?.sval) === name);
  const f = outs.length === 1 ? outs[0].ResTarget.val?.ColumnRef?.fields : undefined;
  if (!f || f.length > 2 || f.some((x: N) => !x.String)) return false;
  return notNullIn(schemas, sub.subquery.SelectStmt, f.length === 2 ? f[0].String.sval : undefined, f.at(-1).String.sval);
}

/**
 * PostgreSQL only: whether the cursor can be one row comparison `(k0, k1, ...) > ($1, $2, ...)`. That needs every key (the appended
 * tiebreaks included) NOT NULL, all in one direction, and no NULLS clause other than PostgreSQL's own default.
 */
function rowComparable(env: RunEnv, sel: N, keys: readonly N[], hidden: readonly N[]): boolean {
  if (!env.dialect.nativeOrder || !keys.length) return false;
  const desc = keys[0]!.SortBy.sortby_dir === "SORTBY_DESC";
  return keys.every((k, i) => {
    const d = k.SortBy.sortby_dir;
    if (d !== "SORTBY_DEFAULT" && d !== "SORTBY_ASC" && d !== "SORTBY_DESC") return false;
    if ((d === "SORTBY_DESC") !== desc) return false;
    // an explicit NULLS clause is the author's: only PostgreSQL's own default (LAST ascending, FIRST descending) leaves the order the index has
    const nulls = k.SortBy.sortby_nulls;
    if (nulls && nulls !== "SORTBY_NULLS_DEFAULT" && nulls !== (desc ? "SORTBY_NULLS_FIRST" : "SORTBY_NULLS_LAST")) return false;
    const f = hidden[i]!.ResTarget.val?.ColumnRef?.fields;
    if (!f || f.length > 2 || f.some((x: N) => !x.String)) return false;
    return notNullIn(env.schemas, sel, f.length === 2 ? f[0].String.sval : undefined, f.at(-1).String.sval);
  });
}

/**
 * Keyset pagination over a View. The sort keys (the author's plus the compiler's appended id or group key)
 * become hidden `_k<i>` columns; the cursor is the last row's keys and the next page filters on them. A NULL key
 * sorts by the dialect's own NULLS rule (stated on every key, so the cursor and the order agree).
 *
 * A View's own LIMIT bounds every page together. A View without ORDER BY (a DISTINCT, a GROUP BY or an aggregate) cannot
 * be paged: it returns its rows when they fit one page and is refused when they do not.
 */
/** Where a paged statement's extra bind comes from on a later request: a cursor key, the search pattern, or an equality value. */
type Source = { readonly cursor: number } | { readonly search: true } | { readonly eq: number };
/** The paged form of one View under one request shape: its AST is built once, and `sources` say how to bind it. */
interface Paged { readonly ast: N; readonly sources: readonly Source[]; readonly flat: boolean; readonly names: readonly string[]; readonly nkeys: number }
// keyed by the compiled View, so it lives and dies with the compile cache's entry; the shapes per View are capped (a page size and a
// cursor's length come off the wire)
const pagedCache = new WeakMap<Compiled, Map<string, Paged>>();
const SHAPE_CAP = 64;

export async function runView(env: RunEnv, p: Program, as: RunAs, opts: { cursor?: readonly unknown[]; pageSize?: number; match?: ViewMatch } = {}): Promise<ViewPage> {
  const [c] = compileCached(env, p, p.ir, p.ir, ctxOf(env, p), "view");
  if (!opts.pageSize) return { rows: await env.executor.select({ ir: c!.ast, binds: bindValues(env.dialect, c!.binds, as.bind) }) };
  const pageSize = opts.pageSize;
  if (opts.cursor && !c!.ast.SelectStmt.sortClause?.length) throw refuse("SQL_SHAPE: this View has no ORDER BY, so it is one page and takes no cursor");
  // everything the statement's text depends on besides the compiled View: the page size, which cursor keys are NULL or missing and how
  // many there are (the row comparison needs all of them, non-null), and the search and equality columns. Values are binds, not text.
  // Only the first nkeys elements and whether the length is exactly nkeys reach the AST, so the key's size is bounded by the View, not the wire.
  const nkeys = c!.ast.SelectStmt.sortClause?.length ?? 0;
  const cursorShape = opts.cursor ? `${Array.from({ length: nkeys }, (_x, i) => { const v = opts.cursor![i]; return v === null ? "n" : v === undefined ? "u" : "v"; }).join("")}${opts.cursor.length === nkeys ? "=" : "!"}` : "-";
  const search = opts.match?.search?.text ? opts.match.search : undefined;
  const eq = opts.match?.eq ?? [];
  const shape = JSON.stringify([pageSize, cursorShape, search?.columns ?? null, eq.map((e) => e.column)]);
  const shapes = level(pagedCache, c!, () => new Map<string, Paged>());
  let paged = shapes.get(shape);
  if (!paged) {
    if (shapes.size >= SHAPE_CAP) shapes.clear();
    shapes.set(shape, (paged = pagedOf(env, c!, pageSize, opts.cursor, opts.match)));
  }
  const extra = paged.sources.map((x) => ("cursor" in x ? opts.cursor![x.cursor] : "search" in x ? likePattern(search!.text) : eq[x.eq]!.value));
  const rows = await env.executor.select({ ir: paged.ast, binds: [...bindValues(env.dialect, c!.binds, as.bind), ...extra] });
  if (paged.flat) {
    if (rows.length > pageSize) throw refuse(`SQL_SHAPE: this View has more than ${pageSize} rows and no ORDER BY to page them by: add an ORDER BY`);
    return { rows };
  }
  if (!paged.nkeys && rows.length > pageSize) throw refuse(`SQL_SHAPE: this View has more than ${pageSize} matching rows and no ORDER BY to page them by: add an ORDER BY`);
  const page = rows.slice(0, pageSize);
  const next = paged.nkeys && rows.length > pageSize ? Array.from({ length: paged.nkeys }, (_k, i) => page.at(-1)![`_k${i}`]) : undefined;
  return { rows: page.map((r) => Object.fromEntries(paged.names.map((n) => [n, r[n]]))), ...(next ? { next } : {}) };
}

/** The paged statement for one request shape (see `runView`): the View wrapped with its cursor condition, search and equality filters. */
function pagedOf(env: RunEnv, c: Compiled, pageSize: number, cursor: readonly unknown[] | undefined, match: ViewMatch | undefined): Paged {
  const opts = { cursor, pageSize, match };
  const sel = structuredClone(c.ast.SelectStmt) as N;
  const keys: N[] = sel.sortClause ?? [];
  if (opts.cursor && !keys.length) throw refuse("SQL_SHAPE: this View has no ORDER BY, so it is one page and takes no cursor");
  const visible: (string | undefined)[] = sel.targetList.map(outName);
  if (!keys.length && !opts.match?.search?.text && !opts.match?.eq?.length) {
    // nothing to wrap: the View's own statement, one row past the page to tell whether it fits
    return { ast: { SelectStmt: { ...sel, limitCount: { A_Const: { ival: { ival: pageSize + 1 } } }, limitOption: "LIMIT_OPTION_COUNT" } }, sources: [], flat: true, names: [], nkeys: 0 };
  }
  if (visible.some((n) => !n)) throw refuse("SQL_SHAPE: a paged View names every output column");
  const names = visible as string[];
  const aliasVal = new Map<string, N>(sel.targetList.map((t: N) => [outName(t), t.ResTarget.val]));
  const hidden = keys.map((k, i) => {
    const node = k.SortBy.node;
    const f = node.ColumnRef?.fields;
    const position = node.A_Const?.ival ? Number(node.A_Const.ival.ival) : undefined;
    // an ORDER BY alias or position is its select-list expression; a bare constant would sort nothing
    const val = position !== undefined ? sel.targetList[position - 1]?.ResTarget.val ?? refuseOutput(String(position))
      : f?.length === 1 && aliasVal.has(f[0].String.sval) ? aliasVal.get(f[0].String.sval)! : node;
    return { ResTarget: { name: `_k${i}`, val } };
  });
  // the dialect's own rule, stated: SQLite puts NULL first ascending and last descending; a native-order dialect (PostgreSQL) the reverse
  const desc = (k: N) => k.SortBy.sortby_dir === "SORTBY_DESC";
  const nullsFirst = (k: N) => (k.SortBy.sortby_nulls === "SORTBY_NULLS_FIRST" ? true : k.SortBy.sortby_nulls === "SORTBY_NULLS_LAST" ? false : desc(k) === !!env.dialect.nativeOrder);
  // an authored LIMIT bounds the whole result: the View's own ORDER BY and LIMIT pick its rows, and the pages run through those
  const inner: N = sel.limitCount
    ? { ...sel, targetList: [...sel.targetList, ...hidden] }
    : { ...sel, targetList: [...sel.targetList, ...hidden], sortClause: undefined, limitCount: undefined, limitOption: "LIMIT_OPTION_DEFAULT" };
  const base = c.binds.length;
  const sources: Source[] = [];
  const param = (source: Source): N => (sources.push(source), { ParamRef: { number: base + sources.length } });
  const col = (n: string): N => ref("_p", n);
  const isNull = (n: N, t: "IS_NULL" | "IS_NOT_NULL"): N => ({ NullTest: { arg: n, nulltesttype: t } });
  const conditions: N[] = [];
  if (opts.cursor) {
    const cur = opts.cursor;
    const same = (j: number) => (cur[j] === null ? isNull(col(`_k${j}`), "IS_NULL") : op("=", col(`_k${j}`), param({ cursor: j })));
    // the rows after the cursor's key i: past a NULL comes every value when NULL sorts first, nothing when it sorts last
    const past = (k: N, i: number): N | undefined => {
      const at = col(`_k${i}`);
      if (cur[i] === null) return nullsFirst(k) ? isNull(at, "IS_NOT_NULL") : undefined;
      const beyond = op(desc(k) ? "<" : ">", at, param({ cursor: i }));
      return nullsFirst(k) ? beyond : { BoolExpr: { boolop: "OR_EXPR", args: [beyond, isNull(at, "IS_NULL")] } };
    };
    if (rowComparable(env, sel, keys, hidden) && cur.length === keys.length && cur.every((v) => v !== null && v !== undefined)) {
      // every key is NOT NULL and they share one direction: one row comparison, which a btree range-scans however deep the page
      const row = (args: N[]): N => ({ RowExpr: { args, row_format: "COERCE_IMPLICIT_CAST" } });
      conditions.push(op(desc(keys[0]!) ? "<" : ">", row(keys.map((_k, i) => col(`_k${i}`))), row(cur.map((_v, i) => param({ cursor: i })))));
    } else {
      const args = keys.flatMap((k, i) => {
        const last = past(k, i);
        return last ? [{ BoolExpr: { boolop: "AND_EXPR", args: [...keys.slice(0, i).map((_x, j) => same(j)), last] } }] : [];
      });
      conditions.push(args.length ? { BoolExpr: { boolop: "OR_EXPR", args } } : { A_Const: { boolval: { boolval: false } } });
    }
  }
  // an output by the name SQL gave it: an unquoted alias or column folds to lower case
  const output = (name: string) => names.find((n) => n === name) ?? names.find((n) => n === name.toLowerCase()) ?? refuseOutput(name);
  const search = opts.match?.search;
  if (search?.text) {
    conditions.push({ BoolExpr: { boolop: "OR_EXPR", args: search.columns.map((c) => ({ A_Expr: { kind: "AEXPR_LIKE", name: [{ String: { sval: "~~" } }], lexpr: col(output(c)),
      rexpr: { FuncCall: { funcname: [{ String: { sval: "like_escape" } }], args: [param({ search: true }), { A_Const: { sval: { sval: "\\" } } }], funcformat: "COERCE_EXPLICIT_CALL" } } } })) } });
  }
  (opts.match?.eq ?? []).forEach(({ column }, k) => conditions.push(op("=", col(output(column)), param({ eq: k }))));
  const outer: N = { SelectStmt: {
    targetList: [...names.map((n) => ({ ResTarget: { val: col(n), name: n } })), ...keys.map((_k, i) => ({ ResTarget: { val: col(`_k${i}`), name: `_k${i}` } }))],
    fromClause: [{ RangeSubselect: { subquery: { SelectStmt: inner }, alias: { aliasname: "_p" } } }],
    whereClause: conditions.length > 1 ? { BoolExpr: { boolop: "AND_EXPR", args: conditions } } : conditions[0],
    sortClause: keys.map((k, i) => ({ SortBy: { node: col(`_k${i}`), sortby_dir: k.SortBy.sortby_dir, sortby_nulls: nullsFirst(k) ? "SORTBY_NULLS_FIRST" : "SORTBY_NULLS_LAST" } })),
    limitCount: { A_Const: { ival: { ival: pageSize + 1 } } }, limitOption: "LIMIT_OPTION_COUNT", op: "SETOP_NONE" } };
  return { ast: outer, sources, flat: false, names, nkeys: keys.length };
}
