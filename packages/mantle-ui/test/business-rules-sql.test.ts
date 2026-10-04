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
