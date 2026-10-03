import { expect, it } from 'vitest';
import { compileSql } from '../../src/spec/index.js';
import { procedureFlow } from '../../src/admin/procedureFlow.js';
import { relationsOf } from '../../src/admin/developerConsole.js';

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
  const conditionalInsert = await compileSql("INSERT INTO requests (amount, state) SELECT amount, 'approved' FROM requests WHERE amount < 1000 RETURNING id", { schemas: { requests: { fields: { amount: 'integer', state: 'text' } } }, inputs: {}, kind: 'procedure' });
  if (!conditionalInsert.ok) throw new Error(conditionalInsert.diagnostic.message);
  expect(procedureFlow(conditionalInsert.plan.stmts, relationsOf)[0]).toMatchObject({ mode: 'set', reads: ['requests'], writes: ['requests'], filter: 'amount < 1000', returns: ['id'] });
});

it('projects nested Boolean predicates, EXISTS, joins and CASE outside UPDATE assignments', async () => {
  const text = "INSERT INTO requests (amount, state) SELECT amount, CASE WHEN funded AND (approved OR amount < 100) THEN 'approved' ELSE 'pending' END FROM requests WHERE NOT approved AND amount IS NOT NULL AND EXISTS (SELECT 1 FROM requests x WHERE x.amount = requests.amount) RETURNING id";
  const compiled = await compileSql(text, { schemas: { requests: { fields: { amount: 'integer', state: 'text', funded: 'bool', approved: 'bool' } } }, inputs: {}, kind: 'procedure' });
  if (!compiled.ok) throw new Error(compiled.diagnostic.message);
  const tree = procedureFlow(compiled.plan.stmts)[0]!.logic;
  const flat = (n: typeof tree): string[] => [n.label, ...n.children.flatMap(flat)];
  expect(flat(tree)).toEqual(expect.arrayContaining(['INSERT', 'SELECT', 'AND · all conditions', 'OR · any condition', 'NOT', 'IS NOT NULL', 'EXISTS', 'CASE · first TRUE condition', 'RETURNING']));
  const source = tree.children.find((n) => n.label === 'Source SELECT')!.children[0]!;
  const and = source.children.find((n) => n.label.startsWith('WHERE'))!.children[0]!;
  expect(and.label).toBe('AND · all conditions');
  expect(and.children.map((n) => n.label)).toEqual(['NOT', 'IS NOT NULL', 'EXISTS']);
});

it('projects PostgreSQL CTE, aggregate FILTER, window and conflict structures', async () => {
  const pg = await import('../../src/postgres/compile/index.js');
  const compiled = await compileSql('WITH r AS (SELECT id, amount FROM requests) SELECT id, sum(amount) FILTER (WHERE amount > 0) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS total FROM r', { schemas: { requests: { fields: { amount: 'integer' } } }, inputs: {}, kind: 'view' }, pg);
  if (!compiled.ok) throw new Error(compiled.diagnostic.message);
  const tree = procedureFlow(compiled.plan.stmts)[0]!.logic;
  const flat = (n: typeof tree): string[] => [n.label, ...n.children.flatMap(flat)];
  expect(flat(tree)).toEqual(expect.arrayContaining(['WITH', 'r', 'sum', 'FILTER', 'OVER', 'ORDER BY', 'Frame start']));
});

it('keeps interval modifiers opaque and labels DISTINCT and IN subqueries faithfully', async () => {
  const pg = await import('../../src/postgres/compile/index.js');
  const flat = (n: ReturnType<typeof procedureFlow>[number]['logic']): string[] => [n.label, ...n.children.flatMap(flat)];
  for (const [text, label] of [["SELECT CAST('2 hours' AS INTERVAL HOUR) FROM requests", 'CAST → pg_catalog.interval · type modifiers: see authored SQL'], ['SELECT DISTINCT amount FROM requests', 'DISTINCT'], ['SELECT amount FROM requests WHERE amount IN (SELECT amount FROM requests)', 'IN']]) {
    const compiled = await compileSql(text!, { schemas: { requests: { fields: { amount: 'integer' } } }, inputs: {}, kind: 'view' }, pg);
    if (!compiled.ok) throw new Error(compiled.diagnostic.message);
    const labels = flat(procedureFlow(compiled.plan.stmts)[0]!.logic);
    expect(labels).toContain(label);
    expect(labels.some((l) => l.startsWith('undefined'))).toBe(false);
  }
});
