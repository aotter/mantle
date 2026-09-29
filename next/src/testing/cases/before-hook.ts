// @ts-nocheck test code over loosely typed IR and rows
// Conformance case 4: before hooks. A row op whose row changes between the hook and the commit fails
// with CONFLICT; a set op on a Schema with a before hook is refused.
import type { Report } from '../report.js';
import type { DatabaseDriver } from '../../core/driver.js';
import { boot, caller, program, site } from '../harness.js';
import { isConflict, opIndexOf, isRefusal, runProcedure } from '../harness.js';
import type { Hooks } from '../harness.js';


export async function run(r: Report, driver: DatabaseDriver) {
  r.section('Case 4: before hooks');
  const b = await boot(driver);
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

  // the hook reads the one visible row, then the statement carries the version the hook saw
  const ok = await runProcedure(s, set, caller({ id: 'a', s: 9 }));
  r.check('no concurrent write: commits and bumps version; the hook saw the one row before the change; the statement carries the version it saw',
    JSON.stringify(ok.rows) === '[[{"id":"a","stock":9,"version":2}]]' && seen.length === 1 && seen[0].id === 'a' && seen[0].stock === 5 && seen[0].version === 1 && ok.batch[0].sql.includes('version = ?') && ok.batch[0].binds!.includes(1), seen[0]);

  // the row changes between the hook and the commit: CONFLICT, and the concurrent write survives
  concurrent = async () => { await b.d1.exec(["UPDATE items SET stock = 99, version = version + 1 WHERE id = 'b'"]); };
  const e1 = await fails({ id: 'b', s: 1 });
  r.check('row changed between the hook and the commit: CONFLICT op=0, the concurrent write is not overwritten', isConflict(e1) && opIndexOf(e1) === 0 && JSON.stringify(await item('b')) === '{"stock":99,"version":2}', String(e1?.message));
  concurrent = undefined;

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
}
