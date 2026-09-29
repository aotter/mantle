// Conformance case 1: the requisition program. A CASE value, RETURNING, a `WHERE id AND cond`
// precondition that fails with CONFLICT, and a conditional INSERT ... SELECT ... WHERE that writes zero
// or one row and calls an after hook only when it writes.
import type { Report } from '../src/report.ts';
import { boot, caller, program, site } from '../src/fixtures.ts';
import { Conflict, runProcedure } from '../src/exec.ts';
import type { Hooks } from '../src/exec.ts';

const PROGRAM = `
  UPDATE requisitions SET state = CASE WHEN input.approve THEN 'approved' ELSE 'rejected' END
    WHERE id = input.id AND state = 'pending' RETURNING id, state;
  INSERT INTO orders (item_id, qty) SELECT r.item_id, r.qty FROM requisitions r
    WHERE r.id = input.id AND r.state = 'approved' RETURNING *;`;

export async function run(r: Report) {
  r.section('Case 1: requisition');
  const b = await boot();
  const calls: unknown[] = [];
  const hooks: Hooks = { after: { orders: { insert: ({ rows }) => { calls.push(rows); } } } };
  const s = site(b, hooks);
  const p = await program('procedure', PROGRAM, { id: 'text', approve: 'bool' });
  const state = async (id: string) => (await b.d1.all('SELECT state FROM requisitions WHERE id = ?1', [id]))[0]?.state;
  const orders = async () => (await b.d1.all("SELECT count(*) n FROM orders WHERE owner = 'o1'"))[0].n;

  const conflictOf = async (prog: typeof p, input: Record<string, unknown>) => { try { await runProcedure(s, prog, caller(input)); } catch (e) { return e instanceof Conflict ? e.opIndex : String(e); } };

  // approve: the CASE value, RETURNING rows of both statements, one after-hook call with the written row
  const ok = await runProcedure(s, p, caller({ id: 'r1', approve: true }));
  r.equal('approve r1: RETURNING of the UPDATE and of the conditional INSERT, and the row op persisted', [ok.rows, await state('r1')], [[[{ id: 'r1', state: 'approved' }], [{ item_id: 'a', qty: 2, total: null }]], 'approved']);
  const row = (calls[0] as any[] | undefined)?.[0];
  r.check('approve r1: the after hook ran once; its row carries id and version although RETURNING * names neither', calls.length === 1 && row?.id?.length > 0 && row.version === 1 && row.qty === 2, calls);

  // reject: the INSERT writes zero rows, which is a normal result, and calls no hook
  const before = { orders: await orders(), calls: calls.length };
  const rej = await runProcedure(s, p, caller({ id: 'r2', approve: false }));
  r.equal('reject r2: the conditional INSERT writes nothing, and calls no hook', [rej.rows, { orders: await orders(), calls: calls.length }], [[[{ id: 'r2', state: 'rejected' }], []], before]);

  // the precondition no longer holds (r1 again), or the row is not visible (another owner's): the same CONFLICT op=0
  r.equal('r1 again and another owner\'s X_rz: CONFLICT op=0 each, nothing written, no hook', [await conflictOf(p, { id: 'r1', approve: true }), await conflictOf(p, { id: 'X_rz', approve: true }), await state('X_rz'), { orders: await orders(), calls: calls.length }], [0, 0, 'pending', before]);

  // atomicity and the exact op index: the second row op conflicts, so the first is rolled back
  const two = await program('procedure', "UPDATE items SET stock = stock - 1 WHERE id = 'a'; UPDATE items SET stock = 0 WHERE id = 'nope'");
  r.equal('two row ops, the second matches nothing: CONFLICT op=1 and the first is rolled back (stock of a is still 5)', [await conflictOf(two, {}), (await b.d1.all("SELECT stock FROM items WHERE id = 'a'"))[0].stock], [1, 5]);
  await b.d1.dispose();
}
