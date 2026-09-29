// @ts-nocheck test code over loosely typed IR and rows
// Conformance case 2: stock. `SET stock = stock - input.qty` with checks: ["stock >= 0"], where an
// oversell fails through the check trigger.
import type { Report } from '../report.js';
import type { DatabaseDriver } from '../../core/driver.js';
import { boot, caller, program, site } from '../harness.js';
import { isCheck, isConflict, runProcedure } from '../harness.js';

export async function run(r: Report, driver: DatabaseDriver) {
  r.section('Case 2: stock');
  const b = await boot(driver);
  const s = site(b);
  const stock = async (id: string) => (await b.d1.all('SELECT stock FROM items WHERE id = ?1', [id]))[0]?.stock;
  const take = await program('procedure', 'UPDATE items SET stock = stock - input.qty WHERE id = input.id RETURNING id, stock', { id: 'text', qty: 'int8' });
  const fails = async (p: typeof take, input: Record<string, unknown>) => { try { await runProcedure(s, p, caller(input)); return undefined; } catch (e) { return e as Error; } };

  r.equal('take 3 of a (stock 5): RETURNING shows 2', (await runProcedure(s, take, caller({ id: 'a', qty: 3 }))).rows, [[{ id: 'a', stock: 2 }]]);
  const over = await fails(take, { id: 'b', qty: 10 });
  r.check('oversell b (stock 2, qty 10): CheckViolation naming the check, stock unchanged', isCheck(over) && /CHECK items: stock >= 0/.test(over.message) && (await stock('b')) === 2, String(over?.message));

  // the whole batch fails: an earlier statement is rolled back; a set op fails as a whole; an insert is checked on its own trigger
  const both = await program('procedure', "UPDATE items SET stock = stock - 1 WHERE id = 'a'; UPDATE items SET stock = stock - 10 WHERE id = 'b'");
  const set = await program('procedure', "UPDATE items SET stock = stock - 6 WHERE cat = 'x'");
  const ins = await program('procedure', "INSERT INTO items (name, cat, stock) VALUES ('n', 'x', -1)");
  const errs = [await fails(both, {}), await fails(set, {}), await fails(ins, {})];
  r.check('two updates (second oversells), a set op (one row would go negative), an insert of -1: each CheckViolation, nothing changed', errs.every((e) => isCheck(e)) && JSON.stringify(await Promise.all(['a', 'b', 'd'].map(stock))) === '[2,2,7]', errs.map((e) => e?.message));

  // SQL CHECK semantics: NULL passes, exactly as in PostgreSQL
  await runProcedure(s, await program('procedure', "UPDATE items SET stock = NULL WHERE id = 'd'"), caller());
  r.equal('CHECK (stock >= 0) passes for NULL', await stock('d'), null);

  // the check does not reveal another owner's row: an invisible row is a CONFLICT, not a CHECK error
  const hidden = [await fails(take, { id: 'X_z1', qty: 1000 }), await fails(take, { id: 'X_e1', qty: 1000 })];
  r.check("another owner's and an expired row with qty 1000: CONFLICT (not a check error), stock unchanged", hidden.every((e) => isConflict(e)) && JSON.stringify(await Promise.all(['X_z1', 'X_e1'].map(stock))) === '[50,100]', hidden.map((e) => e?.message));

  // exact boundary: taking exactly what is left is allowed
  await runProcedure(s, take, caller({ id: 'a', qty: 2 }));
  r.equal('taking the last 2 leaves 0, which the check allows', await stock('a'), 0);
}
