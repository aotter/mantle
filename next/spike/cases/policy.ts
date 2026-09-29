// Conformance case 7: the relation-position probe (ADR-0034 decision 8). Every position at which the IR
// can reach a relation has a probe; the list is a Record checked with `satisfies` against the position
// union in src/positions.ts, so a new position without a probe fails `tsc` (cases/typecheck.ts shows it).
// Each probe seeds a second owner's rows, an expired one and an unpublished one (`X_` ids, `LEAK` text)
// and asserts none of them appears in a result or changes.
import type { Report } from '../src/report.ts';
import { CENTER, NOW, boot, caller, program, reset, site } from '../src/fixtures.ts';
import { Conflict, runProcedure, runView } from '../src/exec.ts';
import type { Mode } from '../src/policy.ts';
import { ALL_POSITIONS } from '../src/positions.ts';
import type { RelationPosition } from '../src/positions.ts';

type Step = {
  kind: 'view' | 'procedure';
  sql: string;
  inputs?: Record<string, string>;
  input?: Record<string, unknown>;
  mode?: Mode;
  /** what the caller is entitled to see: the exact rows of every statement, as JSON */
  rows?: unknown[][];
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
  'from-subquery': { steps: [v('SELECT s.id FROM (SELECT id FROM items) s ORDER BY s.id', ids('a', 'b', 'c', 'd'))] },
  sublink: { steps: [
    v('SELECT id FROM orders WHERE item_id IN (SELECT id FROM items) ORDER BY id', ids('oa', 'ob')),
    v("SELECT id FROM requisitions WHERE EXISTS (SELECT 1 FROM items WHERE name LIKE 'LEAK%')", []),
    v("SELECT id FROM requisitions WHERE EXISTS (SELECT 1 FROM items WHERE name = 'apple') ORDER BY id", ids('r1', 'r2')),
    v("SELECT (SELECT count(*) FROM items) AS n, (SELECT max(stock) FROM items) AS mx FROM requisitions WHERE id = 'r1'", [{ n: 4, mx: 9 }]),
  ] },
  json_each: { steps: [v('SELECT j.value AS v FROM items i, json_each(i.tags) j ORDER BY i.id, j.id', [{ v: 'red' }, { v: 'big' }, { v: 'blue' }, { v: 'red' }, { v: 'red' }])] },
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
  search: { steps: [v('SELECT id FROM notes WHERE search(notes, input.q) ORDER BY id', ids('n1'), { q: 'text' }, { q: '小籠包' })] },
  near: { steps: [v('SELECT id FROM places WHERE near(places.loc, input.lat, input.lng, 5000) ORDER BY id', ids('pl1200', 'pl300', 'pl4900'), { lat: 'float8', lng: 'float8' }, { lat: CENTER.lat, lng: CENTER.lng })] },
} satisfies Record<RelationPosition, Probe>;

/** every row that must never change: another owner's, expired and unpublished rows all have an `X_` id */
async function protectedRows(d1: { all: (sql: string) => Promise<any[]> }) {
  const out: Record<string, unknown> = {};
  for (const t of ['items', 'requisitions', 'orders', 'settings', 'posts', 'notes', 'places']) out[t] = await d1.all(`SELECT * FROM ${t} WHERE id LIKE 'X\\_%' ESCAPE '\\' ORDER BY id`);
  return out;
}

export async function run(r: Report) {
  r.section('Case 7: policy probe (every relation position, another owner / expired / unpublished rows)');
  const b = await boot();
  const seen = new Set<RelationPosition>();
  const s = { ...site(b), seen };
  const positions = Object.keys(PROBES) as RelationPosition[];
  r.equal(`the probe list covers all ${ALL_POSITIONS.length} positions of the IR union (and \`satisfies\` makes that a typecheck error when it does not)`, positions.sort(), [...ALL_POSITIONS].sort());

  for (const pos of positions) {
    const own = new Set<RelationPosition>();
    s.seen = own;
    let n = 0;
    for (const step of PROBES[pos].steps) {
      n++;
      await reset(b.d1);
      const before = JSON.stringify(await protectedRows(b.d1));
      const p = await program(step.kind, step.sql, step.inputs ?? {});
      const rt = caller(step.input);
      const label = `${pos} #${n}`;
      let rows: unknown[][] | undefined, err: unknown;
      try {
        rows = step.kind === 'view' ? [(await runView({ ...s, mode: step.mode }, p, rt)).rows] : (await runProcedure({ ...s, mode: step.mode }, p, rt)).rows;
      } catch (e) { err = e; }
      if (step.conflict) r.check(`${label}: ${step.sql.slice(0, 60)} -> CONFLICT (an invisible row is a missing row)`, err instanceof Conflict, String(err));
      else {
        r.check(`${label}: ${step.sql.slice(0, 70)}`, !err, String(err));
        if (rows) {
          const json = JSON.stringify(rows);
          r.check(`${label}: no LEAK and no X_ row in the result`, !json.includes('LEAK') && !json.includes('X_'), json.slice(0, 200));
          if (step.rows) r.equal(`${label}: the caller's own rows are all there (the probe is not vacuous)`, rows, step.rows);
        }
      }
      r.check(`${label}: other owner's, expired and unpublished rows are unchanged`, JSON.stringify(await protectedRows(b.d1)) === before);
    }
    r.check(`${pos}: the policy pass printed a wrapper (or emitted a system relation) at this position`, own.has(pos), [...own].join(', '));
    own.forEach((x) => seen.add(x));
  }
  r.check('all positions were reached by at least one probe at run time', ALL_POSITIONS.every((p) => seen.has(p)), ALL_POSITIONS.filter((p) => !seen.has(p)).join(', '));

  // negative control: with the visibility predicate switched off, every read/write position must be caught by its probe
  const caught: string[] = [], missed: string[] = [];
  for (const pos of positions) {
    let detected = false;
    for (const step of PROBES[pos].steps) {
      await reset(b.d1);
      const before = JSON.stringify(await protectedRows(b.d1));
      const p = await program(step.kind, step.sql, step.inputs ?? {});
      let rows: unknown[][] | undefined, err: unknown;
      try { rows = step.kind === 'view' ? [(await runView({ ...site(b), unsafeNoVisibility: true }, p, caller(step.input))).rows] : (await runProcedure({ ...site(b), unsafeNoVisibility: true }, p, caller(step.input))).rows; } catch (e) { err = e; }
      const json = JSON.stringify(rows ?? []);
      if (step.conflict ? !(err instanceof Conflict) : err || json.includes('LEAK') || json.includes('X_') || (step.rows && JSON.stringify(rows) !== JSON.stringify(step.rows))) detected = true;
      if (JSON.stringify(await protectedRows(b.d1)) !== before) detected = true;
    }
    (detected ? caught : missed).push(pos);
  }
  r.check(`negative control: with the visibility predicate off, ${caught.length} of ${positions.length} positions are caught by their probes`, caught.length >= positions.length - 1, `missed: ${missed.join(', ') || 'none'}`);
  r.note(`  not caught by this switch: ${missed.join(', ') || 'none'} (insert-target is protected by the scope and id fill and the scope-including unique index, which the switch leaves on; the check is its owner/id assertion below)`);

  // what the ADR says about the write path, on top of the positions
  await reset(b.d1);
  const ins = await program('procedure', "INSERT INTO settings (key, value) VALUES ('lang', 'yy') RETURNING id");
  const { rows } = await runProcedure({ ...s }, ins, caller());
  const mine = (await b.d1.all('SELECT owner, created_at, length(id) AS idlen FROM settings WHERE id = ?1', [(rows[0][0] as any).id]))[0];
  r.equal('an insert is owned by the caller, stamped with now(), and gets a generated id', mine, { owner: 'o1', created_at: NOW, idlen: 32 });
  r.equal("another owner's 'lang' setting was not touched by the same-key insert", (await b.d1.all("SELECT value FROM settings WHERE id = 'X_sz2'"))[0].value, 'xx');

  // modes: public reads see published, unexpired rows only; trusted (runtime.store) sees every owner but TTL still applies
  const posts = await program('view', 'SELECT id FROM posts ORDER BY id');
  r.equal('public caller: only the published, unexpired post', (await runView({ ...s, mode: 'public' }, posts, caller())).rows, ids('p1'));
  const all = await program('view', 'SELECT id FROM items ORDER BY id');
  r.equal('trusted runtime.store: no scope, but the expired row is still hidden', (await runView({ ...s, mode: 'trusted' }, all, caller())).rows, ids('X_z1', 'X_z2', 'a', 'b', 'c', 'd'));
  await b.d1.dispose();
}
