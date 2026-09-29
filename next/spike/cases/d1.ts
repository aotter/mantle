// What the spike relies on, measured on local D1 (workerd). Production D1 is a separate check
// (handoff task 4); `production-probe.sql` holds the same statements for someone to run there.
import { readFileSync } from 'node:fs';
import type { Report } from '../src/report.ts';
import { LocalD1 } from '../src/d1.ts';

export async function run(r: Report) {
  r.section('Local D1 facts the design relies on');
  const pkg = (name: string) => JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
  r.note(`workerd ${pkg('workerd')}, miniflare ${pkg('miniflare')}, wrangler ${pkg('wrangler')} (the versions pnpm-lock.yaml pins for the monorepo)`);
  const d1 = await LocalD1.create();
  const ok = async (sql: string) => !('error' in (await d1.try(sql)));

  const vt: Record<string, boolean> = {};
  for (const [name, sql] of Object.entries({
    fts5_trigram: "CREATE VIRTUAL TABLE v1 USING fts5(a, tokenize='trigram')",
    rtree: 'CREATE VIRTUAL TABLE v2 USING rtree(id, minx, maxx, miny, maxy)',
    fts5vocab: "CREATE VIRTUAL TABLE v3 USING fts5vocab(v1, 'row')",
    rtree_i32: 'CREATE VIRTUAL TABLE v4 USING rtree_i32(id, a, b)',
    geopoly: 'CREATE VIRTUAL TABLE v5 USING geopoly(a)',
    fts4: 'CREATE VIRTUAL TABLE v6 USING fts4(a)',
  })) vt[name] = await ok(sql);
  r.note(`virtual table modules: ${Object.entries(vt).map(([k, v]) => `${k} ${v ? 'allowed' : 'refused'}`).join(', ')}`);
  r.check('FTS5 with the trigram tokenizer can be created', vt.fts5_trigram);
  r.check('R*Tree can be created (workerd 1.20260730 refused it: only fts5 modules were authorized)', vt.rtree);

  // what the compiled output uses; each entry is true when D1 accepts it
  const fk = await ok('CREATE TABLE p (id TEXT PRIMARY KEY) STRICT') && await ok('CREATE TABLE c (id TEXT PRIMARY KEY, p TEXT REFERENCES p(id)) STRICT') && !(await ok("INSERT INTO c VALUES ('x', 'nope')"));
  const uses: Record<string, boolean> = {
    'bm25() and snippet() on the trigram table': await ok("INSERT INTO v1 (a) VALUES ('hello world')") && (await d1.all("SELECT bm25(v1) AS b, snippet(v1, 0, '[', ']', '..', 5) AS s FROM v1 WHERE v1 = '\"hello\"'")).length === 1,
    'radians sin cos asin sqrt atan2 (haversine)': await ok('SELECT radians(1), sin(1), cos(1), asin(0.5), sqrt(4), atan2(1, 1)'),
    'strftime and unixepoch (the source refuses them)': await ok("SELECT strftime('%Y', 0, 'unixepoch'), unixepoch('2026-01-01 00:00:00')"),
    'changes(), and RAISE(IGNORE) in a BEFORE INSERT trigger stores no row': await ok('CREATE TABLE a1 (op INTEGER, ok INTEGER)') && await ok('CREATE TRIGGER a1t BEFORE INSERT ON a1 BEGIN SELECT RAISE(IGNORE); END') && await ok('INSERT INTO a1 SELECT 1, changes() = 1') && (await d1.all('SELECT count(*) n FROM a1'))[0].n === 0,
    'EXPLAIN QUERY PLAN': await ok('EXPLAIN QUERY PLAN SELECT 1'),
    'generated STRICT tables, with foreign keys enforced by default': await ok('CREATE TABLE s1 (id TEXT PRIMARY KEY, n INTEGER) STRICT') && fk,
  };
  r.check('the SQLite features the compiled output relies on are authorized and behave', Object.values(uses).every(Boolean), Object.entries(uses).filter(([, v]) => !v).map(([k]) => k));

  // limits the compiler must respect, and the functions the ADR lists as refused
  const binds = async (n: number) => !('error' in (await d1.try(`SELECT ${Array.from({ length: n }, (_, i) => `?${i + 1}`).join(', ')}`, Array.from({ length: n }, (_, i) => i))));
  const big = await d1.try(`SELECT '${'x'.repeat(100_100)}' AS s`);
  r.check('100 bound parameters are accepted and 101 are refused; a statement over 100 KB is refused', (await binds(100)) && !(await binds(101)) && 'error' in big);
  const fn: Record<string, boolean> = {};
  for (const f of ['sqlite_version()', 'power(2, 3)', 'ceiling(1.5)', "json_pretty('[1]')", "unistr('a')"]) fn[f] = await ok(`SELECT ${f}`);
  r.check('the functions the ADR lists as refused are refused', Object.values(fn).every((v) => !v), JSON.stringify(fn));
  await d1.dispose();
}
