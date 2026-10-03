import { expect, it } from 'vitest';
import { compileSql } from '../../src/spec/index.js';
import { procedureFlow } from '../../src/admin/procedureFlow.js';

it('projects ordered CASE values and row filters without inventing workflow branches', async () => {
  const compiled = await compileSql("UPDATE requests SET state = CASE WHEN amount < 1000000 THEN 'approved' WHEN amount >= 10000000 THEN 'finance_review' ELSE 'manager_review' END WHERE id = input.id; UPDATE requests SET state = 'ordered' WHERE id = input.id", { schemas: { requests: { fields: { state: 'text', amount: 'integer' } } }, inputs: { id: 'text' }, kind: 'procedure' });
  if (!compiled.ok) throw new Error(compiled.diagnostic.message);
  const flow = procedureFlow(compiled.plan.stmts);
  expect(flow.map((s) => s.operation)).toEqual(['UPDATE', 'UPDATE']);
  expect(flow[0]?.filter).toBe('id = input.id');
  expect(flow[0]?.cases).toEqual([{ field: 'state', branches: [{ condition: 'amount < 1000000', value: "'approved'" }, { condition: 'amount >= 10000000', value: "'finance_review'" }], otherwise: "'manager_review'" }]);
  expect(flow[1]?.cases).toEqual([]);
  const arithmetic = await compileSql('UPDATE requests SET amount = CASE WHEN (amount + 1) * 2 >= 100 THEN 1 ELSE 0 END WHERE id = input.id', { schemas: { requests: { fields: { amount: 'integer' } } }, inputs: { id: 'text' }, kind: 'procedure' });
  if (!arithmetic.ok) throw new Error(arithmetic.diagnostic.message);
  expect(procedureFlow(arithmetic.plan.stmts)[0]?.cases).toEqual([{ field: 'amount', branches: [{ condition: '((amount + 1) * 2) >= 100', value: '1' }], otherwise: '0' }]);
  const boolean = await compileSql('UPDATE requests SET amount = CASE WHEN (approved AND funded) = FALSE THEN 0 ELSE 1 END WHERE id = input.id', { schemas: { requests: { fields: { amount: 'integer', approved: 'bool', funded: 'bool' } } }, inputs: { id: 'text' }, kind: 'procedure' });
  if (!boolean.ok) throw new Error(boolean.diagnostic.message);
  expect(procedureFlow(boolean.plan.stmts)[0]?.cases[0]?.branches[0]?.condition).toBe('((approved) AND (funded)) = FALSE');
});
