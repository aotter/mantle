// The tenant-Worker half of the spike: IR -> policy -> printer -> one D1 batch, with hooks, OCC and
// the `changes()` counting of ADR-0034 decision 4. Not product code: no caching, no result typing.
import type { N, Schemas } from './types.ts';
import { Refused } from './types.ts';
import type { BindSpec, Compiled, Mode } from './policy.ts';
import { applyPolicy } from './policy.ts';
import { print } from './print.ts';
import type { Deparser } from 'pgsql-deparser';
import { validateProgram } from './validate.ts';
import { encodeInput } from './codec.ts';
import type { LocalD1, Stmt } from './d1.ts';
import type { RelationPosition } from './positions.ts';

export type Verb = 'insert' | 'update' | 'delete';
export type Hooks = {
  before?: Record<string, Partial<Record<Verb, (cause: { row: any }) => unknown>>>;
  after?: Record<string, Partial<Record<Verb, (cause: { rows: [any, ...any[]] }) => unknown>>>;
};
export type Site = { printer?: typeof Deparser; d1: LocalD1; schemas: Schemas; hooks?: Hooks; mode?: Mode; seen?: Set<RelationPosition> };
export type Program = { kind: 'view' | 'procedure'; inputs: Record<string, string>; ir: N[] };
export type Runtime = { uid: string; now: number; role?: string; input?: Record<string, unknown> };

export class Conflict extends Error {
  opIndex: number;
  constructor(op: number) {
    super(`CONFLICT op=${op}`);
    this.opIndex = op;
  }
}
export class CheckViolation extends Error {}

const hookedSchemas = (h: Hooks | undefined) => new Set(Object.keys(h?.after ?? {}));

/** the box a near() query binds to the R*Tree: a bounding box of the radius, padded for float32 storage */
function box(which: string, lat: number, lng: number, meters: number): number {
  const dLat = meters / 111_320, dLng = meters / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 1e-9)), pad = 1e-4;
  if (Math.abs(lat) + dLat >= 90 || Math.abs(lng) + dLng >= 180) throw new Refused('SQL_SHAPE', 'near(): a box that crosses the antimeridian or a pole is refused');
  return { minLat: lat - dLat - pad, maxLat: lat + dLat + pad, minLng: lng - dLng - pad, maxLng: lng + dLng + pad }[which as 'minLat'];
}
export function bindValues(binds: BindSpec[], rt: Runtime, extra: { version?: unknown; cursor?: unknown[] } = {}): unknown[] {
  const inp = rt.input ?? {};
  const arg = (a: any) => ('const' in a ? a.const : Number(inp[a.input]));
  return binds.map((b) => {
    switch (b.k) {
      case 'uid': return rt.uid;
      case 'now': return rt.now;
      case 'role': return rt.role ?? null;
      case 'input': return encodeInput(b.type, inp[b.name]);
      case 'version': return extra.version;
      case 'cursor': return extra.cursor![b.i];
      case 'box': return box(b.which, arg(b.lat), arg(b.lng), b.meters);
    }
  });
}

/** Compile every statement of a program. Runs `validateProgram` again: the runtime never trusts an IR. */
export function compileProgram(site: Site, p: Program, opts: { lockVersion?: boolean } = {}): Compiled[] {
  validateProgram(p.ir, { schemas: site.schemas, inputs: p.inputs, kind: p.kind });
  const out = p.ir.map((stmt) => applyPolicy(stmt, { schemas: site.schemas, inputs: p.inputs, mode: site.mode, returning: hookedSchemas(site.hooks), seen: site.seen, ...opts }));
  for (const c of out) {
    // a set op on a Schema with a before hook for that verb is refused (ADR-0034 decision 4)
    if (c.kind === 'set' && c.schema && c.verb && site.hooks?.before?.[c.schema]?.[c.verb])
      throw new Refused('SQL_SHAPE', `a set op on ${c.schema} is refused: ${c.schema} has a before ${c.verb} hook, and before hooks take row ops only`);
  }
  return out;
}
export const render = (c: Compiled, printer?: typeof Deparser) => print(c.ast, printer);

function mapError(e: any): never {
  const m = /CONFLICT op=(\d+)/.exec(e.message);
  if (m) throw new Conflict(+m[1]);
  const k = /(CHECK \w+: [^:]*?)(?: at offset|: SQLITE|$)/.exec(e.message);
  if (k) throw new CheckViolation(k[1]);
  throw e;
}

export type ProcedureResult = { rows: any[][]; batch: Stmt[]; hookCalls: string[] };

/** A Procedure: one D1 batch, applied in order and all or nothing. */
export async function runProcedure(site: Site, p: Program, rt: Runtime): Promise<ProcedureResult> {
  let plan = compileProgram(site, p);
  const versions: Record<number, unknown> = {};
  const hookCalls: string[] = [];
  // before hooks: row ops only. Read the row, call the hook, then carry the version the hook saw into the statement.
  for (const [i, c] of plan.entries()) {
    const hook = c.schema && c.verb && site.hooks?.before?.[c.schema]?.[c.verb];
    if (!hook) continue;
    if (c.kind !== 'row') throw new Refused('SQL_SHAPE', 'before hooks take row ops only');
    let row: any = null;
    if (c.verb !== 'insert') {
      const idExpr = idOf(p.ir[i]);
      const read: N = { SelectStmt: { targetList: [{ ResTarget: { val: { ColumnRef: { fields: [{ String: { sval: 't' } }, { String: { sval: 'id' } }] } } } }, { ResTarget: { val: { ColumnRef: { fields: [{ String: { sval: 't' } }, { String: { sval: 'version' } }] } } } }, { ResTarget: { val: { ColumnRef: { fields: [{ String: { sval: 't' } }, { A_Star: {} }] } } } }],
        fromClause: [{ RangeVar: { relname: c.schema, alias: { aliasname: 't' }, inh: true, relpersistence: 'p', mantle: 'table' } }],
        whereClause: { A_Expr: { kind: 'AEXPR_OP', name: [{ String: { sval: '=' } }], lexpr: { ColumnRef: { fields: [{ String: { sval: 't' } }, { String: { sval: 'id' } }] } }, rexpr: idExpr } },
        limitOption: 'LIMIT_OPTION_DEFAULT', op: 'SETOP_NONE' } };
      const rc = applyPolicy(read, { schemas: site.schemas, inputs: p.inputs, mode: site.mode, seen: site.seen });
      row = (await site.d1.all(render(rc, site.printer), bindValues(rc.binds, rt)))[0] ?? null;
    }
    await hook({ row });
    hookCalls.push(`before ${c.verb} ${c.schema}`);
    versions[i] = row?.version;
    if (c.verb !== 'insert') {
      const locked = applyPolicy(p.ir[i], { schemas: site.schemas, inputs: p.inputs, mode: site.mode, returning: hookedSchemas(site.hooks), lockVersion: true });
      plan[i] = locked;
    }
  }
  const batch: Stmt[] = [];
  const at: number[] = [];
  plan.forEach((c, i) => {
    at[i] = batch.length;
    batch.push({ sql: render(c, site.printer), binds: bindValues(c.binds, rt, { version: versions[i] }) });
    // a row op must affect exactly one row: count with SQLite's changes(), not D1's meta.changes (which includes trigger writes)
    if (c.kind === 'row') batch.push({ sql: `INSERT INTO _mantle_assert (op, ok) SELECT ${i}, changes() = 1` });
  });
  let res;
  try {
    res = await site.d1.batch(batch);
  } catch (e) {
    return mapError(e);
  }
  const rows = plan.map((_c, i) => res[at[i]].rows);
  for (const [i, c] of plan.entries()) {
    const hook = c.schema && c.verb && site.hooks?.after?.[c.schema]?.[c.verb];
    if (hook && rows[i].length) { // one call per statement and Trigger; a statement that writes no row calls no hook
      await hook({ rows: rows[i] as [any, ...any[]] });
      hookCalls.push(`after ${c.verb} ${c.schema} (${rows[i].length})`);
    }
  }
  return { rows, batch, hookCalls };
}

function conj(w: N | undefined): N[] {
  return w?.BoolExpr?.boolop === 'AND_EXPR' ? w.BoolExpr.args.flatMap(conj) : w ? [w] : [];
}
/** the scalar of the `id = <scalar>` conjunct that makes a statement a row op */
function idOf(stmt: N): N {
  const w = (stmt.UpdateStmt ?? stmt.DeleteStmt).whereClause;
  for (const x of conj(w)) {
    const e = x.A_Expr;
    if (e?.kind !== 'AEXPR_OP' || e.name[0].String.sval !== '=') continue;
    if (e.lexpr.ColumnRef?.fields.at(-1)?.String?.sval === 'id') return e.rexpr;
    if (e.rexpr.ColumnRef?.fields.at(-1)?.String?.sval === 'id') return e.lexpr;
  }
  throw new Error('not a row op');
}

// ---- Views and cursors ----------------------------------------------------------------------------------
const outName = (t: N) => t.ResTarget.name ?? t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.String?.sval;
const S = (s: string) => ({ String: { sval: s } });

export type Page = { rows: any[]; next?: unknown[] };

/**
 * Keyset pagination over a View. The sort keys (the author's plus the compiler's appended id or group
 * key) become hidden `_k<i>` columns; the cursor is the last row's keys and the next page filters on
 * them. Keys must be non-null (the ADR makes a nullable key state its NULL position; not implemented).
 */
export async function runView(site: Site, p: Program, rt: Runtime, opts: { cursor?: unknown[]; pageSize?: number } = {}): Promise<Page> {
  const [c] = compileProgram(site, p);
  if (!opts.pageSize) return { rows: await site.d1.all(render(c, site.printer), bindValues(c.binds, rt)) };
  const sel = structuredClone(c.ast.SelectStmt) as N;
  const keys: N[] = sel.sortClause;
  if (!keys?.length) throw new Refused('SQL_SHAPE', 'a cursor needs an ORDER BY');
  const visible: string[] = sel.targetList.map(outName);
  if (visible.some((n) => !n)) throw new Refused('SQL_SHAPE', 'a paged View names every output column');
  const aliasVal = new Map<string, N>(sel.targetList.map((t: N) => [outName(t), t.ResTarget.val]));
  const hidden = keys.map((k, i) => {
    const node = k.SortBy.node;
    const f = node.ColumnRef?.fields;
    const val = f?.length === 1 && aliasVal.has(f[0].String.sval) ? aliasVal.get(f[0].String.sval)! : node; // an ORDER BY alias is its select-list expression
    return { ResTarget: { name: `_k${i}`, val } };
  });
  const inner: N = { ...sel, targetList: [...sel.targetList, ...hidden], sortClause: undefined, limitCount: undefined, limitOption: 'LIMIT_OPTION_DEFAULT' };
  const base = c.binds.length;
  const cursorBinds: BindSpec[] = opts.cursor ? keys.map((_k, i) => ({ k: 'cursor', i })) : [];
  const ref = (n: string) => ({ ColumnRef: { fields: [S('_p'), S(n)] } });
  const op = (o: string, l: N, r: N): N => ({ A_Expr: { kind: 'AEXPR_OP', name: [S(o)], lexpr: l, rexpr: r } });
  const after = opts.cursor
    ? { BoolExpr: { boolop: 'OR_EXPR', args: keys.map((k, i) => ({ BoolExpr: { boolop: 'AND_EXPR', args: [
        ...keys.slice(0, i).map((_x, j) => op('=', ref(`_k${j}`), { ParamRef: { number: base + j + 1 } })),
        op(k.SortBy.sortby_dir === 'SORTBY_DESC' ? '<' : '>', ref(`_k${i}`), { ParamRef: { number: base + i + 1 } }),
      ] } })) } }
    : undefined;
  const outer: N = { SelectStmt: {
    targetList: [...visible.map((n) => ({ ResTarget: { val: ref(n), name: n } })), ...keys.map((_k, i) => ({ ResTarget: { val: ref(`_k${i}`), name: `_k${i}` } }))],
    fromClause: [{ RangeSubselect: { subquery: { SelectStmt: inner }, alias: { aliasname: '_p' } } }],
    whereClause: after,
    sortClause: keys.map((k, i) => ({ SortBy: { node: ref(`_k${i}`), sortby_dir: k.SortBy.sortby_dir, sortby_nulls: k.SortBy.sortby_nulls } })),
    limitCount: { A_Const: { ival: { ival: opts.pageSize + 1 } } }, limitOption: 'LIMIT_OPTION_COUNT', op: 'SETOP_NONE' } };
  const rows = await site.d1.all(print(outer, site.printer),bindValues([...c.binds, ...cursorBinds], rt, { cursor: opts.cursor }));
  const more = rows.length > opts.pageSize;
  const page = rows.slice(0, opts.pageSize);
  const next = more ? keys.map((_k, i) => page.at(-1)[`_k${i}`]) : undefined;
  return { rows: page.map((r) => Object.fromEntries(visible.map((n) => [n, r[n]]))), next };
}
