// Spike task 1: print every allowlisted node with pgsql-deparser, run it on local D1, count overrides.
import { Deparser } from 'pgsql-deparser';
import type { Report } from '../src/report.ts';
import { boot, caller, program, reset, site } from '../src/fixtures.ts';
import { bindValues, compileProgram, runProcedure, runView, render } from '../src/exec.ts';
import { OVERRIDES, OVERRIDE_WHY, SqliteDeparser, VanillaDeparser, print } from '../src/print.ts';
import { MANTLE_LOWERINGS, PG_ONLY_REWRITES } from '../src/policy.ts';
import { BARE, ENUM, KEYS, SQLITE_ONLY_KEYWORDS } from '../src/validate.ts';
import type { N } from '../src/types.ts';
import { corpus } from './corpus.ts';
import type { Item } from './corpus.ts';

/** the official SQLite keyword list (https://sqlite.org/lang_keywords.html) */
const SQLITE_KEYWORDS = 'ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT'.split(' ').map((k) => k.toLowerCase());

type Outcome = { id: string; ok: boolean; error?: string };

/** a printer with every override of SqliteDeparser except `skip` */
function without(skip: string | undefined): typeof Deparser {
  if (skip === undefined) return SqliteDeparser;
  class Ablated extends Deparser {}
  for (const name of OVERRIDES) if (name !== skip) (Ablated.prototype as any)[name] = (SqliteDeparser.prototype as any)[name];
  return Ablated;
}

async function runItem(b: Awaited<ReturnType<typeof boot>>, item: Item, printer: typeof Deparser): Promise<{ outcome: Outcome; rows?: unknown[][]; ast?: N[] }> {
  const s = { ...site(b), printer };
  const rt = { ...caller(item.input), role: 'staff' };
  try {
    const p = await program(item.kind, item.sql, item.inputs ?? {});
    const ast = compileProgram({ ...s }, p).map((c) => c.ast);
    if (item.kind === 'procedure') await reset(b.d1);
    const rows = item.kind === 'view' ? [(await runView(s, p, rt)).rows] : (await runProcedure(s, p, rt)).rows;
    return { outcome: { id: item.id, ok: true }, rows, ast };
  } catch (e: any) {
    return { outcome: { id: item.id, ok: false, error: String(e.message).split('\n')[0].slice(0, 200) } };
  }
}

function nodeTypes(v: any, into = new Set<string>(), keys = new Set<string>()): { types: Set<string>; keys: Set<string> } {
  if (Array.isArray(v)) v.forEach((x) => nodeTypes(x, into, keys));
  else if (v && typeof v === 'object') {
    const ks = Object.keys(v);
    if (ks.length === 1 && KEYS[ks[0]]) {
      into.add(ks[0]);
      if (v[ks[0]] && typeof v[ks[0]] === 'object') for (const k of Object.keys(v[ks[0]])) keys.add(`${ks[0]}.${k}`);
    }
    for (const [k, x] of Object.entries(v)) {
      if (BARE[k] && x && typeof x === 'object') { // a node whose type key libpg-query omits
        into.add(BARE[k]);
        for (const kk of Object.keys(x)) keys.add(`${BARE[k]}.${kk}`);
      }
      nodeTypes(x, into, keys);
    }
  }
  return { types: into, keys };
}

export async function run(r: Report) {
  r.section('1. Deparser: every allowlisted node on local D1');
  const b = await boot();
  const results = new Map<string, Outcome[]>();

  // 1a. the full printer passes the whole corpus with the results PostgreSQL semantics give
  const irAst: N[] = [];
  const irNodes = new Set<string>(), irKeys = new Set<string>(), enumSeen = new Set<string>();
  const outs: Outcome[] = [];
  for (const item of corpus) {
    const { outcome, rows, ast } = await runItem(b, item, SqliteDeparser);
    let ok = outcome.ok;
    if (ok) {
      const actual = JSON.parse(JSON.stringify(rows));
      const expected = JSON.parse(JSON.stringify(item.expect));
      ok = JSON.stringify(actual) === JSON.stringify(expected);
      if (!ok) outcome.error = `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`;
    }
    outcome.ok = ok;
    outs.push(outcome);
    r.check(`corpus ${item.id}`, ok, ok ? undefined : outcome.error);
    if (ast) irAst.push(...ast);
    const p = await program(item.kind, item.sql, item.inputs ?? {}).catch(() => null);
    if (p) {
      const { types, keys } = nodeTypes(p.ir);
      types.forEach((t) => irNodes.add(t));
      keys.forEach((k) => irKeys.add(k));
      JSON.stringify(p.ir, (k, v) => { if (typeof v !== 'object' || v === null) enumSeen.add(`${k}=${JSON.stringify(v)}`); return v; });
    }
  }
  results.set('full', outs);
  r.note(`corpus: ${corpus.length} items, ${outs.filter((o) => o.ok).length} pass with SqliteDeparser`);

  // 1b. coverage of the whitelist by the corpus
  const uncoveredTypes = Object.keys(KEYS).filter((t) => !irNodes.has(t));
  const uncoveredKeys = Object.entries(KEYS).flatMap(([t, ks]) => [...ks].filter((k) => !irKeys.has(`${t}.${k}`)).map((k) => `${t}.${k}`));
  const uncoveredEnums = Object.entries(ENUM).flatMap(([k, vals]) => vals.filter((v) => !enumSeen.has(`${k.split('.')[1]}=${JSON.stringify(v)}`)).map((v) => `${k}=${v}`));
  r.note(`whitelist: ${Object.keys(KEYS).length} node types, ${Object.values(KEYS).reduce((a, k) => a + k.size, 0)} (type, key) pairs, ${Object.values(ENUM).reduce((a, v) => a + v.length, 0)} enum values`);
  r.check('every node type in the whitelist is printed by the corpus', uncoveredTypes.length === 0, uncoveredTypes);
  r.note(`(type, key) pairs the corpus does not reach: ${uncoveredKeys.join(', ') || 'none'}`);
  r.note(`enum values the corpus does not reach: ${uncoveredEnums.join(', ') || 'none'}`);
  const phys = nodeTypes(irAst).types;
  r.note(`physical AST after policy (what the printer actually saw): ${phys.size} node types: ${[...phys].sort().join(' ')}`);

  // 1c. vanilla deparser: what breaks, and which override each break needs (ablation)
  r.section('1c. Overrides: what each one is for');
  const vanilla: Outcome[] = [];
  for (const item of corpus) vanilla.push((await runItem(b, item, VanillaDeparser)).outcome);
  const vf = vanilla.filter((o) => !o.ok);
  r.note(`vanilla pgsql-deparser: ${vf.length} of ${corpus.length} corpus items fail on D1`);
  const need: Record<string, string[]> = {};
  for (const name of OVERRIDES) {
    const ab: Outcome[] = [];
    const printer = without(name);
    for (const item of corpus) {
      const { outcome, rows } = await runItem(b, item, printer);
      let ok = outcome.ok;
      if (ok) ok = JSON.stringify(JSON.parse(JSON.stringify(rows))) === JSON.stringify(JSON.parse(JSON.stringify(item.expect)));
      ab.push({ id: item.id, ok, error: outcome.error });
    }
    need[name] = ab.filter((o) => !o.ok).map((o) => o.id);
    r.check(`override ${name} is needed (without it: ${need[name].length} items fail)`, need[name].length > 0, need[name].join(', '));
  }
  r.note(`OVERRIDES (${OVERRIDES.length}): ${OVERRIDES.join(', ')}`);
  for (const o of vf.slice(0, 40)) r.note(`  vanilla fails ${o.id}: ${o.error}`);

  // 1d. names: which SQLite keywords does the printer leave bare that SQLite refuses?
  r.section('1d. Identifiers: SQLite keywords the printer would not quote');
  const gap: string[] = [];
  for (const kw of SQLITE_KEYWORDS) {
    const q = `"${kw}"`;
    await b.d1.exec([`DROP TABLE IF EXISTS kwt`, `CREATE TABLE kwt (${q} TEXT)`, `CREATE TABLE IF NOT EXISTS ${q} (x TEXT)`]).catch(() => undefined);
    const col: N = { SelectStmt: { targetList: [{ ResTarget: { val: { ColumnRef: { fields: [{ String: { sval: kw } }] } } } }], fromClause: [{ RangeVar: { relname: 'kwt', inh: true, relpersistence: 'p' } }], limitOption: 'LIMIT_OPTION_DEFAULT', op: 'SETOP_NONE' } };
    const alias: N = { SelectStmt: { targetList: [{ ResTarget: { name: kw, val: { A_Const: { ival: { ival: 1 } } } } }], limitOption: 'LIMIT_OPTION_DEFAULT', op: 'SETOP_NONE' } };
    const tbl: N = { SelectStmt: { targetList: [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }], fromClause: [{ RangeVar: { relname: kw, inh: true, relpersistence: 'p' } }], limitOption: 'LIMIT_OPTION_DEFAULT', op: 'SETOP_NONE' } };
    let bad = false;
    for (const ast of [col, alias, tbl]) if ('error' in (await b.d1.try(print(ast)))) bad = true;
    if (bad) gap.push(kw);
    await b.d1.exec([`DROP TABLE IF EXISTS ${q}`]).catch(() => undefined);
  }
  gap.sort();
  r.note(`${SQLITE_KEYWORDS.length} SQLite keywords tested as a column, an alias and a table name; ${gap.length} are printed bare and refused by SQLite: ${gap.join(' ')}`);
  r.equal('validate.ts SQLITE_ONLY_KEYWORDS equals the measurement', [...SQLITE_ONLY_KEYWORDS].sort(), gap);

  // 1e. the function allowlist: every function is prepared on local D1 (ADR-0034 decision 6, one case)
  r.section('1e. Function allowlist on local D1');
  const probes: Record<string, string> = {
    count: 'count(*)', sum: 'sum(1)', min: 'min(1)', max: 'max(1)', avg: 'avg(1)', json_group_array: 'json_group_array(1)', json_group_object: "json_group_object('a', 1)",
    lower: "lower('A')", upper: "upper('a')", length: "length('a')", abs: 'abs(-1)', round: 'round(1.5)', substr: "substr('abc', 2)", replace: "replace('a','a','b')", trim: "trim(' a')", ltrim: "ltrim(' a')", rtrim: "rtrim('a ')", instr: "instr('a','a')", typeof: 'typeof(1)', hex: "hex('a')",
    json_extract: "json_extract('[1]', '$[0]')", json_set: "json_set('[1]', '$[0]', 2)", json_insert: "json_insert('[1]', '$[#]', 2)", json_remove: "json_remove('[1]', '$[0]')", json_array_length: "json_array_length('[1]')",
    strftime: "strftime('%Y', 0, 'unixepoch')", unixepoch: "unixepoch('2026-01-01 00:00:00')", changes: 'changes()', randomblob: 'hex(randomblob(4))',
    asin: 'asin(0.5)', sqrt: 'sqrt(4)', sin: 'sin(1)', cos: 'cos(1)', radians: 'radians(1)', bm25_absent: "'n/a'", min2: 'min(1, 2)', coalesce: 'coalesce(NULL, 1)', nullif: 'nullif(1, 1)', length_text: "length('小籠包')",
  };
  for (const [name, expr] of Object.entries(probes)) {
    if (name.endsWith('_absent')) continue;
    const res = await b.d1.try(`SELECT ${expr} AS x`);
    r.check(`function ${name} is authorized`, !('error' in res), 'error' in res ? res.error : undefined);
  }
  for (const f of ['power(2, 3)', 'ceiling(1.5)', 'sqlite_version()', 'json_pretty(\'[1]\')', 'unistr(\'a\')', 'random()', 'printf(\'%d\', 1)', 'concat(\'a\', \'b\')']) {
    const res = await b.d1.try(`SELECT ${f} AS x`);
    r.note(`  ${f}: ${'error' in res ? 'refused by D1 (' + res.error.split(':')[1]?.trim() + ')' : 'allowed'}`);
  }
  // 1f. precedence: the printer must keep the tree's shape when SQLite re-parses the text
  r.section('1f. Operator precedence: random expression trees, printed then evaluated by D1');
  let seedN = 20260929;
  const rnd = () => { seedN = (seedN + 0x6d2b79f5) | 0; let t = Math.imul(seedN ^ (seedN >>> 15), 1 | seedN); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const S = (s: string) => ({ String: { sval: s } });
  const k = (n: number): N => ({ A_Const: { ival: { ival: n } } });
  class Retry extends Error {}
  const gInt = (d: number): { ast: N; v: number } => {
    if (d === 0 || rnd() < 0.25) { const n = Math.floor(rnd() * 10); return { ast: k(n), v: n }; }
    const c = rnd();
    if (c < 0.12) { const x = gInt(d - 1); return { ast: { A_Expr: { kind: 'AEXPR_OP', name: [S('-')], rexpr: x.ast } }, v: -x.v }; }
    if (c < 0.22) { const cond = gBool(d - 1), a = gInt(d - 1), b = gInt(d - 1); return { ast: { CaseExpr: { args: [{ CaseWhen: { expr: cond.ast, result: a.ast } }], defresult: b.ast } }, v: cond.v ? a.v : b.v }; }
    const op = pick(['+', '-', '*', '/', '%']), a = gInt(d - 1), b = gInt(d - 1);
    if ((op === '/' || op === '%') && b.v === 0) throw new Retry();
    const v = op === '+' ? a.v + b.v : op === '-' ? a.v - b.v : op === '*' ? a.v * b.v : op === '/' ? Math.trunc(a.v / b.v) : a.v % b.v;
    return { ast: { A_Expr: { kind: 'AEXPR_OP', name: [S(op)], lexpr: a.ast, rexpr: b.ast } }, v };
  };
  const gBool = (d: number): { ast: N; v: boolean } => {
    const c = rnd();
    if (d === 0 || c < 0.5) {
      const op = pick(['=', '<>', '<', '>', '<=', '>=']), a = gInt(d), b = gInt(d);
      const v = op === '=' ? a.v === b.v : op === '<>' ? a.v !== b.v : op === '<' ? a.v < b.v : op === '>' ? a.v > b.v : op === '<=' ? a.v <= b.v : a.v >= b.v;
      return { ast: { A_Expr: { kind: 'AEXPR_OP', name: [S(op)], lexpr: a.ast, rexpr: b.ast } }, v };
    }
    if (c < 0.65) { const x = gBool(d - 1); return { ast: { BoolExpr: { boolop: 'NOT_EXPR', args: [x.ast] } }, v: !x.v }; }
    const a = gBool(d - 1), b = gBool(d - 1), and = c < 0.83;
    return { ast: { BoolExpr: { boolop: and ? 'AND_EXPR' : 'OR_EXPR', args: [a.ast, b.ast] } }, v: and ? a.v && b.v : a.v || b.v };
  };
  const trees: { ast: N; v: number | boolean }[] = [];
  while (trees.length < 400) { try { trees.push(rnd() < 0.5 ? gInt(4) : gBool(4)); } catch (e) { if (!(e instanceof Retry)) throw e; } }
  let mismatches = 0, first = '';
  for (let i = 0; i < trees.length; i += 50) {
    const chunk = trees.slice(i, i + 50);
    const sel: N = { SelectStmt: { targetList: chunk.map((t, j) => ({ ResTarget: { name: `c${j}`, val: t.ast } })), limitOption: 'LIMIT_OPTION_DEFAULT', op: 'SETOP_NONE' } };
    const sql = print(sel);
    const row = (await b.d1.all(sql))[0];
    chunk.forEach((t, j) => {
      const want = typeof t.v === 'boolean' ? (t.v ? 1 : 0) : t.v;
      if (row[`c${j}`] !== want) { mismatches++; first ||= `${print({ SelectStmt: { targetList: [{ ResTarget: { val: t.ast } }], limitOption: 'LIMIT_OPTION_DEFAULT', op: 'SETOP_NONE' } })} => D1 ${row[`c${j}`]}, tree ${want}`; }
    });
  }
  r.check(`400 random int/boolean trees (depth 4): printed SQL evaluates on D1 to the tree's value`, mismatches === 0, mismatches ? `${mismatches} mismatches, e.g. ${first}` : undefined);
  // `||` sits at a different level in SQLite than in PostgreSQL: fixed cases whose value differs if the parentheses are lost
  const concatCases: [string, string][] = [["SELECT 2 * 3 || 4", '64'], ["SELECT 1 + 2 || 3", '33'], ["SELECT 'x' || 1 + 1", 'x2'], ["SELECT (2 || 3) * 4", '92'], ["SELECT 2 || 3 * 4", '212'], ["SELECT - 2 || 3", '-23']];
  for (const [sql, want] of concatCases) {
    const p = await program('view', `${sql} AS x FROM items WHERE id = 'a'`);
    const [c] = compileProgram(site(b), p);
    const got = String((await b.d1.all(render(c), bindValues(c.binds, caller())))[0]?.x ?? 'no row');
    r.check(`|| precedence: ${sql} = ${want}`, got === want, `printed: ${render(c).slice(0, 40)} ... => ${got}`);
  }
  r.section('1g. Where the printed text differs from what PostgreSQL prints');
  r.note(`printer overrides (subclass methods of pgsql-deparser's Deparser): ${OVERRIDES.length}`);
  for (const o of OVERRIDES) r.note(`  - ${o}: ${OVERRIDE_WHY[o]}`);
  r.note(`AST rewrites in policy.ts because SQLite lacks the PostgreSQL construct (not printer methods): ${PG_ONLY_REWRITES.length}`);
  for (const o of PG_ONLY_REWRITES) r.note(`  - ${o}`);
  r.note(`Mantle constructs lowered to plain SQLite (features, not PostgreSQL differences): ${MANTLE_LOWERINGS.length}`);
  for (const o of MANTLE_LOWERINGS) r.note(`  - ${o}`);
  r.check(`ADR threshold: overrides (${OVERRIDES.length}) stay under "about a dozen" (12), so Kysely is not needed`, OVERRIDES.length <= 12);
  await b.d1.dispose();
  return { overrides: OVERRIDES, need, gap, vanillaFailures: vf.length };
}
