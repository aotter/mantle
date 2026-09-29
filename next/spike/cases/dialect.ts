// Conformance case 5: the dialect. Everything outside the chosen subset is refused with a diagnostic
// code and a position in the source SQL, by the CLI's validator; the runtime runs the same validator on
// the stripped IR, so an IR that never came from SQL (handler-built, tampered, another grammar) is held
// to the same allowlist.
import { parse } from 'libpg-query';
import type { Report } from '../src/report.ts';
import { schemas } from '../src/fixtures.ts';
import { PG_GRAMMAR, tryLower } from '../src/lower.ts';
import { Refused } from '../src/types.ts';
import type { Code, N } from '../src/types.ts';
import { stripLocations, tagRelations, validateProgram } from '../src/validate.ts';
import { applyPolicy } from '../src/policy.ts';

type Bad = { sql: string; kind?: 'view' | 'procedure'; code: Code; token?: string; inputs?: Record<string, string>; msg?: RegExp };
const v = (sql: string, code: Code, token?: string, msg?: RegExp): Bad => ({ sql, code, token, msg });
const w = (sql: string, code: Code, token?: string, msg?: RegExp): Bad => ({ sql, kind: 'procedure', code, token, msg });

const REFUSED: Bad[] = [
  // ADR-0034 case 5, in the ADR's order
  v('SELECT id FROM items OFFSET 2', 'SQL_UNSUPPORTED', 'OFFSET', /limitOffset/),
  v('SELECT sqlite_version()', 'SQL_FUNCTION', 'sqlite_version'),
  v('SELECT id FROM items WHERE id = $1', 'SQL_UNSUPPORTED', '$1', /ParamRef/),
  v('SELECT a.id FROM items a RIGHT JOIN orders o ON o.item_id = a.id', 'SQL_UNSUPPORTED', 'RIGHT', /JOIN_RIGHT/),
  w('UPDATE items SET stock = 1 FROM orders WHERE items.id = orders.item_id', 'SQL_UNSUPPORTED', 'FROM', /fromClause/),
  v('SELECT CURRENT_TIMESTAMP', 'SQL_UNSUPPORTED', 'CURRENT_TIMESTAMP', /SQLValueFunction/),
  v('SELECT id FROM nope', 'SQL_RELATION', 'nope'),
  v('SELECT id FROM _mantle_tz', 'SQL_RELATION', '_mantle_tz'),
  // the rest of "refused in 0.2.0" and "always refused"
  v('SELECT a.id FROM items a CROSS JOIN orders o', 'SQL_SHAPE', 'CROSS JOIN', /JOIN needs ON/),
  v('SELECT a.id FROM items a, orders o', 'SQL_SHAPE', undefined, /comma join/),
  v('SELECT a.id FROM items a NATURAL JOIN orders o', 'SQL_UNSUPPORTED', 'NATURAL', /isNatural/),
  v('WITH x AS (SELECT 1 AS a) SELECT a FROM x', 'SQL_UNSUPPORTED', 'WITH', /withClause/),
  v('SELECT id FROM items UNION SELECT id FROM orders', 'SQL_UNSUPPORTED', 'UNION', /SETOP_UNION/),
  v('SELECT id FROM items FOR UPDATE', 'SQL_UNSUPPORTED', 'FOR UPDATE', /lockingClause/),
  v('SELECT id FROM main.items', 'SQL_UNSUPPORTED', undefined, /schemaname/),
  w("INSERT INTO orders (item_id) VALUES ('a'), ('b')", 'SQL_SHAPE', undefined, /one row/),
  v('SELECT x.a FROM (VALUES (1), (2)) x(a)', 'SQL_SHAPE', undefined, /one row/),
  v('SELECT sum(stock) OVER (ORDER BY id ROWS 2 PRECEDING) FROM items', 'SQL_UNSUPPORTED', 'ROWS', /frameOptions/),
  v("SELECT id FROM items WHERE name ILIKE 'a'", 'SQL_UNSUPPORTED', 'ILIKE', /ILIKE/),
  v("SELECT tags -> 0 FROM items", 'SQL_UNSUPPORTED', undefined, /operator ->/),
  v('SELECT id FROM items LIMIT 2', 'SQL_SHAPE', '2', /LIMIT needs an ORDER BY/),
  v('SELECT DISTINCT cat FROM items ORDER BY cat', 'SQL_SHAPE', undefined, /DISTINCT with ORDER BY/),
  v('SELECT rowid FROM items', 'SQL_COLUMN', 'rowid'),
  v("SELECT id FROM items WHERE owner = 'o2'", 'SQL_COLUMN', 'owner', /scope and TTL/),
  v('SELECT id FROM items WHERE stock = input.nope', 'SQL_COLUMN', 'input.nope', /not a declared input/),
  v('SELECT 1 FROM items input', 'SQL_RELATION', undefined, /reserved alias/),
  v('SELECT id AS "index" FROM items', 'SQL_UNSUPPORTED', undefined, /SQLite keyword/),
  // functions outside the allowlist: the ones the ADR names as dangerous, and SQLite's own clock and formats
  v("SELECT strftime('%Y', 0, 'unixepoch')", 'SQL_FUNCTION', 'strftime'),
  v('SELECT changes()', 'SQL_FUNCTION', 'changes'),
  v("SELECT nextval('seq')", 'SQL_FUNCTION', 'nextval'),
  v('SELECT * FROM json_tree(\'[1]\')', 'SQL_FUNCTION', undefined, /json_each/),
  // types and time
  v("SELECT interval '1 day'", 'SQL_TYPE', undefined, /bind the boundary as an input/),
  v("SELECT interval '1 month'", 'SQL_TYPE', undefined, /calendar unit/),
  v("SELECT interval '1 ms'", 'SQL_TYPE', undefined, /calendar unit|not supported/),
  v("SELECT id FROM items WHERE name = like_escape('a', '!')", 'SQL_FUNCTION', undefined, /ESCAPE of a LIKE/),
  v("SELECT date_trunc('century', now())", 'SQL_TYPE', undefined, /date_trunc takes/),
  v("SELECT extract(epoch FROM now())", 'SQL_TYPE', undefined, /extract takes/),
  v('SELECT CAST(stock AS varchar) FROM items', 'SQL_TYPE', undefined, /varchar/),
  v('SELECT CAST(note AS timestamptz) FROM items', 'SQL_TYPE', undefined, /takes a literal/),
  v("SELECT '1.234'::numeric(16, 2)", 'SQL_TYPE', undefined, /precision is at most 15/),
  // search and places
  v('SELECT id FROM places WHERE near(places.loc, 25.0, 121.5, 60000)', 'SQL_FUNCTION', undefined, /at most 50000/),
  v('SELECT id FROM places WHERE near(places.loc, 25.0, 121.5, input.r)', 'SQL_FUNCTION', undefined, /literal radius/),
  v('SELECT id FROM places ORDER BY distance(places.loc, 25.0, 121.5)', 'SQL_SHAPE', undefined, /literal LIMIT/),
  // writes: what a write may not name
  w("UPDATE items SET owner = 'o2' WHERE id = 'a'", 'SQL_WRITE', 'owner'),
  w('UPDATE items SET version = 9 WHERE id = \'a\'', 'SQL_WRITE', 'version'),
  w("INSERT INTO orders (id, item_id) VALUES ('x', 'a')", 'SQL_WRITE', 'id', /generates its ids/),
  w("INSERT INTO items VALUES ('x')", 'SQL_WRITE', undefined, /column list/),
  w("UPDATE items SET nope = 1 WHERE id = 'a'", 'SQL_WRITE', 'nope', /no field nope/),
  w("UPDATE items SET stock = 1 WHERE id = 'a'; SELECT 1", 'SQL_SHAPE', undefined, /write/),
  v("UPDATE items SET stock = 1 WHERE id = 'a'", 'SQL_SHAPE', undefined, /one SELECT/),
  // never a statement of a Program or a View
  w('CREATE TABLE t (a int)', 'SQL_UNSUPPORTED', undefined, /CreateStmt/),
  w('BEGIN', 'SQL_UNSUPPORTED', undefined, /TransactionStmt/),
  w("INSERT INTO settings (key) VALUES ('x') ON CONFLICT ON CONSTRAINT nope DO NOTHING", 'SQL_UNSUPPORTED', 'ON CONSTRAINT', /conname/),
  // syntax the parser itself rejects, so no AST exists
  v('SELEC id FROM items', 'SQL_SYNTAX', 'SELEC'),
  w("INSERT OR REPLACE INTO settings (key) VALUES ('x')", 'SQL_SYNTAX', 'OR', /at or near "OR"/),
];

// valid statements next to them, so refusing everything cannot pass
const ACCEPTED: Bad[] = [
  v('SELECT id FROM items ORDER BY id LIMIT 2', 'SQL_SYNTAX'),
  v("SELECT id FROM items WHERE cat IS DISTINCT FROM 'q' ORDER BY id LIMIT 3", 'SQL_SYNTAX'),
  w("UPDATE items SET stock = stock - 1 WHERE id = 'a' RETURNING *", 'SQL_SYNTAX'),
  v('SELECT id FROM places ORDER BY distance(places.loc, 25.0, 121.5) LIMIT 100', 'SQL_SYNTAX'),
];

async function toIr(sql: string): Promise<N[]> {
  return stripLocations(tagRelations(((await parse(sql)).stmts ?? []).map((s: N) => s.stmt)));
}

export async function run(r: Report) {
  r.section('Case 5: dialect (refusals with a position)');
  const table: string[] = [];
  const problems = new Map<Code, string[]>();
  for (const bad of REFUSED) {
    const kind = bad.kind ?? 'view';
    const res = await tryLower(bad.sql, { schemas, inputs: bad.inputs ?? {}, kind });
    const d = res.ok ? undefined : res.diagnostic;
    const wrong: string[] = problems.get(bad.code) ?? [];
    problems.set(bad.code, wrong);
    table.push(`${bad.sql.slice(0, 64).padEnd(64)} -> ${d ? `${d.code} ${d.line ? `${d.line}:${d.column} '${d.token}'` : '(no position)'} ${d.message.slice(0, 70)}` : 'NOT REFUSED'}`);
    if (!(d && d.code === bad.code && (bad.token === undefined || d.token === bad.token) && (!bad.msg || bad.msg.test(d.message)))) wrong.push(`${bad.sql.slice(0, 60)}: wanted ${bad.code}, got ${d ? `${d.code} '${d.token}' ${d.message.slice(0, 60)}` : 'nothing'}`);
    // the runtime runs the same validator on the stripped IR: a structural refusal is refused there too
    if (d && bad.code !== 'SQL_SYNTAX') {
      let code: string | undefined;
      try { validateProgram(await toIr(bad.sql), { schemas, inputs: bad.inputs ?? {}, kind }); } catch (e) { code = (e as Refused).code; }
      if (code !== bad.code) wrong.push(`runtime validator on the bare IR: ${bad.sql.slice(0, 50)} gave ${code}`);
    }
  }
  r.note(`diagnostic table (${REFUSED.length} refusals):\n${table.join('\n')}`);
  for (const [code, wrong] of problems) r.check(`${code}: ${REFUSED.filter((b) => b.code === code).length} refusals give this code, the token and the message (and the runtime validator refuses the bare IR too)`, wrong.length === 0, wrong);

  const rejected: string[] = [];
  for (const ok of ACCEPTED) { const res = await tryLower(ok.sql, { schemas, inputs: {}, kind: ok.kind ?? 'view' }); if (!res.ok) rejected.push(ok.sql); }
  r.check(`negative control: ${ACCEPTED.length} valid statements next to them are accepted, so refusing everything cannot pass`, rejected.length === 0, rejected);
  // how many refusals point at a source position? (the AST has no position for some structural keys)
  const positioned = table.filter((t) => !t.includes('(no position)')).length;
  r.note(`${positioned} of ${table.length} refusals carry a line, column and token. The AST has no location for a clause key, so the CLI finds its keyword in the source (WITH, OFFSET, RIGHT, UNION, FOR UPDATE ...); ${table.length - positioned} have none (interval literal, BEGIN, a whole-statement refusal).`);

  // ---- IR that never came from SQL ---------------------------------------------------------------------------
  const base = await toIr('SELECT id FROM items ORDER BY id');
  const ctx = { schemas, inputs: {}, kind: 'view' as const };
  const clone = () => JSON.parse(JSON.stringify(base)) as N[];
  const verdict = (ir: N[], policy = false) => {
    try { validateProgram(ir, ctx); if (policy) applyPolicy(ir[0], { schemas, inputs: {} }); return 'accepted'; } catch (e) { return `${(e as Refused).code}: ${(e as Refused).message}`; }
  };
  const edit = (f: (ir: N[]) => void) => { const ir = clone(); f(ir); return ir; };
  const from = (ir: N[]) => ir[0].SelectStmt.fromClause[0].RangeVar;
  const has = (v: string, code: Code, re: RegExp) => v.startsWith(code) && re.test(v);
  const structural = [
    has(verdict(edit((ir) => { ir[0].SelectStmt.foo = 1; })), 'SQL_UNSUPPORTED', /SelectStmt\.foo/),
    has(verdict(edit((ir) => { ir[0].SelectStmt.whereClause = { Bogus: {} }; })), 'SQL_UNSUPPORTED', /Bogus/),
    has(verdict(edit((ir) => { ir[0].SelectStmt.op = 'SETOP_UNION'; })), 'SQL_UNSUPPORTED', /SETOP_UNION/),
    has(verdict(edit((ir) => { from(ir).mantle = 'system'; })), 'SQL_UNSUPPORTED', /mantle/),
  ];
  r.equal('crafted IR: an unknown key, an unknown node, an enum value outside the subset and the physical `system` tag are refused, never skipped', structural, [true, true, true, true]);
  const cte = [
    has(verdict(edit((ir) => { from(ir).mantle = 'cte'; })), 'SQL_RELATION', /cte reference is not defined/),
    has(verdict(edit((ir) => { Object.assign(from(ir), { relname: 'nowhere', mantle: 'cte' }); })), 'SQL_RELATION', /not defined in scope/),
  ];
  r.equal("crafted IR: a cte reference carrying a Schema's name (SQLite would resolve it to the unwrapped table), or not defined in scope, is refused", cte, [true, true]);
  const stray = edit((ir) => { ir[0].SelectStmt.targetList = [{ ResTarget: { val: { RangeVar: { relname: 'items', inh: true, relpersistence: 'p', mantle: 'table' } } } }]; });
  const closed = [verdict(edit((ir) => { delete from(ir).mantle; }), true).startsWith('SQL_RELATION'), has(verdict(stray, true), 'SQL_RELATION', /fail closed/)];
  r.equal('fail closed: an untagged relation, and a RangeVar reached through an unclassified edge, are refused by the policy pass, never printed bare', closed, [true, true]);

  // the plan records the PostgreSQL grammar version; another one is refused, since the AST changes between majors
  const { assertGrammar } = await import('../src/lower.ts');
  const grammar = (g: number) => { try { assertGrammar({ grammar: g }); return 'accepted'; } catch (e) { return e instanceof Refused ? 'refused' : String(e); } };
  r.equal('grammar: libpg-query 18 reports the constant the plan records; a plan built with 170004 is refused by the runtime, one with the recorded version passes',
    [(await parse('SELECT 1')).version, grammar(170004), grammar(PG_GRAMMAR)], [PG_GRAMMAR, 'refused', 'accepted']);
}
