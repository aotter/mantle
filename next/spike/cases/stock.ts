// Conformance case 2: stock. `SET stock = stock - input.qty` with checks: ["stock >= 0"], where an
// oversell fails through the check trigger.
import type { Report } from '../src/report.ts';
import { boot, caller, program, site } from '../src/fixtures.ts';
import { CheckViolation, Conflict, runProcedure } from '../src/exec.ts';

export async function run(r: Report) {
  r.section('Case 2: stock');
  const b = await boot();
  const s = site(b);
  const stock = async (id: string) => (await b.d1.all('SELECT stock FROM items WHERE id = ?1', [id]))[0]?.stock;
  const take = await program('procedure', 'UPDATE items SET stock = stock - input.qty WHERE id = input.id RETURNING id, stock', { id: 'text', qty: 'int8' });
  const fails = async (p: typeof take, input: Record<string, unknown>) => { try { await runProcedure(s, p, caller(input)); return undefined; } catch (e) { return e as Error; } };

  r.equal('take 3 of a (stock 5): RETURNING shows 2', (await runProcedure(s, take, caller({ id: 'a', qty: 3 }))).rows, [[{ id: 'a', stock: 2 }]]);
  const over = await fails(take, { id: 'b', qty: 10 });
  r.check('oversell b (stock 2, qty 10): CheckViolation naming the check', over instanceof CheckViolation && /CHECK items: stock >= 0/.test(over.message), String(over?.message));
  r.equal('oversell b: stock is unchanged', await stock('b'), 2);

  // the whole batch fails: an earlier statement in the same program is rolled back
  const both = await program('procedure', "UPDATE items SET stock = stock - 1 WHERE id = 'a'; UPDATE items SET stock = stock - 10 WHERE id = 'b'");
  const e2 = await fails(both, {});
  r.check('two updates, the second oversells: the batch fails with the check', e2 instanceof CheckViolation, String(e2?.message));
  r.equal('two updates: a keeps its stock (rolled back)', await stock('a'), 2);

  // a set op that would oversell any one row fails as a whole
  const set = await program('procedure', "UPDATE items SET stock = stock - 6 WHERE cat = 'x'");
  const e3 = await fails(set, {});
  r.check('set op, one row would go negative: the check fails', e3 instanceof CheckViolation, String(e3?.message));
  r.equal('set op: no row changed', await Promise.all(['a', 'b', 'd'].map(stock)), [2, 2, 7]);

  // an insert is checked too, on its own trigger
  const ins = await program('procedure', "INSERT INTO items (name, cat, stock) VALUES ('n', 'x', -1)");
  const e4 = await fails(ins, {});
  r.check('insert with stock -1: CheckViolation', e4 instanceof CheckViolation, String(e4?.message));

  // SQL CHECK semantics: NULL passes, exactly as in PostgreSQL
  const nul = await program('procedure', "UPDATE items SET stock = NULL WHERE id = 'd'");
  await runProcedure(s, nul, caller());
  r.equal('CHECK (stock >= 0) passes for NULL', await stock('d'), null);

  // the check does not reveal another owner's row: an invisible row is a CONFLICT, not a CHECK error
  for (const id of ['X_z1', 'X_e1']) {
    const e = await fails(take, { id, qty: 1000 });
    r.check(`${id} (another owner's / expired) with qty 1000: CONFLICT, not a check error`, e instanceof Conflict, String(e?.message));
  }
  r.equal('their stock is unchanged', await Promise.all(['X_z1', 'X_e1'].map(stock)), [50, 100]);

  // exact boundary: taking exactly what is left is allowed
  await runProcedure(s, take, caller({ id: 'a', qty: 2 }));
  r.equal('taking the last 2 leaves 0, which the check allows', await stock('a'), 0);
  await b.d1.dispose();
}
