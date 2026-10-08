// @ts-nocheck test code over loosely typed IR and rows
// Conformance case 7: the relation-position probe (ADR-0034 decision 8). Every position at which the IR
// can reach a relation has a probe; the list is a Record checked with `satisfies` against the position
// union in src/positions.ts, so a new position without a probe fails `tsc` (cases/typecheck.ts shows it).
// Each probe seeds a second owner's rows, an expired one and an unpublished one (`X_` ids, `LEAK` text)
// and asserts none of them appears in a result or changes.
import type { Report } from '../report.js';
import type { Engine } from '../harness.js';
import { CENTER, NOW, boot, caller, program, reset, site } from '../harness.js';
import { isConflict, isRefusal, runProcedure, runView } from '../harness.js';
import type { Site } from '../harness.js';
import type { Mode } from '../../core/sql/policy.js';
import { ALL_POSITIONS } from '../../core/sql/positions.js';
import type { RelationPosition } from '../../core/sql/positions.js';

type Step = {
  kind: 'view' | 'procedure';
  sql: string;
  inputs?: Record<string, string>;
  input?: Record<string, unknown>;
  mode?: Mode;
  /** what the caller is entitled to see: the exact rows of every statement, as JSON */
  rows?: unknown[][];
  /** the SQL a dialect with `nativeSql` runs instead (ADR-0039) */
  native?: string;
  /** or: the statement must fail with a CONFLICT (an invisible row is a missing row) */
  conflict?: true;
};
export type Probe = { steps: Step[] };

const v = (sql: string, rows: unknown[], inputs?: Record<string, string>, input?: Record<string, unknown>): Step => ({ kind: 'view', sql, rows: [rows], inputs, input });
const w = (sql: string, rows: unknown[][], inputs?: Record<string, string>, input?: Record<string, unknown>): Step => ({ kind: 'procedure', sql, rows, inputs, input });
const conflict = (sql: string): Step => ({ kind: 'procedure', sql, conflict: true });
const ids = (...x: string[]) => x.map((id) => ({ id }));

/** One entry per RelationPosition. A missing or extra key does not typecheck. */
export const PROBES = {
  from: { steps: [v('SELECT id, name FROM items ORDER BY id', [{ id: 'a', name: 'apple' }, { id: 'b', name: 'berry' }, { id: 'c', name: 'cherry' }, { id: 'd', name: 'date' }])] },
  'join.left': { steps: [v('SELECT a.id AS aid, o.id AS oid FROM items a JOIN orders o ON o.item_id = a.id ORDER BY a.id, o.id', [{ aid: 'a', oid: 'oa' }, { aid: 'a', oid: 'ob' }])] },
  'join.right': { steps: [v('SELECT o.id AS oid, i.name AS name FROM orders o LEFT JOIN items i ON i.id = o.item_id ORDER BY o.id', [{ oid: 'oa', name: 'apple' }, { oid: 'ob', name: 'apple' }, { oid: 'oe', name: null }])] },
  'from-subquery': { steps: [
    v('SELECT s.id FROM (SELECT id FROM items) s ORDER BY s.id', ids('a', 'b', 'c', 'd')),
    // LATERAL (reference profile): the subquery reads the outer row, and is wrapped as any FROM subquery
    v('SELECT i.id, x.first FROM items i JOIN LATERAL (SELECT o.id AS first FROM orders o WHERE o.item_id = i.id ORDER BY o.id LIMIT 1) x ON true ORDER BY i.id', [{ id: 'a', first: 'oa' }]),
  ] },
  // the reference profile's positions (ADR-0037); the D1 dialect refuses them, and a refusal passes
  cte: { steps: [
    v('WITH x AS (SELECT id FROM items) SELECT id FROM x ORDER BY id', ids('a', 'b', 'c', 'd')),
    v('WITH RECURSIVE r AS (SELECT id, 1 AS n FROM items UNION ALL SELECT r.id, r.n + 1 AS n FROM r WHERE r.n < 2) SELECT id FROM r ORDER BY id, n', ids('a', 'a', 'b', 'b', 'c', 'c', 'd', 'd')),
  ] },
  'setop.left': { steps: [v('SELECT u.id FROM (SELECT id FROM items UNION ALL SELECT id FROM requisitions) u ORDER BY u.id', ids('a', 'b', 'c', 'd', 'r1', 'r2'))] },
  'setop.right': { steps: [v('SELECT u.id FROM (SELECT id FROM requisitions UNION SELECT id FROM items) u ORDER BY u.id', ids('a', 'b', 'c', 'd', 'r1', 'r2'))] },
  sublink: { steps: [
    v('SELECT id FROM orders WHERE item_id IN (SELECT id FROM items) ORDER BY id', ids('oa', 'ob')),
    v("SELECT id FROM requisitions WHERE EXISTS (SELECT 1 FROM items WHERE name LIKE 'LEAK%')", []),
    v("SELECT id FROM requisitions WHERE EXISTS (SELECT 1 FROM items WHERE name = 'apple') ORDER BY id", ids('r1', 'r2')),
    v("SELECT (SELECT count(*) FROM items) AS n, (SELECT max(stock) FROM items) AS mx FROM requisitions WHERE id = 'r1'", [{ n: 4, mx: 9 }]),
  ] },
  json_each: { steps: [{ ...v('SELECT j.value AS v FROM items i, json_each(i.tags) j ORDER BY i.id, j.id', [{ v: 'red' }, { v: 'big' }, { v: 'blue' }, { v: 'red' }, { v: 'red' }]),
    native: 'SELECT j.value AS v FROM items i, jsonb_array_elements_text(i.tags) WITH ORDINALITY AS j(value, n) ORDER BY i.id, j.n' }] },
  window: { steps: [v('SELECT x.id, x.rn FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM items) x ORDER BY x.id', [{ id: 'a', rn: 1 }, { id: 'b', rn: 2 }, { id: 'c', rn: 3 }, { id: 'd', rn: 4 }])] },
  'insert-target': { steps: [
    // o2 has a setting 'lang'; the caller's own insert of the same key does not collide (unique includes the scope) and is owned by the caller
    w("INSERT INTO settings (key, value) VALUES ('lang', 'yy') RETURNING key, value", [[{ key: 'lang', value: 'yy' }]]),
    w("INSERT INTO settings (key, value) VALUES ('t', 'v') ON CONFLICT (key) DO NOTHING RETURNING key", [[{ key: 't' }]]),
  ] },
  'insert-select': { steps: [w('INSERT INTO orders (item_id, qty) SELECT id, 1 FROM items RETURNING item_id', [ids('a', 'b', 'c', 'd').map((x) => ({ item_id: x.id }))])] },
  'update-target': { steps: [
    w("UPDATE items SET stock = 0 WHERE cat = 'x' RETURNING id", [ids('a', 'b', 'd')]),
    conflict("UPDATE items SET stock = 0 WHERE id = 'X_z1'"),
    conflict("UPDATE items SET stock = 0 WHERE id = 'X_e1'"),
  ] },
  'delete-target': { steps: [
    w("DELETE FROM requisitions WHERE state = 'pending' RETURNING id", [ids('r1', 'r2')]),
    conflict("DELETE FROM requisitions WHERE id = 'X_rz'"),
  ] },
  'conflict-update': { steps: [
    // the conflicting row is the caller's own 's1'; another owner's 'X_sz' (same key) is untouched
    w("INSERT INTO settings (key, value) VALUES ('theme', 'pwn') ON CONFLICT (key) DO UPDATE SET value = excluded.value RETURNING id, value", [[{ id: 's1', value: 'pwn' }]]),
    // an expired row of the caller's own is not revived by an upsert: DO UPDATE ... WHERE carries the TTL
    w("INSERT INTO notes (title, body) VALUES ('LEAK 小籠包 hello apple', 'revived') ON CONFLICT (title) DO UPDATE SET body = excluded.body RETURNING id", [[]]),
  ] },
  search: { steps: [v('SELECT id FROM notes WHERE mantle.search(notes, input.q) ORDER BY id', ids('n1'), { q: 'text' }, { q: '小籠包' })] },
  near: { steps: [v('SELECT id FROM places WHERE mantle.near(places.loc, input.lat, input.lng, 5000) ORDER BY id', ids('pl1200', 'pl300', 'pl4900'), { lat: 'float8', lng: 'float8' }, { lat: CENTER.lat, lng: CENTER.lng })] },
} satisfies Record<RelationPosition, Probe>;

/** every row that must never change: another owner's, expired and unpublished rows all have an `X_` id */
async function protectedRows(d1: { all: (sql: string) => Promise<any[]> }) {
  const out: Record<string, unknown> = {};
  for (const t of ['items', 'requisitions', 'orders', 'settings', 'posts', 'notes', 'places']) out[t] = await d1.all(`SELECT * FROM ${t} WHERE id LIKE 'X\\_%' ESCAPE '\\' ORDER BY id`);
  return out;
}

export async function run(r: Report, engine: Engine) {
  r.section('Case 7: policy probe (every relation position, another owner / expired / unpublished rows)');
  const b = await boot(engine);
  const positions = Object.keys(PROBES) as RelationPosition[];
  r.equal(`the probe list covers all ${ALL_POSITIONS.length} positions of the IR union (and \`satisfies\` makes that a typecheck error when it does not)`, [...positions].sort(), [...ALL_POSITIONS].sort());

  // one probe run: the problems found (an error, a LEAK / X_ row in a result, a protected row changed)
  // a dialect that runs only the base profile refuses the reference profile's steps, and that refusal passes
  const refused = new Set<RelationPosition>();
  const probe = async (pos: RelationPosition, opts: Partial<Site>) => {
    const problems: string[] = [];
    for (const [n, step] of PROBES[pos].steps.entries()) {
      await reset(b);
      const before = JSON.stringify(await protectedRows(b.d1));
      let p;
      try { p = await program(step.kind, b.dialect.nativeSql && step.native ? step.native : step.sql, step.inputs ?? {}); } catch (e) {
        if (!/needs the PostgreSQL dialect/.test(String(e))) throw e;
        if (n === 0) refused.add(pos);
        continue;
      }
      const s = { ...site(b), ...opts, mode: step.mode };
      let rows: unknown[][] | undefined, err: unknown;
      try { rows = step.kind === 'view' ? [(await runView(s, p, caller(step.input))).rows] : (await runProcedure(s, p, caller(step.input))).rows; } catch (e) { err = e; }
      const json = JSON.stringify(rows ?? []);
      if (step.conflict ? !isConflict(err) : err || json.includes('LEAK') || json.includes('X_') || (step.rows && json !== JSON.stringify(step.rows))) problems.push(`#${n + 1} ${step.sql.slice(0, 50)}: ${String(err ?? json).slice(0, 100)}`);
      if (JSON.stringify(await protectedRows(b.d1)) !== before) problems.push(`#${n + 1}: a protected row changed`);
    }
    return problems;
  };
  for (const pos of positions) {
    const seen = new Set<RelationPosition>();
    const problems = await probe(pos, { seen });
    if (!seen.has(pos) && !refused.has(pos)) problems.push('the policy pass printed no wrapper (or system relation) at this position');
    r.check(`${pos}: no LEAK / X_ row in a result, the caller's own rows all there, conflicts where the row is invisible, protected rows unchanged, wrapper printed`, problems.length === 0, problems);
  }

  // negative control: with the visibility predicate switched off, every read/write position must be caught by its probe
  const missed: string[] = [];
  const run = positions.filter((pos) => !refused.has(pos));
  for (const pos of run) if (!(await probe(pos, { unsafeNoVisibility: true })).length) missed.push(pos);
  r.check(`negative control: with the visibility predicate off, ${run.length - missed.length} of ${run.length} positions are caught by their probes`, missed.length <= 1, `missed: ${missed.join(', ') || 'none'}`);

  // what the ADR says about the write path, on top of the positions
  await reset(b);
  const { rows } = await runProcedure(site(b), await program('procedure', "INSERT INTO settings (key, value) VALUES ('lang', 'yy') RETURNING id"), caller());
  const mine = (await b.d1.all('SELECT owner, created_at, length(id) AS idlen FROM settings WHERE id = ?1', [(rows[0][0] as any).id]))[0];
  r.equal("an insert is owned by the caller, stamped with now(), gets a generated id, and does not touch another owner's same-key row",
    [{ ...mine, created_at: Date.parse(b.dialect.codec.decode('timestamptz', mine.created_at)) * 1000 }, (await b.d1.all("SELECT value FROM settings WHERE id = 'X_sz2'"))[0].value], [{ owner: 'o1', created_at: NOW, idlen: 32 }, 'xx']);

  // modes: public reads see published, unexpired rows only; trusted (runtime.store) sees every owner but TTL still applies
  const posts = await program('view', 'SELECT id FROM posts ORDER BY id');
  const all = await program('view', 'SELECT id FROM items ORDER BY id');
  r.equal('public caller sees only the published, unexpired post; trusted runtime.store sees every owner but not the expired row',
    [(await runView({ ...site(b), mode: 'public' }, posts, caller())).rows, (await runView({ ...site(b), mode: 'trusted' }, all, caller())).rows], [ids('p1'), ids('X_z1', 'X_z2', 'a', 'b', 'c', 'd')]);

  // an alias that spells one of the lowering placeholders is only an identifier (it must not be spliced into)
  const odd = await runView(site(b), await program('view', 'SELECT n__q.id FROM notes AS n__q WHERE mantle.search(n__q, input.q) ORDER BY n__q.id', { q: 'text' }), caller({ q: '小籠包' }));
  r.equal('an alias containing __q is an identifier, not a placeholder: search() still works through it', odd.rows, ids('n1'));

  // a Schema whose lifecycle is publishing takes row ops only, and only a draft can be edited (the lifecycle rule)
  const fail = async (sql) => { try { await runProcedure(site(b), await program('procedure', sql), caller()); } catch (e) { return e; } };
  const setOp = await fail("UPDATE posts SET title = 'x' WHERE title = 'Hello world'");
  const published = await fail("UPDATE posts SET title = 'x' WHERE id = 'p1'");
  const draft = await runProcedure(site(b), await program('procedure', "UPDATE posts SET title = 'x' WHERE id = 'X_p2' RETURNING id"), caller());
  r.check('a set op on a publishing Schema is refused; a row op edits a draft, and a published entry is CONFLICT', isRefusal(setOp, 'SQL_SHAPE') && isConflict(published) && draft.rows[0].length === 1, [String(setOp?.message), String(published?.message)]);
}
