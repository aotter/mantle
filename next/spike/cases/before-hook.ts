// Conformance case 4: before hooks. A row op whose row changes between the hook and the commit fails
// with CONFLICT; a set op on a Schema with a before hook is refused.
import type { Report } from '../src/report.ts';
import { boot, caller, program, site } from '../src/fixtures.ts';
import { Conflict, compileProgram, runProcedure } from '../src/exec.ts';
import type { Hooks } from '../src/exec.ts';
import { Refused } from '../src/types.ts';

export async function run(r: Report) {
  r.section('Case 4: before hooks');
  const b = await boot();
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
  r.equal('no concurrent write: the row op commits and bumps version', ok.rows, [[{ id: 'a', stock: 9, version: 2 }]]);
  r.check('the hook saw the row before the change (ctx.cause.rows holds that one row)', seen.length === 1 && seen[0].id === 'a' && seen[0].stock === 5 && seen[0].version === 1, seen[0]);
  r.check('the statement carries the version the hook saw', ok.batch[0].sql.includes('version = ?') && ok.batch[0].binds!.includes(1), ok.batch[0].sql.slice(-80));

  // the row changes between the hook and the commit: CONFLICT, and the concurrent write survives
  concurrent = async () => { await b.d1.exec(["UPDATE items SET stock = 99, version = version + 1 WHERE id = 'b'"]); };
  const e1 = await fails({ id: 'b', s: 1 });
  r.check('row changed between the hook and the commit: CONFLICT op=0', e1 instanceof Conflict && e1.opIndex === 0, String(e1?.message));
  r.equal('the concurrent write is not overwritten', await item('b'), { stock: 99, version: 2 });
  concurrent = undefined;

  // a hook that throws vetoes the write: fail closed
  veto = true;
  const e2 = await fails({ id: 'd', s: 1 });
  r.check('a throwing hook stops the statement', e2?.message === 'hook says no', String(e2?.message));
  r.equal('and nothing was written', (await item('d')).stock, 7);
  veto = false;

  // no visible row (another owner's, expired): CONFLICT without calling the hook
  const calls = seen.length;
  const e3 = await fails({ id: 'X_z1', s: 1 });
  r.check("another owner's row: CONFLICT, and the hook was never called (it cannot probe for the row)", e3 instanceof Conflict && seen.length === calls, String(e3?.message));

  // a set op on a Schema with a before hook is refused at compile time, with a position-free diagnostic code
  const setOp = await program('procedure', "UPDATE items SET stock = 0 WHERE cat = 'x'");
  let refused: Refused | undefined;
  try { compileProgram(s, setOp); } catch (e) { refused = e as Refused; }
  r.check('a set op on items (before update hook) is refused', refused instanceof Refused && refused.code === 'SQL_SHAPE' && /before hooks take row ops only/.test(refused.message), refused?.message);
  // a Schema without a hook keeps its set ops
  const other = await program('procedure', "UPDATE requisitions SET state = 'x' WHERE state = 'pending' RETURNING id");
  r.equal('set ops stay legal where no before hook exists', (await runProcedure(s, other, caller())).rows[0].length, 2);
  // an INSERT row op on a Schema whose hook is for update is unaffected
  const ins = await program('procedure', "INSERT INTO items (name, cat, stock) VALUES ('n', 'x', 1) RETURNING name");
  r.equal('a before-update hook does not run for insert', (await runProcedure(s, ins, caller())).rows, [[{ name: 'n' }]]);
  await b.d1.dispose();
}
