import { expect, it } from 'vitest';
import { businessRules } from './business-rules';
import type { DeveloperAtom, DeveloperSchemaModel, SqlLogicNode } from '../../lib/types';

it('derives business names and boundaries from arbitrary manifest fields without guessing units or state meanings', () => {
  const n = (kind: string, label: string, children: SqlLogicNode[] = []): SqlLogicNode => ({ kind, label, children });
  const decision = n('case', 'CASE · first TRUE condition', [n('when', 'WHEN 1', [n('predicate', 'Condition', [n('expression', '<', [n('value', 'quantity'), n('value', '7')])]), n('value', 'THEN', [n('value', "'hold'")])]), n('value', 'ELSE', [n('value', "'release'")])]);
  const atom: DeveloperAtom = { id: 'Procedure:arbitrary', kind: 'Procedure', name: 'arbitrary', title: '任意規則', handler: { kind: 'sql', statement: '', flow: [{ index: 0, operation: 'UPDATE', table: 'inventory', mode: 'row', reads: [], writes: ['inventory'], returns: [], filter: null, cases: [], logic: n('statement', 'UPDATE', [n('clause', 'SET', [n('output', 'decision', [decision])])]) }] } };
  const schemas = [{ name: 'inventory', title: '庫存', lifecycle: 'operational', localized: false, translates: null, uniqueIndexes: [], indexes: [], searchableFields: [], manifest: {}, schema: { properties: { quantity: { type: 'integer', title: '數量' }, decision: { type: 'string', title: '處理方式', oneOf: [{ const: 'hold', title: '保留' }, { const: 'release', title: '放行' }] } } } }] as DeveloperSchemaModel[];
  const rules = businessRules(atom, schemas, 'zh-TW');
  expect(rules.map((r) => r.title)).toEqual(['更新 庫存', '決定「處理方式」']);
  expect(rules[1]!.body).toContain('數量 小於 7');
  expect(rules[1]!.body).toContain('保留');
  expect(rules[1]!.body).toContain('放行');
  expect(rules[1]!.body).not.toMatch(/主管|新臺幣|核准/);
  expect(businessRules(atom, [], 'zh-TW')[1]!.body).not.toContain('保留');
  expect(businessRules({ ...atom, handler: { kind: 'ref', ref: 'opaque' } }, schemas, 'zh-TW')).toEqual([]);
  decision.children.unshift(n('clause', 'Value', [n('value', 'quantity')]));
  decision.children[1]!.children[0] = n('predicate', 'Condition', [n('value', '7')]);
  expect(businessRules(atom, schemas, 'zh-TW')[1]!.body).toContain('數量 等於 7');
});
