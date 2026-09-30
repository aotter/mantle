// @ts-nocheck test code over loosely typed IR and rows
// The printer corpus (spike task 1). Every node type and enum value in the validate.ts allowlist appears
// in at least one item; each item runs on local D1 through the whole pipeline, and its rows are checked
// against the result PostgreSQL semantics give. Data: see src/fixtures.ts (owner o1 sees items a b c d).
import { NOW } from '../harness.js';

const us = (y: number, mo: number, d: number, h = 0) => Date.UTC(y, mo - 1, d, h) * 1000;

export type Item = {
  id: string;
  kind: 'view' | 'procedure';
  sql: string;
  inputs?: Record<string, string>;
  input?: Record<string, unknown>;
  /** rows per statement */
  expect: unknown[][];
};

const v = (id: string, sql: string, expect: unknown[], inputs?: Record<string, string>, input?: Record<string, unknown>): Item => ({ id, kind: 'view', sql, expect: [expect], inputs, input });
const w = (id: string, sql: string, expect: unknown[][], inputs?: Record<string, string>, input?: Record<string, unknown>): Item => ({ id, kind: 'procedure', sql, expect, inputs, input });
const ids = (...x: string[]) => x.map((id) => ({ id }));

export const corpus: Item[] = [
  // ---- expressions --------------------------------------------------------------------------------------
  v('arith', "SELECT name, stock + 1 AS s, stock * 2 - 1 AS t, stock / 2 AS h, stock % 3 AS m, -stock AS neg, name || '!' AS shout FROM items WHERE id = 'a'",
    [{ name: 'apple', s: 6, t: 9, h: 2, m: 2, neg: -5, shout: 'apple!' }]),
  // PostgreSQL: `*` binds tighter than `||`, `+` tighter than `||`; SQLite: `||` binds tighter than both
  v('precedence-concat', "SELECT 2 * 3 || 4 AS a, 1 + 2 || 3 AS b, 'x' || 1 + 1 AS c, 10 - 2 - 3 AS d, 10 - (2 - 3) AS e, -(1 + 2) * 3 AS f, (2 + 3) * 4 AS g FROM items WHERE id = 'a'",
    [{ a: '64', b: '33', c: 'x2', d: 5, e: 11, f: -9, g: 20 }]),
  v('precedence-bool', "SELECT id FROM items WHERE (stock > 4 AND NOT cat = 'y' OR stock < 3) AND NOT (stock = 7) ORDER BY id", ids('a', 'b')),
  v('case', "SELECT id, CASE WHEN stock > 6 THEN 'hi' WHEN stock > 3 THEN 'mid' ELSE 'lo' END AS lvl, CASE cat WHEN 'x' THEN 1 ELSE 0 END AS isx, COALESCE(NULL, stock) AS cs, NULLIF(stock, 5) AS ns FROM items WHERE id IN ('a', 'c') ORDER BY id",
    [{ id: 'a', lvl: 'mid', isx: 1, cs: 5, ns: null }, { id: 'c', lvl: 'hi', isx: 0, cs: 9, ns: 9 }]),
  v('literals', "SELECT 'it''s a \\ back\\slash' AS s, -7 AS n, 1.5 AS f, true AS t, false AS x, NULL AS z, 1772928000000000 AS big FROM items WHERE id = 'a'",
    [{ s: "it's a \\ back\\slash", n: -7, f: 1.5, t: 1, x: 0, z: null, big: 1772928000000000 }]),
  v('quoting', 'SELECT id AS "Group", name AS "select", stock AS "Total Count" FROM items WHERE id = \'a\'', [{ Group: 'a', select: 'apple', 'Total Count': 5 }]),
  // ---- conditions ----------------------------------------------------------------------------------------
  v('between', 'SELECT id FROM items WHERE stock BETWEEN 5 AND 7 ORDER BY id', ids('a', 'd')),
  v('not-between', 'SELECT id FROM items WHERE stock NOT BETWEEN 3 AND 8 ORDER BY id', ids('b', 'c')),
  v('like', "SELECT id FROM items WHERE name LIKE 'a%' OR name LIKE '%y' ORDER BY id", ids('a', 'b', 'c')),
  v('not-like', "SELECT id FROM items WHERE name NOT LIKE '%rr%' ORDER BY id", ids('a', 'd')),
  v('like-escape', "SELECT id FROM items WHERE 'a%b' LIKE 'a!%b' ESCAPE '!' AND 'axb' NOT LIKE 'a!%b' ESCAPE '!' AND id = 'a'", ids('a')),
  v('null-tests', "SELECT id FROM items WHERE cat IS NOT DISTINCT FROM 'x' AND tags IS NOT NULL AND NOT (stock IS NULL) AND cat IS DISTINCT FROM 'q' ORDER BY id", ids('a', 'b', 'd')),
  v('in-list', "SELECT id FROM items WHERE id IN ('a', 'b') AND stock NOT IN (2) ORDER BY id", ids('a')),
  v('any-subquery', 'SELECT id FROM items WHERE id = ANY (SELECT item_id FROM orders) ORDER BY id', ids('a')),
  v('in-subquery', 'SELECT id FROM items WHERE id IN (SELECT item_id FROM orders) ORDER BY id', ids('a')),
  v('exists', 'SELECT id FROM items WHERE EXISTS (SELECT 1 FROM orders o WHERE o.item_id = items.id) ORDER BY id', ids('a')),
  v('not-exists', 'SELECT id FROM items WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.item_id = items.id) ORDER BY id', ids('b', 'c', 'd')),
  v('scalar-subquery', 'SELECT id, (SELECT count(*) FROM orders o WHERE o.item_id = i.id) AS n FROM items i ORDER BY id',
    [{ id: 'a', n: 2 }, { id: 'b', n: 0 }, { id: 'c', n: 0 }, { id: 'd', n: 0 }]),
  v('input-param', 'SELECT id FROM items WHERE stock > input.min AND cat = input.cat ORDER BY id', ids('a', 'd'), { min: 'int8', cat: 'text' }, { min: 4, cat: 'x' }),
  // ---- aggregates, windows, order, paging -------------------------------------------------------------------
  v('aggregates', 'SELECT cat, count(*) AS n, count(DISTINCT stock) AS d, sum(stock) AS s, min(stock) AS lo, max(stock) AS hi, avg(stock) AS av, json_group_array(name) AS names, json_group_array(DISTINCT cat) AS cats, json_group_object(id, stock) AS obj FROM items GROUP BY cat HAVING count(*) > 0 ORDER BY cat',
    [{ cat: 'x', n: 3, d: 3, s: 14, lo: 2, hi: 7, av: 14 / 3, names: '["apple","berry","date"]', cats: '["x"]', obj: '{"a":5,"b":2,"d":7}' },
     { cat: 'y', n: 1, d: 1, s: 9, lo: 9, hi: 9, av: 9, names: '["cherry"]', cats: '["y"]', obj: '{"c":9}' }]),
  v('windows', 'SELECT r.cat, r.name, r.rn, r.rk, r.run, r.cnt FROM (SELECT cat, name, row_number() OVER (PARTITION BY cat ORDER BY stock DESC) AS rn, rank() OVER (PARTITION BY cat ORDER BY stock DESC) AS rk, sum(stock) OVER (PARTITION BY cat ORDER BY stock DESC) AS run, count(*) OVER (PARTITION BY cat) AS cnt, id FROM items) r ORDER BY r.cat, r.rn',
    [{ cat: 'x', name: 'date', rn: 1, rk: 1, run: 7, cnt: 3 }, { cat: 'x', name: 'apple', rn: 2, rk: 2, run: 12, cnt: 3 }, { cat: 'x', name: 'berry', rn: 3, rk: 3, run: 14, cnt: 3 }, { cat: 'y', name: 'cherry', rn: 1, rk: 1, run: 9, cnt: 1 }]),
  v('order-nulls', 'SELECT id FROM items ORDER BY note DESC NULLS LAST, id ASC LIMIT 3', ids('d', 'c', 'a')),
  v('order-nulls-first', 'SELECT id FROM items ORDER BY note ASC NULLS FIRST, id DESC LIMIT 3', ids('b', 'a', 'c')),
  // PostgreSQL semantics: peers rank alike and a running sum includes all peers. An appended id key would break both.
  v('window-ties', 'SELECT r.id, r.rk, r.run FROM (SELECT id, rank() OVER (ORDER BY cat) AS rk, sum(stock) OVER (ORDER BY cat) AS run FROM items) r ORDER BY r.id',
    [{ id: 'a', rk: 1, run: 14 }, { id: 'b', rk: 1, run: 14 }, { id: 'c', rk: 4, run: 23 }, { id: 'd', rk: 1, run: 14 }]),
  v('distinct', 'SELECT DISTINCT cat FROM items', [{ cat: 'x' }, { cat: 'y' }]),
  v('limit-input', 'SELECT id FROM items ORDER BY id LIMIT input.n', ids('a', 'b'), { n: 'int8' }, { n: 2 }),
  // ---- relations ---------------------------------------------------------------------------------------------
  v('inner-join', 'SELECT i.id, o.id AS oid FROM items i JOIN orders o ON o.item_id = i.id ORDER BY i.id, o.id', [{ id: 'a', oid: 'oa' }, { id: 'a', oid: 'ob' }]),
  v('left-join', 'SELECT i.id, o.id AS oid FROM items i LEFT JOIN orders o ON o.item_id = i.id WHERE i.stock < 8 ORDER BY i.id, o.id',
    [{ id: 'a', oid: 'oa' }, { id: 'a', oid: 'ob' }, { id: 'b', oid: null }, { id: 'd', oid: null }]),
  v('self-join', 'SELECT a.id AS a, b.id AS b FROM items a JOIN items b ON a.cat = b.cat AND a.id < b.id ORDER BY a.id, b.id', [{ a: 'a', b: 'b' }, { a: 'a', b: 'd' }, { a: 'b', b: 'd' }]),
  v('from-subquery', 'SELECT s.id, s.stock FROM (SELECT id, stock FROM items WHERE cat = \'x\') s WHERE s.stock > 4 ORDER BY s.id', [{ id: 'a', stock: 5 }, { id: 'd', stock: 7 }]),
  v('json-each', 'SELECT i.id, j.value AS tag FROM items i, json_each(i.tags) j WHERE j.value = input.tag ORDER BY i.id', [{ id: 'a', tag: 'red' }, { id: 'c', tag: 'red' }, { id: 'd', tag: 'red' }], { tag: 'text' }, { tag: 'red' }),
  v('json-exists', 'SELECT i.id, i.tags ->> \'$[0]\' AS first FROM items i WHERE EXISTS (SELECT 1 FROM json_each(i.tags) j WHERE j.value = \'big\') ORDER BY i.id', [{ id: 'a', first: 'red' }]),
  // ---- functions -----------------------------------------------------------------------------------------------
  v('scalar-functions', "SELECT lower('AbC') AS lo, upper('AbC') AS up, length('héllo') AS len, abs(-3) AS ab, round(2.567, 2) AS r, substr('abcdef', 2, 3) AS sub, replace('a-b', '-', '+') AS rep, trim('  x ') AS t, ltrim('  x') AS lt, rtrim('x  ') AS rt, instr('abc', 'c') AS ins, typeof(1) AS ty, hex('A') AS hx FROM items WHERE id = 'a'",
    [{ lo: 'abc', up: 'ABC', len: 5, ab: 3, r: 2.57, sub: 'bcd', rep: 'a+b', t: 'x', lt: 'x', rt: 'x', ins: 3, ty: 'integer', hx: '41' }]),
  v('json-functions', "SELECT json_extract(tags, '$[0]') AS e, json_array_length(tags) AS n, json_set(tags, '$[0]', 'z') AS s, json_insert(tags, '$[#]', 'w') AS i, json_remove(tags, '$[0]') AS r FROM items WHERE id = 'a'",
    [{ e: 'red', n: 2, s: '["z","big"]', i: '["red","big","w"]', r: '["big"]' }]),
  v('casts', "SELECT CAST(stock AS text) AS t, round(stock) AS i, CAST(stock AS float8) AS f, CAST(stock AS bool) AS b, CAST('false' AS bool) AS bf, CAST('yes' AS bool) AS bt, stock::text || 'x' AS c FROM items WHERE id = 'a'", [{ t: '5', i: 5, f: 5, b: 1, bf: 0, bt: 1, c: '5x' }]),
  v('literal-casts', "SELECT '2026-03-08 10:00:00+00'::timestamptz AS ts, date '2026-03-08' AS d, interval '36 hours' AS iv, interval '90 minutes' AS im, '12.34'::numeric(12, 2) AS n, CAST('2026-03-08T10:00:00.123456Z' AS timestamptz) AS us FROM items WHERE id = 'a'",
    [{ ts: us(2026, 3, 8, 10), d: Date.UTC(2026, 2, 8) / 86_400_000, iv: 129_600_000_000, im: 5_400_000_000, n: 1234, us: us(2026, 3, 8, 10) + 123456 }]),
  v('mantle-refs', 'SELECT auth.uid() AS uid, auth.role() AS role, now() AS now, input.x AS x FROM items WHERE id = \'a\'', [{ uid: 'o1', role: 'staff', now: NOW, x: 3 }], { x: 'int8' }, { x: 3 }),
  v('date-trunc', "SELECT date_trunc('hour', now()) AS h, date_trunc('day', now()) AS d, date_trunc('week', now()) AS w, date_trunc('month', now()) AS m, date_trunc('year', now()) AS y FROM items WHERE id = 'a'",
    [{ h: NOW, d: NOW, w: us(2026, 9, 28), m: us(2026, 9, 1), y: us(2026, 1, 1) }]), // site time zone UTC here; DST cases are in cases/types.ts
  v('extract', "SELECT extract(year FROM now()) AS y, extract(month FROM now()) AS mo, extract(day FROM now()) AS d, extract(dow FROM now()) AS dow, extract(hour FROM now()) AS h FROM items WHERE id = 'a'",
    [{ y: 2026, mo: 9, d: 29, dow: new Date(NOW / 1000).getUTCDay(), h: 0 }]),
  // ---- writes (the database is reset before each) -------------------------------------------------------------------
  w('insert-values', "INSERT INTO settings (key, value) VALUES ('a', '1') RETURNING key, value", [[{ key: 'a', value: '1' }]]),
  w('insert-string-escapes', "INSERT INTO settings (key, value) VALUES ('q', 'it''s a \\ back\\slash') RETURNING value", [[{ value: "it's a \\ back\\slash" }]]),
  // params first appear out of numeric order here (?1, ?3, then ?2): `$n` would silently mis-bind on D1
  w('insert-select-input', "INSERT INTO orders (item_id, qty) SELECT r.item_id, r.qty FROM requisitions r WHERE r.id = input.id RETURNING item_id, qty", [[{ item_id: 'a', qty: 2 }]], { id: 'text' }, { id: 'r1' }),
  w('insert-select', "INSERT INTO orders (item_id, qty) SELECT id, stock FROM items WHERE cat = 'x' RETURNING item_id, qty", [[{ item_id: 'a', qty: 5 }, { item_id: 'b', qty: 2 }, { item_id: 'd', qty: 7 }]]),
  w('insert-returning-star', "INSERT INTO requisitions (item_id, qty, state) VALUES ('a', 1, 'new') RETURNING *", [[{ item_id: 'a', qty: 1, state: 'new' }]]),
  w('update-set', 'UPDATE items SET stock = stock + 1, name = upper(name) WHERE cat = \'x\' RETURNING id, name, stock', [[{ id: 'a', name: 'APPLE', stock: 6 }, { id: 'b', name: 'BERRY', stock: 3 }, { id: 'd', name: 'DATE', stock: 8 }]]),
  w('update-row', "UPDATE items SET stock = input.s WHERE id = input.id RETURNING id, stock", [[{ id: 'a', stock: 9 }]], { id: 'text', s: 'int8' }, { id: 'a', s: 9 }),
  w('delete', "DELETE FROM requisitions WHERE state = 'pending' RETURNING id", [[{ id: 'r1' }, { id: 'r2' }]]),
  w('upsert-nothing', "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING RETURNING key", [[]]),
  w('upsert-update', "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE settings.value IS DISTINCT FROM excluded.value RETURNING key, value", [[{ key: 'theme', value: 'light' }]]),
];
