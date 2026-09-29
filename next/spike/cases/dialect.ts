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
  v('SELECT a.id FROM items a FULL JOIN orders o ON o.item_id = a.id', 'SQL_UNSUPPORTED', 'FULL', /JOIN_FULL/),
  v('SELECT a.id FROM items a CROSS JOIN orders o', 'SQL_SHAPE', 'CROSS JOIN', /JOIN needs ON/),
  v('SELECT a.id FROM items a, orders o', 'SQL_SHAPE', undefined, /comma join/),
  v('SELECT a.id FROM items a NATURAL JOIN orders o', 'SQL_UNSUPPORTED', 'NATURAL', /isNatural/),
  v('SELECT a.id FROM items a JOIN orders o USING (id)', 'SQL_UNSUPPORTED', 'USING', /usingClause/),
  v('SELECT id FROM items GROUP BY GROUPING SETS ((id), ())', 'SQL_UNSUPPORTED', 'GROUPING SETS'),
  v('WITH x AS (SELECT 1 AS a) SELECT a FROM x', 'SQL_UNSUPPORTED', 'WITH', /withClause/),
  v('WITH RECURSIVE x(a) AS (SELECT 1 UNION ALL SELECT a + 1 FROM x) SELECT a FROM x', 'SQL_UNSUPPORTED', 'WITH', /withClause/),
  w('WITH d AS (DELETE FROM items RETURNING id) INSERT INTO orders (item_id) SELECT id FROM d', 'SQL_UNSUPPORTED', 'WITH', /withClause/),
  v('SELECT id FROM items UNION SELECT id FROM orders', 'SQL_UNSUPPORTED', 'UNION', /SETOP_UNION/),
  v('SELECT id FROM items INTERSECT SELECT id FROM orders', 'SQL_UNSUPPORTED', 'INTERSECT', /SETOP_INTERSECT/),
  v('SELECT id FROM items FOR UPDATE', 'SQL_UNSUPPORTED', 'FOR UPDATE', /lockingClause/),
  v('SELECT id INTO t FROM items', 'SQL_UNSUPPORTED', 'INTO', /intoClause/),
  v('SELECT id FROM main.items', 'SQL_UNSUPPORTED', undefined, /schemaname/),
  w('DELETE FROM items USING orders WHERE items.id = orders.item_id', 'SQL_UNSUPPORTED', 'USING', /usingClause/),
  w("INSERT INTO orders (item_id) VALUES ('a'), ('b')", 'SQL_SHAPE', undefined, /one row/),
  v('SELECT x.a FROM (VALUES (1), (2)) x(a)', 'SQL_SHAPE', undefined, /one row/),
  v('SELECT sum(stock) OVER (ORDER BY id ROWS 2 PRECEDING) FROM items', 'SQL_UNSUPPORTED', 'ROWS', /frameOptions/),
  v("SELECT id FROM items WHERE name ILIKE 'a'", 'SQL_UNSUPPORTED', 'ILIKE', /ILIKE/),
  v("SELECT id FROM items WHERE name ~ 'a'", 'SQL_UNSUPPORTED', '~', /operator ~/),
  v("SELECT tags -> 0 FROM items", 'SQL_UNSUPPORTED', undefined, /operator ->/),
  v('SELECT id FROM items LIMIT 2', 'SQL_SHAPE', '2', /LIMIT needs an ORDER BY/),
  v('SELECT DISTINCT cat FROM items ORDER BY cat', 'SQL_SHAPE', undefined, /DISTINCT with ORDER BY/),
  v('SELECT DISTINCT ON (cat) cat FROM items ORDER BY cat', 'SQL_UNSUPPORTED', 'DISTINCT ON', /DISTINCT ON/),
  v('SELECT rowid FROM items', 'SQL_COLUMN', 'rowid'),
  v("SELECT id FROM items WHERE owner = 'o2'", 'SQL_COLUMN', 'owner', /scope and TTL/),
  v('SELECT id FROM items WHERE expires_at > 0', 'SQL_COLUMN', 'expires_at', /scope and TTL/),
  v('SELECT id FROM items WHERE stock = input.nope', 'SQL_COLUMN', 'input.nope', /not a declared input/),
  v('SELECT 1 FROM items input', 'SQL_RELATION', undefined, /reserved alias/),
  v('SELECT id AS "index" FROM items', 'SQL_UNSUPPORTED', undefined, /SQLite keyword/),
  // functions outside the allowlist: the ones the ADR names as dangerous, and SQLite's own clock and formats
  v("SELECT strftime('%Y', 0, 'unixepoch')", 'SQL_FUNCTION', 'strftime'),
  v("SELECT date('now')", 'SQL_FUNCTION', 'date'),
  v('SELECT unixepoch(0)', 'SQL_FUNCTION', 'unixepoch'),
  v("SELECT printf('%1000000d', 1)", 'SQL_FUNCTION', 'printf'),
  v('SELECT zeroblob(1000000)', 'SQL_FUNCTION', 'zeroblob'),
  v('SELECT randomblob(1000000)', 'SQL_FUNCTION', 'randomblob'),
  v('SELECT last_insert_rowid()', 'SQL_FUNCTION', 'last_insert_rowid'),
  v('SELECT changes()', 'SQL_FUNCTION', 'changes'),
  v("SELECT nextval('seq')", 'SQL_FUNCTION', 'nextval'),
  v('SELECT * FROM json_tree(\'[1]\')', 'SQL_FUNCTION', undefined, /json_each/),
  // types and time
  v("SELECT interval '1 day'", 'SQL_TYPE', undefined, /bind the boundary as an input/),
  v("SELECT interval '1 month'", 'SQL_TYPE', undefined, /calendar unit/),
  v("SELECT interval '1 week'", 'SQL_TYPE', undefined, /calendar unit/),
  v("SELECT interval '1 year'", 'SQL_TYPE', undefined, /calendar unit/),
  v("SELECT date_trunc('century', now())", 'SQL_TYPE', undefined, /date_trunc takes/),
  v("SELECT extract(epoch FROM now())", 'SQL_TYPE', undefined, /extract takes/),
  v('SELECT CAST(stock AS varchar) FROM items', 'SQL_TYPE', undefined, /varchar/),
  v('SELECT CAST(note AS timestamptz) FROM items', 'SQL_TYPE', undefined, /takes a literal/),
  v("SELECT '1.234'::numeric(16, 2)", 'SQL_TYPE', undefined, /precision is at most 15/),
  v('SELECT stock::numeric(12, 2) FROM items', 'SQL_TYPE', undefined, /takes a literal/),
  // search and places
  v('SELECT id FROM places WHERE near(places.loc, 25.0, 121.5, 60000)', 'SQL_FUNCTION', undefined, /at most 50000/),
  v('SELECT id FROM places WHERE near(places.loc, 25.0, 121.5, input.r)', 'SQL_FUNCTION', undefined, /literal radius/),
  v('SELECT id FROM places ORDER BY distance(places.loc, 25.0, 121.5) LIMIT 500', 'SQL_SHAPE', undefined, /at most 100/),
  v('SELECT id FROM places ORDER BY distance(places.loc, 25.0, 121.5)', 'SQL_SHAPE', undefined, /literal LIMIT/),
  v('SELECT id FROM notes WHERE search(notes)', 'SQL_FUNCTION', undefined, /search\(<alias>, <query>\)/),
  // writes: what a write may not name
  w("UPDATE items SET owner = 'o2' WHERE id = 'a'", 'SQL_WRITE', 'owner'),
  w("INSERT INTO settings (owner, key) VALUES ('o2', 'x')", 'SQL_WRITE', 'owner'),
  w('UPDATE items SET version = 9 WHERE id = \'a\'', 'SQL_WRITE', 'version'),
  w("UPDATE items SET id = 'z' WHERE id = 'a'", 'SQL_WRITE', 'id'),
  w("INSERT INTO orders (id, item_id) VALUES ('x', 'a')", 'SQL_WRITE', 'id', /generates its ids/),
  w("INSERT INTO settings (key, value) VALUES ('k', 'v') ON CONFLICT (key) DO UPDATE SET owner = 'o2'", 'SQL_WRITE', 'owner'),
  w("INSERT INTO items VALUES ('x')", 'SQL_WRITE', undefined, /column list/),
  w("UPDATE items SET nope = 1 WHERE id = 'a'", 'SQL_WRITE', 'nope', /no field nope/),
  w("UPDATE items SET stock = 1 WHERE id = 'a'; SELECT 1", 'SQL_SHAPE', undefined, /write/),
  v("UPDATE items SET stock = 1 WHERE id = 'a'", 'SQL_SHAPE', undefined, /one SELECT/),
  // never a statement of a Program or a View
  w('CREATE TABLE t (a int)', 'SQL_UNSUPPORTED', undefined, /CreateStmt/),
  w('DROP TABLE items', 'SQL_UNSUPPORTED', undefined, /DropStmt/),
  w('BEGIN', 'SQL_UNSUPPORTED', undefined, /TransactionStmt/),
  w("INSERT INTO settings (key) VALUES ('x') ON CONFLICT ON CONSTRAINT nope DO NOTHING", 'SQL_UNSUPPORTED', 'ON CONSTRAINT', /conname/),
  // syntax the parser itself rejects, so no AST exists
  v('SELEC id FROM items', 'SQL_SYNTAX', 'SELEC'),
  v("SELECT 'unterminated FROM items", 'SQL_SYNTAX'),
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
  for (const bad of REFUSED) {
    const kind = bad.kind ?? 'view';
    const res = await tryLower(bad.sql, { schemas, inputs: bad.inputs ?? {}, kind });
    const d = res.ok ? undefined : res.diagnostic;
    const tokenOk = bad.token === undefined || d?.token === bad.token;
    const ok = !!d && d.code === bad.code && tokenOk && (!bad.msg || bad.msg.test(d.message));
    table.push(`${bad.sql.slice(0, 64).padEnd(64)} -> ${d ? `${d.code} ${d.line ? `${d.line}:${d.column} '${d.token}'` : '(no position)'} ${d.message.slice(0, 70)}` : 'NOT REFUSED'}`);
    r.check(`refused: ${bad.sql.slice(0, 70)}`, ok, ok ? undefined : { wanted: bad.code, token: bad.token, got: d });
    // the runtime runs the same validator on the stripped IR: a structural refusal is refused there too
    if (d && bad.code !== 'SQL_SYNTAX') {
      let code: string | undefined;
      try { validateProgram(await toIr(bad.sql), { schemas, inputs: bad.inputs ?? {}, kind }); } catch (e) { code = (e as Refused).code; }
      r.check(`  runtime validator on the bare IR refuses it too: ${bad.sql.slice(0, 50)}`, code === bad.code, code);
    }
  }
  const withPos = REFUSED.filter((b) => b.code !== 'SQL_SYNTAX').length;
  r.note(`diagnostic table (${REFUSED.length} refusals):\n${table.join('\n')}`);
  void withPos;

  for (const ok of ACCEPTED) {
    const res = await tryLower(ok.sql, { schemas, inputs: {}, kind: ok.kind ?? 'view' });
    r.check(`accepted: ${ok.sql.slice(0, 70)}`, res.ok, res.ok ? undefined : res.diagnostic);
  }
  // how many refusals point at a source position? (the AST has no position for some structural keys)
  const positioned = table.filter((t) => !t.includes('(no position)')).length;
  r.note(`${positioned} of ${table.length} refusals carry a line, column and token. The AST has no location for a clause key, so the CLI finds its keyword in the source (WITH, OFFSET, RIGHT, UNION, FOR UPDATE ...); ${table.length - positioned} have none (interval literal, DROP, BEGIN, a whole-statement shape).`);

  // ---- IR that never came from SQL ---------------------------------------------------------------------------
  const base = await toIr('SELECT id FROM items ORDER BY id');
  const ctx = { schemas, inputs: {}, kind: 'view' as const };
  const refuses = (name: string, ir: N[], code: Code, msg?: RegExp) => {
    let err: Refused | undefined;
    try { validateProgram(ir, ctx); } catch (e) { err = e as Refused; }
    r.check(`crafted IR: ${name}`, err?.code === code && (!msg || msg.test(err.message)), err ? `${err.code}: ${err.message}` : 'not refused');
  };
  const clone = () => JSON.parse(JSON.stringify(base)) as N[];
  const withKey = clone(); withKey[0].SelectStmt.foo = 1;
  refuses('an unknown key on a known node is refused, never skipped', withKey, 'SQL_UNSUPPORTED', /SelectStmt\.foo/);
  const withNode = clone(); withNode[0].SelectStmt.whereClause = { Bogus: {} };
  refuses('an unknown node type is refused', withNode, 'SQL_UNSUPPORTED', /Bogus/);
  const cte = clone(); cte[0].SelectStmt.fromClause[0].RangeVar.mantle = 'cte';
  refuses("a cte reference carrying a Schema's name (SQLite would resolve it to the unwrapped table)", cte, 'SQL_RELATION', /cte reference is not defined/);
  const cte2 = clone(); cte2[0].SelectStmt.fromClause[0].RangeVar = { ...cte2[0].SelectStmt.fromClause[0].RangeVar, relname: 'nowhere', mantle: 'cte' };
  refuses('a cte reference that is not defined in scope', cte2, 'SQL_RELATION', /not defined in scope/);
  const sys = clone(); sys[0].SelectStmt.fromClause[0].RangeVar.mantle = 'system';
  refuses('the physical `system` tag cannot be supplied by an IR author', sys, 'SQL_UNSUPPORTED', /mantle/);
  const enumBad = clone(); enumBad[0].SelectStmt.op = 'SETOP_UNION';
  refuses('an enum value outside the subset', enumBad, 'SQL_UNSUPPORTED', /SETOP_UNION/);

  // untagged relation: passes the structural check, and the policy pass (which prints Schema references) refuses it
  const untagged = clone(); delete untagged[0].SelectStmt.fromClause[0].RangeVar.mantle;
  let e1: Refused | undefined;
  try { validateProgram(untagged, ctx); applyPolicy(untagged[0], { schemas, inputs: {} }); } catch (e) { e1 = e as Refused; }
  r.check('an untagged relation is refused by the policy pass, not printed bare', e1?.code === 'SQL_RELATION', e1?.message);

  // fail closed: a relation in a position the policy pass has no name for is never printed unwrapped
  const stray = clone(); stray[0].SelectStmt.targetList = [{ ResTarget: { val: { RangeVar: { relname: 'items', inh: true, relpersistence: 'p', mantle: 'table' } } } }];
  let e2: Refused | undefined;
  try { validateProgram(stray, ctx); applyPolicy(stray[0], { schemas, inputs: {} }); } catch (e) { e2 = e as Refused; }
  r.check('a RangeVar reached through an unclassified edge: refused by the policy pass (fail closed)', e2?.code === 'SQL_RELATION' && /fail closed/.test(e2.message), e2?.message);

  // the plan records the PostgreSQL grammar version; another one is refused, since the AST changes between majors
  r.equal('the grammar version libpg-query 18 reports matches the constant the plan records', (await parse('SELECT 1')).version, PG_GRAMMAR);
  await assertGrammarRefuses(r);
}

async function assertGrammarRefuses(r: Report) {
  const { assertGrammar } = await import('../src/lower.ts');
  let err: unknown;
  try { assertGrammar({ grammar: 170004 }); } catch (e) { err = e; }
  r.check('a plan built with PostgreSQL grammar 170004 is refused by the runtime', err instanceof Refused, String(err));
  r.check('a plan built with the recorded grammar passes', (() => { try { assertGrammar({ grammar: PG_GRAMMAR }); return true; } catch { return false; } })());
}
