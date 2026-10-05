import { expect, it } from 'vitest';
import { compileSql } from '../../mantle/src/spec/index';
import * as pg from '../../mantle/src/postgres/compile/index';
import { procedureFlow } from '../../mantle/src/admin/procedureFlow';
import { businessRules } from '../admin/src/features/logic/business-rules';
import type { DeveloperAtom, DeveloperSchemaModel } from '../admin/src/lib/types';

// Exercise the real compiler → developer AST → wording seam, not a parallel hand-built AST.
async function project(value: string, currency?: string, mixedCase = false) {
  const compiled = await compileSql(`UPDATE stock SET result = ${value} WHERE id = input.id`, {
    schemas: { stock: { fields: { quantity: 'integer', result: 'integer' } } }, inputs: { id: 'text' }, kind: 'procedure',
  }, pg);
  if (!compiled.ok) throw new Error(compiled.diagnostic.message);
  const atom = { id: 'Procedure:test', kind: 'Procedure', name: 'test', title: '任意規則', handler: { kind: 'sql', statement: '', flow: procedureFlow(compiled.plan.stmts) } } as DeveloperAtom;
  const schemas = [{ name: mixedCase ? 'Stock' : 'stock', title: '測試庫存', schema: { properties: {
    [mixedCase ? 'Quantity' : 'quantity']: { type: 'integer', title: '測量值', 'x-mcp-hint': 'money-minor' }, [mixedCase ? 'Result' : 'result']: { type: 'integer', title: '計算結果' },
    ...(currency ? { currency: { type: 'string', enum: [currency] } } : {}),
  } } }] as DeveloperSchemaModel[];
  return { rules: businessRules(atom, schemas, 'zh-TW') };
}
const choice = (threshold: string) => `CASE WHEN quantity < ${threshold} THEN 7 ELSE 9 END`;

it('resolves folded SQL names against manifest titles and keeps direct CASE results', async () => {
  const { rules } = await project(choice('7'), undefined, true);
  expect(rules.map((r) => r.title)).toEqual(['更新 測試庫存', '決定「計算結果」']);
  expect(rules[1]!.branches![0]).toEqual({ condition: '測量值 小於 0.07', value: '7' });
});

it('does not present CASE operands inside arithmetic, casts or functions as assigned values', async () => {
  for (const value of [`(${choice('7')}) + 100`, `CAST((${choice('7')}) AS bigint)`, `coalesce((${choice('7')}), 0)`]) {
    expect((await project(value)).rules.map((r) => r.kind)).toEqual(['operation']);
  }
});

it('preserves exact SQL thresholds when numeric conversion or currency formatting would round', async () => {
  for (const [threshold, currency] of [['1000000.00000000001', 'TWD'], ['9007199254740991', 'TWD'], ['9007199254740993', 'TWD'], ['7', 'JPY']]) {
    const { rules } = await project(choice(threshold!), currency);
    expect(rules[1]!.branches![0]!.condition).toBe(`測量值 小於 ${threshold} (SQL 原值)`);
  }
  const normal = await project(choice('1000000'), 'TWD');
  expect(normal.rules[1]!.branches![0]!.condition).toContain('10,000');
  expect(normal.rules[1]!.branches![0]!.condition).not.toContain('SQL 原值');
});

it('projects arbitrary state handoffs, aliases, role predicates and checks without guessing business names', async () => {
  const compiled = await compileSql(`UPDATE stock SET phase = CASE WHEN quantity < 7 THEN 'ready' ELSE 'review' END WHERE id=input.id AND phase='draft' AND requester<>auth.uid() AND EXISTS (SELECT 1 FROM access a WHERE a.subject=auth.uid() AND a.allowed=true)`, {
    schemas: { stock: { fields: { quantity: 'integer', phase: 'text', requester: 'text' } }, access: { fields: { subject: 'text', allowed: 'bool' } } }, inputs: { id: 'text' }, kind: 'procedure',
  }, pg);
  if (!compiled.ok) throw new Error(compiled.diagnostic.message);
  const atom = { id: 'Procedure:inspect', kind: 'Procedure', name: 'inspect', title: '檢查庫存', handler: { kind: 'sql', statement: '', flow: procedureFlow(compiled.plan.stmts) } } as DeveloperAtom;
  const schemas = [
    { name: 'stock', title: '庫存', schema: { properties: { quantity: { type: 'integer', title: '數量' }, requester: { type: 'string', title: '提報者' }, phase: { type: 'string', title: '處理階段', oneOf: [{ const: 'draft', title: '草稿' }, { const: 'ready', title: '可出貨' }, { const: 'review', title: '待檢查' }] } } } },
    { name: 'access', title: '操作資格', schema: { properties: { subject: { title: '人員' }, allowed: { type: 'boolean', title: '可操作' } } } },
  ] as DeveloperSchemaModel[];
  const rules = businessRules(atom, schemas, 'zh-TW');
  expect(rules[0]!.transitions).toEqual([{ schema: 'stock', field: 'phase', from: 'draft', to: ['ready', 'review'] }]);
  expect(rules[0]!.conditions).toContain('提報者 不等於 目前使用者的識別碼');
  expect(rules[0]!.conditions).toContain('操作資格 · 可操作 等於 是');
  expect(rules[0]!.conditions).not.toContain('尚無業務翻譯');
  const { businessOverview } = await import('../admin/src/features/logic/business-overview');
  const graph = businessOverview({ atoms: [atom], relations: [] }, schemas, 'zh-TW');
  expect(graph.nodes[0]!.data.title).toBe('檢查庫存');
  expect(graph.nodes[0]!.data.subtitle).toBe('草稿 → 可出貨／待檢查');
  const next = { ...atom, id: 'Procedure:ship', name: 'ship', title: '出貨', handler: { kind: 'sql', statement: '', flow: procedureFlow((await compileSql("UPDATE stock SET phase='review' WHERE id=input.id AND phase='ready'", { schemas: { stock: { fields: { quantity: 'integer', phase: 'text' } } }, inputs: { id: 'text' }, kind: 'procedure' }, pg) as Extract<Awaited<ReturnType<typeof compileSql>>, { ok: true }>).plan.stmts) } } as DeveloperAtom;
  const path = businessOverview({ atoms: [atom, next], relations: [] }, schemas, 'zh-TW');
  expect(path.edges).toHaveLength(1);
  expect(path.edges[0]!.label).toBe('可出貨');
  expect(graph.edges.every((e) => e.style?.strokeDasharray)).toBe(true);
  for (const predicate of [`phase='draft' OR quantity=7`, `NOT (phase='draft')`, `phase IN ('draft','review')`]) {
    const ir = await compileSql(`UPDATE stock SET phase='ready' WHERE id=input.id AND (${predicate})`, { schemas: { stock: { fields: { quantity: 'integer', phase: 'text' } } }, inputs: { id: 'text' }, kind: 'procedure' }, pg);
    if (!ir.ok) throw new Error(ir.diagnostic.message);
    expect(businessRules({ ...atom, handler: { kind: 'sql', statement: '', flow: procedureFlow(ir.plan.stmts) } }, schemas, 'zh-TW')[0]!.transitions).toEqual([]);
  }
});
