// Conformance case 8: search and places. A trigram match and a two-character fallback, a phrase
// containing FTS5 operators matched literally, another owner's rows absent from search() and near(),
// and near() returning the closest K in order.
import type { Report } from '../src/report.ts';
import { CENTER, METERS_PER_DEGREE_LAT, boot, caller, north, program, site } from '../src/fixtures.ts';
import { runProcedure, runView } from '../src/exec.ts';
import { Refused } from '../src/types.ts';

const R = 6_371_008.8;
const haversine = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const rad = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};

export async function run(r: Report) {
  r.section('Case 8: search and places');
  const b = await boot();
  const s = site(b);
  const search = async (q: string, caller_ = 'o1') =>
    (await runView(s, await program('view', 'SELECT id FROM notes WHERE search(notes, input.q) ORDER BY id', { q: 'text' }), caller({ q }, caller_))).rows.map((x: any) => x.id as string);
  const raw = async (q: string) => (await b.d1.all('SELECT rowid FROM "_mantle_fts_notes" WHERE "_mantle_fts_notes" = ?1', [q])).length;

  // ---- full-text: trigram ------------------------------------------------------------------------------------
  r.equal('a three-character Chinese query matches by substring (小籠包)', await search('小籠包'), ['n1']);
  r.equal('FTS5 trigram itself matches nothing under three characters (raw query for 小籠)', await raw('"小籠"'), 0);
  r.equal('search() falls back to LIKE for a two-character query and finds it (小籠)', await search('小籠'), ['n1']);
  r.equal('and for a one-character query (包)', await search('包'), ['n1']);
  r.equal('ASCII is case-insensitive: HELLO finds Hello World, hello there and title:hello OR world', await search('HELLO'), ['n2', 'n4', 'n5']);
  r.equal('a word inside the body matches: xiaolongbao', await search('xiaolongbao'), ['n1']);

  // ---- the query is bound as a quoted phrase, never as FTS5 syntax -------------------------------------------------
  r.equal('"hello OR world" is one literal phrase, not two terms (no note contains it, "title:hello OR world" does contain "hello OR world")', await search('hello OR world'), ['n5']);
  r.equal('column filter syntax is literal: title:hello matches only the note containing the text title:hello', await search('title:hello'), ['n5']);
  r.equal('NEAR( and * and - are literal characters', await Promise.all(['NEAR(a b)', 'hel*', '-hello'].map((q) => search(q))), [[], [], []]);
  r.equal('a double quote in the query cannot end the phrase (say "hi")', await search('say "hi"'), []);
  r.equal('an FTS5 syntax error is impossible: an unbalanced quote', await search('"unbalanced'), []);
  r.equal('LIKE fallback escapes % literally: "5%" matches only the note containing 5%', await search('5%'), ['n4']);
  r.equal('LIKE fallback escapes _ literally: "_b" matches a_b only', await search('_b'), ['n4']);
  r.equal("'a_' (fallback) is not a wildcard pattern: 'apple pie' would match a_ if it were, only 'a_b literal' has the literal", await search('a_'), ['n4']);

  // ---- other owners and expired rows -----------------------------------------------------------------------------
  const leaky = await search('LEAK');
  r.equal("another owner's and expired notes containing LEAK are absent from search()", leaky, []);
  r.equal("the same query as the other owner finds their own note, not o1's", await search('小籠包', 'o2'), ['X_n1']);
  const rank = await program('view', 'SELECT id FROM notes WHERE search(notes, input.q) ORDER BY search_rank(notes), id', { q: 'text' });
  r.equal('search_rank orders by bm25: the note with the most occurrences of apple first', (await runView(s, rank, caller({ q: 'apple' }))).rows.map((x: any) => x.id), ['n3', 'n2']);
  r.check('search_rank never ranks a hidden row', !JSON.stringify((await runView(s, rank, caller({ q: 'apple' }))).rows).includes('X_'));
  r.equal('search() in a public View of a publishing Schema sees only the published, unexpired post', (await runView({ ...s, mode: 'public' }, await program('view', 'SELECT id FROM posts WHERE search(posts, input.q) ORDER BY id', { q: 'text' }), caller({ q: 'LEAK' }))).rows, []);
  r.equal('  and finds the visible one', (await runView({ ...s, mode: 'public' }, await program('view', 'SELECT id FROM posts WHERE search(posts, input.q) ORDER BY id', { q: 'text' }), caller({ q: 'public' }))).rows.map((x: any) => x.id), ['p1']);

  // ---- triggers keep the index in step; D1's meta.changes counts them, changes() does not -------------------------------------
  const upd = await program('procedure', "UPDATE notes SET title = 'renamed zebra' WHERE id = 'n3' RETURNING id", {});
  const res = await runProcedure(s, upd, caller());
  r.equal('UPDATE on a searchable row: search finds the new text, not the old', [await search('zebra'), (await search('apple apple')).includes('n3')], [['n3'], false]);
  const changes = (await b.d1.batch([{ sql: "UPDATE notes SET title = 'renamed zebra again' WHERE id = 'n3'" }]))[0].changes;
  r.check("D1's meta.changes for a one-row UPDATE on a table with FTS triggers counts the trigger's writes (so it is not 1); changes() inside the batch is what decides CONFLICT", changes !== 1, `meta.changes = ${changes}`);
  r.equal('the row op still passed its count check (changes() = 1)', res.rows, [[{ id: 'n3' }]]);
  await runProcedure(s, await program('procedure', "DELETE FROM notes WHERE id = 'n3'"), caller());
  r.equal('DELETE removes the row from the index', await search('zebra'), []);
  await runProcedure(s, await program('procedure', "INSERT INTO notes (title, body) VALUES ('fresh mango note', 'x')"), caller());
  r.equal('INSERT adds it', (await search('mango')).length, 1);

  // ---- places: R*Tree + haversine -----------------------------------------------------------------------------------
  const near = async (meters: number, extra = '') => (await runView(s, await program('view', `SELECT id FROM places WHERE near(places.loc, input.lat, input.lng, ${meters}) ${extra} ORDER BY id`, { lat: 'float8', lng: 'float8' }), caller({ lat: CENTER.lat, lng: CENTER.lng }))).rows.map((x: any) => x.id as string);
  const places = [['pl300', 300], ['pl1200', 1200], ['pl4900', 4900], ['pl5200', 5200], ['pl10000', 10000]] as const;
  const truth = (m: number) => places.filter(([, d]) => haversine(CENTER.lat, CENTER.lng, north(d), CENTER.lng) <= m).map(([id]) => id).sort();
  r.equal('near 5 km: the three places inside, not the two outside, in an independent haversine', await near(5000), truth(5000));
  r.equal('near 5 km returns exactly pl300, pl1200, pl4900', await near(5000), ['pl1200', 'pl300', 'pl4900']);
  r.equal('near 1 km: only the 300 m place', await near(1000), ['pl300']);
  r.equal('near 20 km: all five', await near(20000), ['pl10000', 'pl1200', 'pl300', 'pl4900', 'pl5200']);
  r.equal('the edge is decided by haversine, not by the box: 4900 m in, 5200 m out of a 5000 m radius', [await near(5000).then((x) => x.includes('pl4900')), await near(5000).then((x) => x.includes('pl5200'))], [true, false]);
  r.check("another owner's place and an expired one at the same spot (300 m) never appear", !(await near(20000)).some((id) => id.startsWith('X_')));

  const closest = await program('view', 'SELECT id, distance(places.loc, input.lat, input.lng) AS d FROM places WHERE near(places.loc, input.lat, input.lng, 50000) ORDER BY distance(places.loc, input.lat, input.lng) LIMIT 3', { lat: 'float8', lng: 'float8' });
  const rows = (await runView(s, closest, caller({ lat: CENTER.lat, lng: CENTER.lng }))).rows as any[];
  r.equal('closest K = 3, in order of distance', rows.map((x) => x.id), ['pl300', 'pl1200', 'pl4900']);
  const err = Math.max(...rows.map((x, i) => Math.abs(x.d - haversine(CENTER.lat, CENTER.lng, north([300, 1200, 4900][i]), CENTER.lng))));
  r.check('distance() agrees with an independent haversine to under 1 m', err < 1, `max error ${err.toExponential(2)} m`);
  r.check('the seeded distances are what the fixtures say (1 degree of latitude = 111195 m)', Math.abs(METERS_PER_DEGREE_LAT - 111195) < 1, String(METERS_PER_DEGREE_LAT));

  // triggers keep the R*Tree in step
  await runProcedure(s, await program('procedure', "UPDATE places SET loc_lat = input.lat, loc_lng = input.lng WHERE id = 'pl10000'", { lat: 'float8', lng: 'float8' }), caller({ lat: north(100), lng: CENTER.lng }));
  r.equal('moving a place updates the R*Tree: pl10000 is now the closest', (await near(1000)).sort(), ['pl10000', 'pl300']);
  await runProcedure(s, await program('procedure', "DELETE FROM places WHERE id = 'pl300'"), caller());
  r.equal('deleting a place removes it from the R*Tree', await near(1000), ['pl10000']);
  await runProcedure(s, await program('procedure', "INSERT INTO places (name, loc_lat, loc_lng) VALUES ('new', input.lat, input.lng)", { lat: 'float8', lng: 'float8' }), caller({ lat: north(50), lng: CENTER.lng }));
  r.equal('inserting adds it', (await near(1000)).length, 2);

  // limits
  for (const [what, input] of [['a box across the antimeridian', { lat: 0, lng: 179.99 }], ['a box across a pole', { lat: 89.99, lng: 0 }]] as const) {
    let e: unknown;
    try { await runView(s, await program('view', 'SELECT id FROM places WHERE near(places.loc, input.lat, input.lng, 5000)', { lat: 'float8', lng: 'float8' }), caller(input)); } catch (x) { e = x; }
    r.check(`${what} is refused at run time`, e instanceof Refused && /antimeridian or a pole/.test(e.message), String(e));
  }
  await b.d1.dispose();
}
