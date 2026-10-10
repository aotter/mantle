// @ts-nocheck test code over loosely typed IR and rows
// The Store (ADR-0032 decision 1): JSON select and write through the same policy, OCC and hooks as SQL; row and set
// ops, `lock` and `expect`, one opaque cursor, scope and TTL, `as(caller)`, the TTL sweep, and refusals.
import type { Report } from '../report.js';
import type { Engine } from '../harness.js';
import { createStore } from '../../core/store/createStore.js';
import { encodeCursor } from '../../core/store/cursor.js';
import { NOW, boot, caller, program, schemas } from '../harness.js';

const user = (subject) => ({ kind: 'user', subject, role: null, scopes: [], credential: 'session', credentialId: null, clientId: null });
const fail = async (f) => { try { await f(); return undefined; } catch (e) { return e; } };
const conflict = (e) => e?.diagnostic?.code === 'CONFLICT' ? e.diagnostic.conflict : undefined;
const invalid = (e) => e?.diagnostic?.code === 'INPUT_VALIDATION_FAILED';

/** createdAt is a date-time on the wire, like a `format: date-time` field. */
const EPOCH = '1970-01-01T00:00:00.000000Z';

export async function run(r: Report, engine: Engine) {
  r.section('Store: JSON select and write, OCC, set ops, cursor, scope, TTL');
  const b = await boot(engine);
  const view = await program('view', 'SELECT id, name FROM items ORDER BY name', {});
  let n = 0;
  const store = createStore({ executor: b.executor, dialect: b.dialect, schemas, views: { names: { ir: view.ir, inputs: {} } }, now: () => NOW, newId: () => `id${++n}` });
  const me = store.as(user('o1'));
  const stock = async (id) => (await b.d1.all('SELECT stock, version FROM items WHERE id = ?1', [id]))[0];

  // ---- reads: scope, TTL, projection, decoding ---------------------------------------------------------------------
  r.equal("o1 sees its unexpired items in name order; another owner's and the expired row are absent; json decodes, native columns are named as ADR-0030 does",
    (await me.select({ from: 'items', columns: ['id', 'name', 'tags', 'createdAt'], orderBy: { name: 'asc' } })).rows,
    [{ id: 'a', name: 'apple', tags: ['red', 'big'], createdAt: EPOCH }, { id: 'b', name: 'berry', tags: ['blue'], createdAt: EPOCH }, { id: 'c', name: 'cherry', tags: ['red'], createdAt: EPOCH }, { id: 'd', name: 'date', tags: ['red'], createdAt: EPOCH }]);
  r.equal('the host store (runtime.store) sees every owner but still not the expired row; an anonymous caller sees nothing of a scoped Schema',
    [(await store.select({ from: 'items', columns: ['id'], orderBy: { id: 'asc' }, limit: 500 })).rows.map((x) => x.id), (await store.as({ kind: 'anonymous' }).select({ from: 'items', columns: ['id'] })).rows],
    [['X_z1', 'X_z2', 'a', 'b', 'c', 'd'], []]);
  r.equal('where: eq, ne, gt, in, notIn, like, isNull, not, or, and, and an in-subquery that is scoped too',
    await Promise.all([
      me.select({ from: 'items', columns: ['id'], where: { cat: 'y' }, orderBy: { id: 'asc' } }),
      me.select({ from: 'items', columns: ['id'], where: { stock: { gt: 5 }, cat: { ne: 'y' } }, orderBy: { id: 'asc' } }),
      me.select({ from: 'items', columns: ['id'], where: { id: { in: ['a', 'X_z1'] } }, orderBy: { id: 'asc' } }),
      me.select({ from: 'items', columns: ['id'], where: { name: { like: '%rr%' }, note: { isNull: true } }, orderBy: { id: 'asc' } }),
      me.select({ from: 'items', columns: ['id'], where: { or: [{ id: 'a' }, { not: { cat: 'x' } }] }, orderBy: { id: 'asc' } }),
      me.select({ from: 'orders', columns: ['id'], where: { item_id: { in: { select: 'id', from: 'items', where: { cat: 'x' } } } }, orderBy: { id: 'asc' } }),
    ]).then((x) => x.map((y) => y.rows.map((z) => z.id))),
    [['c'], ['d'], ['a'], ['b'], ['a', 'c'], ['oa', 'ob']]);

  // ---- search (ADR-0035 decision 7): the declared search fields through mantle.search, or the id --------------------------
  r.equal("search: a three-character Chinese substring through the trigram index, a two-character one by scan, an exact id, and the id alone on a Schema with no search fields; another owner's and the expired notes are absent",
    await Promise.all([
      me.select({ from: 'notes', columns: ['id'], search: '小籠包', orderBy: { id: 'asc' } }),
      me.select({ from: 'notes', columns: ['id'], search: '小籠', orderBy: { id: 'asc' } }),
      me.select({ from: 'notes', columns: ['id'], search: 'n4', orderBy: { id: 'asc' } }),
      me.select({ from: 'items', columns: ['id'], search: 'a', orderBy: { id: 'asc' } }),
    ]).then((x) => x.map((y) => y.rows.map((z) => z.id))),
    [['n1'], ['n1'], ['n4'], ['a']]);
  r.equal('search matches an id exactly: a LIKE wildcard or a prefix of an id matches nothing', await Promise.all(['%', '_', 'n'].map(async (q) => (await me.select({ from: 'items', columns: ['id'], search: q })).rows)), [[], [], []]);
  r.check('search takes a non-empty string', invalid(await fail(() => me.select({ from: 'notes', search: ' ' }))) && invalid(await fail(() => me.select({ from: 'notes', search: 3 }))));

  // ---- cursor: one opaque format, bound to the query ----------------------------------------------------------------------
  const p1 = await me.select({ from: 'items', columns: ['id'], orderBy: { id: 'asc' }, limit: 3 });
  const p2 = await me.select({ from: 'items', columns: ['id'], orderBy: { id: 'asc' }, limit: 3, cursor: p1.nextCursor });
  r.equal('cursor: two pages of 3 then 1, no repeats; the last page has no cursor; the cursor is an opaque v1 string', [p1.rows.map((x) => x.id), p2.rows.map((x) => x.id), p2.nextCursor, /^v1\./.test(p1.nextCursor)], [['a', 'b', 'c'], ['d'], undefined, true]);
  const stolen = await fail(() => me.select({ from: 'items', columns: ['id'], orderBy: { name: 'asc' }, limit: 3, cursor: p1.nextCursor }));
  r.check("a cursor from another query (other sort column) is refused, and a made-up cursor is refused", invalid(stolen) && invalid(await fail(() => me.select({ from: 'items', cursor: 'v1.garbage' }))), stolen?.message);
  const forged = await fail(() => me.select({ from: 'items', columns: ['id'], cursor: encodeCursor('items:updated_at:desc', [{ x: 1 }, 'a']) }));
  r.check('a well-formed cursor whose keys are not scalars is refused as input, not as a driver error', invalid(forged), forged?.message);
  const vp = await me.view('names', { limit: 2 });
  r.equal('a View pages through the same cursor and returns rows in order', [vp.rows.map((x) => x.name), (await me.view('names', { limit: 2, cursor: vp.nextCursor })).rows.map((x) => x.name)], [['apple', 'berry'], ['cherry', 'date']]);

  // ---- row ops: insert, update with lock, delete ---------------------------------------------------------------------------
  const [ins] = await me.write([{ insert: 'items', values: { name: 'elder', cat: 'z', stock: 1, tags: ['x'] } }]);
  r.check('insert returns { id, version: 1 } with a generated id (a scoped Schema generates its own), owned by the caller and stamped with author', /^[0-9a-f]{32}$/.test(ins.id) && ins.version === 1
    && ((x) => JSON.stringify({ ...x, updated_at: Date.parse(b.dialect.codec.decode('timestamptz', x.updated_at)) * 1000 }))((await b.d1.all('SELECT owner, author_id, updated_at FROM items WHERE id = ?1', [ins.id]))[0]) === JSON.stringify({ owner: 'o1', author_id: 'o1', updated_at: NOW }), ins);
  const [upd] = await me.write([{ update: 'items', set: { stock: 9 }, where: { id: ins.id }, lock: 1 }]);
  r.equal('update with the observed version: { id, version: 2 }', [upd.version, (await stock(ins.id)).stock], [2, 9]);
  const stale = await fail(() => me.write([{ update: 'items', set: { stock: 0 }, where: { id: ins.id }, lock: 1 }]));
  r.equal('a stale lock: CONFLICT reason "lock" naming op 0; nothing written', [conflict(stale), (await stock(ins.id)).stock], [{ opIndex: 0, reason: 'lock' }, 9]);
  const hidden = await fail(() => me.write([{ update: 'items', set: { stock: 0 }, where: { id: 'X_z1' }, lock: 1 }]));
  r.equal("another owner's row: CONFLICT reason \"expect\" (an invisible row is a missing row, never \"lock\")", [conflict(hidden), (await stock('X_z1')).stock], [{ opIndex: 0, reason: 'expect' }, 50]);
  const [del] = await me.write([{ delete: 'items', where: { id: ins.id }, lock: 2 }]);
  r.equal('delete with lock returns { id, version }, and the row is gone', [del.version, (await stock(ins.id))], [2, undefined]);

  // ---- set ops, expect, atomicity --------------------------------------------------------------------------------------------------
  const [setOp] = await me.write([{ update: 'items', set: { note: 'bulk' }, where: { cat: 'x' } }]);
  r.equal('a set op returns { affected } (a, b, d; the other owner\'s and the expired x rows are not touched)', [setOp, (await b.d1.all("SELECT id FROM items WHERE note = 'bulk' ORDER BY id")).map((x) => x.id)], [{ affected: 3 }, ['a', 'b', 'd']]);
  const wrong = await fail(() => me.write([{ update: 'items', set: { stock: 1 }, where: { id: 'a' } }, { delete: 'items', where: { cat: 'x' }, expect: 2 }]));
  r.equal('expect that does not hold fails the whole write with CONFLICT naming that op, and the first op is rolled back', [conflict(wrong), (await stock('a')).stock], [{ opIndex: 1, reason: 'expect' }, 5]);

  const classes = await me.write([
    { update: 'items', set: { note: 'c' }, where: { id: 'a', stock: { gte: 0 } } }, { update: 'items', set: { note: 'c' }, where: { id: { eq: 'b' } } }, { update: 'items', set: { note: 'c' }, where: { cat: 'x' } },
  ]);
  r.equal('classification: { id } alone, with more conditions, or as { eq } is a row op ({ id, version }); { cat } is a set op ({ affected }); a scoped rewrite does not change the class', classes.map((x) => ('version' in x ? 'row' : 'set')), ['row', 'row', 'set']);
  const noMatch = await fail(() => me.write([{ update: 'items', set: { note: 'c' }, where: { id: 'a', stock: { gte: 9999 } } }]));
  r.equal('a row op whose other conditions fail matches nothing: CONFLICT reason "expect"', conflict(noMatch), { opIndex: 0, reason: 'expect' });

  const noRow = await me.write([{ update: 'items', set: { note: 'c' }, where: { id: 'X_z1' }, expect: 0 }]);
  r.equal("expect: 0 on a row op that matches nothing (another owner's row) succeeds with { affected: 0 }", noRow, [{ affected: 0 }]);

  // ---- upsert -------------------------------------------------------------------------------------------------------------------------
  const up = await me.write([
    { insert: 'settings', values: { key: 'theme', value: 'light' }, onConflict: { columns: ['key'], update: { value: 'light' } } },
    { insert: 'settings', values: { key: 'theme', value: 'x' }, onConflict: 'ignore' },
    { insert: 'settings', values: { key: 'fresh', value: 'v' }, onConflict: 'ignore' },
  ]);
  r.equal("upsert and ignore are set ops returning { affected }; the caller's own row is updated, another owner's same-key row is not", [up, (await b.d1.all("SELECT owner, value FROM settings WHERE key = 'theme' ORDER BY owner")).map((x) => x.value)], [[{ affected: 1 }, { affected: 0 }, { affected: 1 }], ['light', 'dark']]);

  // ---- refusals -------------------------------------------------------------------------------------------------------------------------
  const refused = await Promise.all([
    () => me.select({ from: 'nope' }), () => me.select({ from: 'items', columns: ['nope'] }), () => me.select({ from: 'items', where: { tags: 'x' } }),
    () => me.select({ from: 'items', limit: 501 }), () => me.select({ from: 'items', orderBy: { name: 'asc', id: 'asc' } }), () => me.select({ from: 'items', where: { status: 'x' } }),
    () => me.write([{ insert: 'items', values: { id: 'mine', name: 'x' } }]), () => me.write([{ insert: 'items', values: { owner: 'o2', name: 'x' } }]),
    () => me.write([{ update: 'items', set: { version: 9 }, where: { id: 'a' } }]), () => me.write([]),
    () => me.select({ from: 'items', where: { stock: { gt: 'x' } } }), () => me.select({ from: 'items', where: {} }),
  ].map(fail));
  r.check('refused with INPUT_VALIDATION_FAILED: unknown Schema and column, non-scalar where, limit 501, two sort columns, status on a Schema without publishing, a caller-chosen id or the owner on a scoped insert, writing version, an empty write, a wrongly typed value, an empty where', refused.every(invalid), refused.map((e) => e?.message?.slice(0, 60)));

  // ---- TTL sweep ------------------------------------------------------------------------------------------------------------------------
  const dry = await store.sweepExpired({ collection: 'items', delete: false });
  const swept = await store.sweepExpired({ collection: 'items' });
  r.equal('sweepExpired: a dry run counts the one expired row, the sweep removes it (only it), and a second sweep finds nothing', [dry, swept, (await store.sweepExpired({ collection: 'items' })).scanned, (await b.d1.all("SELECT count(*) AS c FROM items WHERE id = 'X_e1'"))[0].c], [{ scanned: 1, removed: 0 }, { scanned: 1, removed: 1 }, 0, 0]);
  if (b.dialect.name === '@aotter/mantle/d1') await sqliteCounts(r, b, me);
}


/** Native SQLite changes() excludes trigger writes and reflects suppressed writes, including zero. */
async function sqliteCounts(r: Report, b, me) {
  await b.d1.exec([
    "CREATE TABLE count_audit (id TEXT)",
    "CREATE TRIGGER count_side_effect AFTER UPDATE ON items BEGIN INSERT INTO count_audit VALUES (new.id); INSERT INTO count_audit VALUES (new.id); END",
    "CREATE TRIGGER count_suppress BEFORE UPDATE ON items WHEN new.note = 'suppress' BEGIN SELECT RAISE(IGNORE); END",
  ]);
  const result = await me.write([
    { update: 'items', set: { note: 'count-one' }, where: { cat: 'y' }, expect: 1 },
    { update: 'items', set: { note: 'count-three' }, where: { cat: 'x' }, expect: 3 },
    { update: 'items', set: { note: 'suppress' }, where: { cat: 'x' }, expect: 0 },
    { update: 'items', set: { note: 'count-unknown' }, where: { cat: 'y' } },
  ]);
  r.equal('native expected 1/n/0 and unknown counts exclude side-effect and suppressed trigger writes', result,
    [{ affected: 1 }, { affected: 3 }, { affected: 0 }, { affected: 1 }]);
  r.equal('native ordered writes and trigger side effects really execute',
    [(await b.d1.all("SELECT note FROM items WHERE id = 'c'"))[0].note, (await b.d1.all('SELECT count(*) AS n FROM count_audit'))[0].n], ['count-unknown', 10]);
  const before = await b.d1.all('SELECT id, note, version FROM items ORDER BY id');
  const rejected = await fail(() => me.write([
    { update: 'items', set: { note: 'rolled-back' }, where: { cat: 'y' }, expect: 1 },
    { update: 'items', set: { note: 'suppress' }, where: { cat: 'x' }, expect: 3 },
  ]));
  r.equal('a late native suppression mismatch names the correct op and rolls back earlier writes and their triggers',
    [conflict(rejected), await b.d1.all('SELECT id, note, version FROM items ORDER BY id'), (await b.d1.all('SELECT count(*) AS n FROM count_audit'))[0].n],
    [{ opIndex: 1, reason: 'expect' }, before, 10]);
  const p = await program('procedure', "UPDATE items SET note = 'returning-one' WHERE cat = 'y' RETURNING id, note; UPDATE items SET note = 'returning-three' WHERE cat = 'x' RETURNING id, note");
  const { runProcedure } = await import('../../core/sql/run.js');
  const env = { executor: b.executor, dialect: b.dialect, schemas: b.schemas };
  const as = { caller: user('o1'), cause: { kind: 'internal', id: 'count-returning' }, bind: caller() };
  const returning = await runProcedure(env, { ...p, expects: [1, 3] }, as, true);
  r.equal('native ordered expected writes preserve actual RETURNING rows', returning.rows.map((rows) => rows.sort((a, b) => a.id.localeCompare(b.id))),
    [[{ id: 'c', note: 'returning-one' }], ['a', 'b', 'd'].map((id) => ({ id, note: 'returning-three' }))]);
  const committed = await b.d1.all('SELECT id, note, version FROM items ORDER BY id');
  const audit = (await b.d1.all('SELECT count(*) AS n FROM count_audit'))[0].n;
  const rowsFailure = await fail(() => runProcedure(env, { ...p, expects: [1, 2] }, as, true));
  r.equal('rows-only native execution still rolls back all rows and trigger writes after a late assertion failure',
    [conflict(rowsFailure), await b.d1.all('SELECT id, note, version FROM items ORDER BY id'), (await b.d1.all('SELECT count(*) AS n FROM count_audit'))[0].n],
    [{ opIndex: 1, reason: 'expect' }, committed, audit]);
}
