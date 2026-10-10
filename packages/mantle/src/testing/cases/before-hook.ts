// @ts-nocheck test code over loosely typed IR and rows
// Conformance case 4: before-hook snapshots add no implicit OCC. Explicit OCC and publishing protection remain.
import type { Report } from '../report.js';
import type { Engine } from '../harness.js';
import { boot, caller, program, site } from '../harness.js';
import { isConflict, opIndexOf, isRefusal, runProcedure } from '../harness.js';
import type { Hooks } from '../harness.js';


export async function run(r: Report, engine: Engine) {
  r.section('Case 4: before hooks');
  const b = await boot(engine);
  const seen: any[] = [];
  let concurrent: (() => Promise<void>) | undefined;
  let veto = false;
  const hooks: Hooks = { before: { items: { update: async ({ row }) => {
    seen.push(row);
    if (veto) throw new Error('hook says no');
    await concurrent?.();
  } } } };
  const s = site(b, hooks);
  const set = await program('procedure', 'UPDATE items SET stock = input.s WHERE id = input.id RETURNING id, stock, version', { id: 'text', s: 'int8' });
  const fails = async (input: Record<string, unknown>) => { try { await runProcedure(s, set, caller(input)); return undefined; } catch (e) { return e as Error; } };
  const item = async (id: string) => (await b.d1.all('SELECT stock, version FROM items WHERE id = ?1', [id]))[0];

  const ok = await runProcedure(s, set, caller({ id: 'a', s: 9 }));
  r.check('commits and bumps version; the hook saw the visible row before the change',
    JSON.stringify(ok.rows) === '[[{"id":"a","stock":9,"version":2}]]' && seen.length === 1 && seen[0].id === 'a' && seen[0].stock === 5 && seen[0].version === 1, seen[0]);

  // Observing a hook snapshot does not add a lock to an operational write.
  concurrent = async () => { await b.d1.exec(["UPDATE items SET stock = 99, version = version + 1 WHERE id = 'b'"]); };
  const unpinned = await runProcedure(s, set, caller({ id: 'b', s: 1 }));
  r.check('a concurrent hook-time change is overwritten without authored OCC', JSON.stringify(unpinned.rows) === '[[{"id":"b","stock":1,"version":3}]]');
  const pinned = await program('procedure', 'UPDATE items SET stock = input.s WHERE id = input.id AND version = input.v RETURNING id', { id: 'text', s: 'int8', v: 'int8' });
  let e1: Error | undefined;
  try { await runProcedure(s, pinned, caller({ id: 'b', s: 2, v: 3 })); } catch (e) { e1 = e as Error; }
  r.check('authored OCC rejects a hook-time change; the concurrent write survives', isConflict(e1) && opIndexOf(e1) === 0 && JSON.stringify(await item('b')) === '{"stock":99,"version":4}', String(e1?.message));
  concurrent = undefined;

  const publishing = site(b, { before: { posts: { update: async () => {
    await b.d1.exec(["UPDATE posts SET title = 'concurrent draft', version = version + 1 WHERE id = 'X_p2'"]);
  } } } });
  let publishingError: Error | undefined;
  try { await runProcedure(publishing, await program('procedure', "UPDATE posts SET title = 'outer edit' WHERE id = input.id" , { id: 'text' }), caller({ id: 'X_p2' })); } catch (e) { publishingError = e as Error; }
  r.check('publishing state decisions keep their implicit pin even without authored OCC', isConflict(publishingError) && (await b.d1.all("SELECT title FROM posts WHERE id = 'X_p2'"))[0].title === 'concurrent draft', String(publishingError?.message));

  // a hook that throws vetoes the write: fail closed
  veto = true;
  const e2 = await fails({ id: 'd', s: 1 });
  r.check('a throwing hook stops the statement and nothing is written', e2?.message === 'hook says no' && (await item('d')).stock === 7, String(e2?.message));
  veto = false;

  // no visible row (another owner's, expired): CONFLICT without calling the hook
  const calls = seen.length;
  const e3 = await fails({ id: 'X_z1', s: 1 });
  r.check("another owner's row: CONFLICT, and the hook was never called (it cannot probe for the row)", isConflict(e3) && seen.length === calls, String(e3?.message));

  // a set op on a Schema with a before hook is refused at compile time
  let refused: Error | undefined;
  try { await runProcedure(s, await program('procedure', "UPDATE items SET stock = 0 WHERE cat = 'x'"), caller()); } catch (e) { refused = e as Error; }
  r.check('a set op on items (before update hook) is refused', isRefusal(refused, 'SQL_SHAPE') && /before hooks take row ops only/.test(refused.message), refused?.message);
  // a Schema without a hook keeps its set ops; a before-update hook does not run for insert
  const other = await runProcedure(s, await program('procedure', "UPDATE requisitions SET state = 'x' WHERE state = 'pending' RETURNING id"), caller());
  const ins = await runProcedure(s, await program('procedure', "INSERT INTO items (name, cat, stock) VALUES ('n', 'x', 1) RETURNING name"), caller());
  r.check('set ops stay legal where no before hook exists; the update hook does not run for insert', other.rows[0].length === 2 && seen.length === calls && ins.rows.length === 1);

  // a before create hook reads the VALUES in a read of its own, so they may not depend on data that can change before the commit
  const own = { ...s, hooks: { before: { orders: { insert: () => undefined } } } };
  let subq: Error | undefined;
  try { await runProcedure(own, await program('procedure', "INSERT INTO orders (item_id, qty) VALUES ('a', (SELECT stock FROM items WHERE id = 'a'))"), caller()); } catch (e) { subq = e as Error; }
  const plain = await runProcedure(own, await program('procedure', "INSERT INTO orders (item_id, qty) VALUES ('a', 1) RETURNING qty"), caller());
  r.check('an insert with a before create hook may not read data in its VALUES, and constant values are fine', isRefusal(subq, 'SQL_SHAPE') && plain.rows[0].length === 1, subq?.message);
  // Hidden after-hook columns belong to the actual operation, even when an unchanged Program hits the compile cache.
  const afterRows: any[] = [];
  const afterUpdate = site(b, { after: { requisitions: { update: ({ rows }) => { afterRows.push(...rows); } } } });
  const update = await program('procedure', "UPDATE requisitions SET state = 'done' WHERE state = 'x' RETURNING id");
  const irrelevant = await runProcedure(site(b, { after: { requisitions: { insert: () => { throw new Error('wrong verb'); } } } }), update, caller());
  r.check('a different-verb after hook adds no hidden RETURNING', !JSON.stringify(irrelevant.batch).includes('_mantle_h_') && irrelevant.rows[0].length === 2);
  await b.d1.exec(["UPDATE requisitions SET state = 'x' WHERE owner = 'o1'"]);
  const relevant = await runProcedure(afterUpdate, update, caller());
  r.check('the same Program with the matching hook returns whole rows to the hook and authored columns to the caller',
    JSON.stringify(relevant.batch).includes('_mantle_h_') && afterRows.length === 2 && afterRows.every((row) => row.state === 'done' && row.version === 4)
      && relevant.rows[0].every((row) => Object.keys(row).join() === 'id'), afterRows);
  const noReturning = await runProcedure(afterUpdate, await program('procedure', "UPDATE requisitions SET state = 'again' WHERE state = 'done'"), caller());
  r.check('a hooked set operation without author RETURNING still returns no rows', noReturning.rows[0].length === 0 && afterRows.length === 4);

  const ordered: any[] = [];
  const sequential = site(b, { before: { items: { update: async ({ row }) => {
    ordered.push({ id: row.id, stock: row.stock });
    if (row.id === 'a') await b.d1.exec(["UPDATE items SET stock = 77 WHERE id = 'b'"]);
  } } } });
  await runProcedure(sequential, await program('procedure', "UPDATE items SET stock = 3 WHERE id = 'a'; UPDATE items SET stock = 4 WHERE id = 'b'"), caller());
  r.equal('each ordered before hook reads after earlier hooks have committed their own writes', ordered, [{ id: 'a', stock: 9 }, { id: 'b', stock: 77 }]);

}
