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

  // approve: the CASE value, RETURNING rows of both statements, and one after-hook call with the written row
  const ok = await runProcedure(s, p, caller({ id: 'r1', approve: true }));
  r.equal('approve r1: RETURNING of the UPDATE and of the conditional INSERT', ok.rows, [[{ id: 'r1', state: 'approved' }], [{ item_id: 'a', qty: 2, total: null }]]);
  r.equal('approve r1: the row op persisted', await state('r1'), 'approved');
  r.equal('approve r1: the after hook ran once, with ctx.cause.rows holding the one written row', calls.length === 1 && (calls[0] as unknown[]).length, 1);
  r.check('approve r1: the hook row carries id and version although RETURNING * names neither', (calls[0] as any[])[0].id?.length > 0 && (calls[0] as any[])[0].version === 1 && (calls[0] as any[])[0].qty === 2, calls[0]);

  // reject: the INSERT writes zero rows, which is a normal result, and calls no hook
  const before = { orders: await orders(), calls: calls.length };
  const rej = await runProcedure(s, p, caller({ id: 'r2', approve: false }));
  r.equal('reject r2: the UPDATE returns the rejected row, the conditional INSERT writes nothing', rej.rows, [[{ id: 'r2', state: 'rejected' }], []]);
  r.equal('reject r2: no order row, and the hook was not called', { orders: await orders(), calls: calls.length }, before);

  // the precondition `state = 'pending'` no longer holds: CONFLICT op=0, nothing written, no hook
  let err: unknown;
  try { await runProcedure(s, p, caller({ id: 'r1', approve: true })); } catch (e) { err = e; }
  r.check('approve r1 again: CONFLICT with opIndex 0', err instanceof Conflict && err.opIndex === 0, String(err));
  r.equal('approve r1 again: the batch wrote nothing and called no hook', { orders: await orders(), calls: calls.length }, before);

  // another owner's requisition is invisible to the caller: the same CONFLICT, and it is untouched
  err = undefined;
  try { await runProcedure(s, p, caller({ id: 'X_rz', approve: true })); } catch (e) { err = e; }
  r.check("another owner's requisition: CONFLICT op=0, indistinguishable from a missing row", err instanceof Conflict && err.opIndex === 0, String(err));
  r.equal("another owner's requisition: unchanged", await state('X_rz'), 'pending');

  // atomicity and the exact op index: the second row op conflicts, so the first is rolled back
  const two = await program('procedure', "UPDATE items SET stock = stock - 1 WHERE id = 'a'; UPDATE items SET stock = 0 WHERE id = 'nope'");
  err = undefined;
  try { await runProcedure(s, two, caller()); } catch (e) { err = e; }
  r.check('two row ops, the second matches nothing: CONFLICT with opIndex 1', err instanceof Conflict && err.opIndex === 1, String(err));
  r.equal('two row ops: the first one was rolled back (stock of a is still 5)', (await b.d1.all("SELECT stock FROM items WHERE id = 'a'"))[0].stock, 5);

  // a plain row op with no precondition succeeds and bumps the version (OCC counter)
  const bump = await program('procedure', "UPDATE items SET stock = stock - 1 WHERE id = 'a' RETURNING stock");
  await runProcedure(s, bump, caller());
  r.equal('a row op bumps version', (await b.d1.all("SELECT stock, version FROM items WHERE id = 'a'"))[0], { stock: 4, version: 2 });
  await b.d1.dispose();
}
