// @ts-nocheck test code over loosely typed IR and rows
// Conformance case 8: search and places. A trigram match and a two-character fallback, a phrase
// containing FTS5 operators matched literally, another owner's rows absent from search() and near(),
// and near() returning the closest K in order.
import type { Report } from '../report.js';
import { compileSql as tryLower, SqlRefusal as Refused } from '../../spec/index.js';
import type { DatabaseDriver } from '../../core/driver.js';
import { CENTER, boot, caller, isRefusal, north, program, site } from '../harness.js';
import { runProcedure, runView } from '../harness.js';


const R = 6_371_008.8;
const haversine = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const rad = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};

export async function run(r: Report, driver: DatabaseDriver) {
  r.section('Case 8: search and places');
  const b = await boot(driver);
  const s = site(b);
  const search = async (q: string, caller_ = 'o1') =>
    (await runView(s, await program('view', 'SELECT id FROM notes WHERE mantle.search(notes, input.q) ORDER BY id', { q: 'text' }), caller({ q }, caller_))).rows.map((x: any) => x.id as string);
  const raw = async (q: string) => (await b.d1.all('SELECT rowid FROM "_mantle_fts_notes" WHERE "_mantle_fts_notes" = ?1', [q])).length;

  // ---- full-text: trigram, with a LIKE fallback under three characters -------------------------------------------------
  r.equal('trigram: 小籠包 matches by substring; raw FTS5 matches nothing for 小籠, so search() falls back to LIKE (小籠, 包); ASCII is case-insensitive',
    [await search('小籠包'), await raw('"小籠"'), await search('小籠'), await search('包'), await search('HELLO')], [['n1'], 0, ['n1'], ['n1'], ['n2', 'n4', 'n5']]);
  // the query is bound as a quoted phrase, never as FTS5 syntax; the fallback escapes LIKE wildcards
  r.equal('FTS5 syntax is literal (OR, title:, NEAR(, *, -, a quote, an unbalanced quote) and LIKE wildcards are escaped (5%, _b, a_)',
    [await search('hello OR world'), await search('title:hello'), await Promise.all(['NEAR(a b)', 'hel*', '-hello', 'say "hi"', '"unbalanced'].map((q) => search(q))), await search('5%'), await search('_b'), await search('a_')],
    [['n5'], ['n5'], [[], [], [], [], []], ['n4'], ['n4'], ['n4']]);

  // ---- other owners and expired rows -----------------------------------------------------------------------------
  const rank = await program('view', 'SELECT id FROM notes WHERE mantle.search(notes, input.q) ORDER BY mantle.search_rank(notes), id', { q: 'text' });
  const pub = async (q: string) => (await runView({ ...s, mode: 'public' }, await program('view', 'SELECT id FROM posts WHERE mantle.search(posts, input.q) ORDER BY id', { q: 'text' }), caller({ q }))).rows.map((x: any) => x.id);
  r.equal("another owner's and expired rows are absent from search(), mantle.search_rank() and a public View; the other owner finds their own",
    [await search('LEAK'), (await runView(s, rank, caller({ q: 'LEAK' }))).rows, await pub('LEAK'), await pub('public'), await search('小籠包', 'o2')], [[], [], [], ['p1'], ['X_n1']]);
  r.equal('search_rank orders by bm25: the note with the most occurrences of apple first', (await runView(s, rank, caller({ q: 'apple' }))).rows.map((x: any) => x.id), ['n3', 'n2']);

  // ---- triggers keep the index in step; D1's meta.changes counts them, changes() does not -------------------------------------
  const res = await runProcedure(s, await program('procedure', "UPDATE notes SET title = 'renamed zebra' WHERE id = 'n3' RETURNING id", {}), caller());
  const afterUpdate = [await search('zebra'), (await search('apple apple')).includes('n3')];
  const changes = (await b.d1.batch([{ sql: "UPDATE notes SET title = 'renamed zebra again' WHERE id = 'n3'" }]))[0].changes;
  await runProcedure(s, await program('procedure', "DELETE FROM notes WHERE id = 'n3'"), caller());
  const afterDelete = await search('zebra');
  await runProcedure(s, await program('procedure', "INSERT INTO notes (title, body) VALUES ('fresh mango note', 'x')"), caller());
  r.equal('the FTS index follows UPDATE (new text found, old not), DELETE and INSERT; the row op still passed its count check', [afterUpdate, afterDelete, (await search('mango')).length, res.rows], [[['n3'], false], [], 1, [[{ id: 'n3' }]]]);
  r.check("D1's meta.changes for a one-row UPDATE on a table with FTS triggers counts the trigger's writes (not 1), so changes() inside the batch is what decides CONFLICT", changes !== 1, `meta.changes = ${changes}`);

  // ---- places: R*Tree + haversine -----------------------------------------------------------------------------------
  const near = async (meters: number, extra = '') => (await runView(s, await program('view', `SELECT id FROM places WHERE mantle.near(places.loc, input.lat, input.lng, ${meters}) ${extra} ORDER BY id`, { lat: 'float8', lng: 'float8' }), caller({ lat: CENTER.lat, lng: CENTER.lng }))).rows.map((x: any) => x.id as string);
  const places = [['pl300', 300], ['pl1200', 1200], ['pl4900', 4900], ['pl5200', 5200], ['pl10000', 10000]] as const;
  const truth = (m: number) => places.filter(([, d]) => haversine(CENTER.lat, CENTER.lng, north(d), CENTER.lng) <= m).map(([id]) => id).sort();
  r.equal('near 1 km / 5 km / 20 km: the places inside (4900 m in, 5200 m out of 5 km; no other owner\'s or expired place at 300 m), as an independent haversine says',
    [await near(1000), await near(5000), await near(20000)], [truth(1000), truth(5000), truth(20000)]);
  r.equal('and the three sets are the ones the fixtures were built for', [truth(1000), truth(5000), truth(20000)], [['pl300'], ['pl1200', 'pl300', 'pl4900'], ['pl10000', 'pl1200', 'pl300', 'pl4900', 'pl5200']]);

  const closest = await program('view', 'SELECT id, mantle.distance(places.loc, input.lat, input.lng) AS d FROM places WHERE mantle.near(places.loc, input.lat, input.lng, 50000) ORDER BY mantle.distance(places.loc, input.lat, input.lng) LIMIT 3', { lat: 'float8', lng: 'float8' });
  const rows = (await runView(s, closest, caller({ lat: CENTER.lat, lng: CENTER.lng }))).rows as any[];
  const err = Math.max(...rows.map((x, i) => Math.abs(x.d - haversine(CENTER.lat, CENTER.lng, north([300, 1200, 4900][i]), CENTER.lng))));
  r.check('closest K = 3 in order of distance, and distance() agrees with an independent haversine to under 1 m', JSON.stringify(rows.map((x) => x.id)) === '["pl300","pl1200","pl4900"]' && err < 1, `max error ${err.toExponential(2)} m`);

  // triggers keep the R*Tree in step
  await runProcedure(s, await program('procedure', "UPDATE places SET loc_lat = input.lat, loc_lng = input.lng WHERE id = 'pl10000'", { lat: 'float8', lng: 'float8' }), caller({ lat: north(100), lng: CENTER.lng }));
  const moved = await near(1000);
  await runProcedure(s, await program('procedure', "DELETE FROM places WHERE id = 'pl300'"), caller());
  const deleted = await near(1000);
  await runProcedure(s, await program('procedure', "INSERT INTO places (name, loc_lat, loc_lng) VALUES ('new', input.lat, input.lng)", { lat: 'float8', lng: 'float8' }), caller({ lat: north(50), lng: CENTER.lng }));
  r.equal('the R*Tree follows a move (pl10000 now within 1 km), a delete, and an insert', [moved, deleted, (await near(1000)).length], [['pl10000', 'pl300'], ['pl10000'], 2]);

  // limits
  const across: unknown[] = [];
  for (const input of [{ lat: 0, lng: 179.99 }, { lat: 89.99, lng: 0 }]) {
    try { await runView(s, await program('view', 'SELECT id FROM places WHERE mantle.near(places.loc, input.lat, input.lng, 5000)', { lat: 'float8', lng: 'float8' }), caller(input)); across.push('accepted'); } catch (x) { across.push(isRefusal(x) && /antimeridian or a pole/.test(x.message)); }
  }
  r.equal('a box across the antimeridian and a box across a pole are refused at run time', across, [true, true]);
}
