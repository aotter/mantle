import { expect, it } from 'vitest';
import { businessRules } from './business-rules';
import { businessFlow } from './business-flow';
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
  const flow = businessFlow(atom.id, atom.title as string, rules, true);
  expect(flow.nodes.filter((n) => n.data.kind === 'condition').map((n) => n.data.title)).toEqual(['數量 小於 7']);
  expect(flow.nodes.filter((n) => n.data.kind === 'result').map((n) => n.data.title)).toEqual(['保留', '放行']);
  expect(flow.edges.filter((e) => e.sourceHandle === 'no').map((e) => e.label)).toEqual(['未成立／未知']);
  expect(flow.edges.filter((e) => e.target.includes(':operation:')).every((e) => e.style?.strokeDasharray)).toBe(true);
  expect(flow.nodes.every((n) => n.parentId === atom.id)).toBe(true);
  const results = flow.nodes.filter((n) => n.data.kind === 'result');
  expect(results[0]!.position.y).toBeLessThan(results[1]!.position.y);
  const multi = businessFlow(atom.id, '任意規則', [rules[0]!, { ...rules[1]!, branches: [...rules[1]!.branches!, { condition: '數量 等於 9', value: '放行' }] }], true);
  expect(multi.edges.some((e) => e.source.endsWith(':condition:0') && e.sourceHandle === 'no' && e.target.endsWith(':condition:1'))).toBe(true);
  expect(rules[1]!.body).not.toMatch(/主管|新臺幣|核准/);
  expect(businessRules(atom, [], 'zh-TW')[1]!.body).not.toContain('保留');
  expect(businessRules({ ...atom, handler: { kind: 'ref', ref: 'opaque' } }, schemas, 'zh-TW')).toEqual([]);
  schemas[0]!.schema.properties!.quantity!['x-mcp-hint'] = 'money-minor';
  expect(businessRules(atom, schemas, 'zh-TW')[1]!.branches![0]!.condition).toContain('0.07');
  delete schemas[0]!.schema.properties!.quantity!['x-mcp-hint'];
  decision.children.unshift(n('clause', 'Value', [n('value', 'quantity')]));
  decision.children[1]!.children[0] = n('predicate', 'Condition', [n('value', '7')]);
  expect(businessRules(atom, schemas, 'zh-TW')[1]!.body).toContain('數量 等於 7');
});

it('renders CASE assigned by INSERT VALUES and INSERT SELECT using positional column names', () => {
  const n = (kind: string, label: string, children: SqlLogicNode[] = []): SqlLogicNode => ({ kind, label, children });
  const decision = n('case', 'CASE · first TRUE condition', [n('when', 'WHEN 1', [n('predicate', 'Condition', [n('expression', '>', [n('value', 'input.totalamount'), n('value', '10000')])]), n('value', 'THEN', [n('value', "'submitted'")])]), n('value', 'ELSE', [n('value', "'approved'")])]);
  const schemas = [{ name: 'requests', title: '請購單', lifecycle: 'operational', localized: false, translates: null, uniqueIndexes: [], indexes: [], searchableFields: [], manifest: {}, schema: { properties: { requestStatus: { type: 'string', title: '審核狀態', oneOf: [{ const: 'submitted', title: '待審核' }, { const: 'approved', title: '已核准' }] } } } }] as DeveloperSchemaModel[];
  const atom: DeveloperAtom = { id: 'Procedure:submit', kind: 'Procedure', name: 'submit', title: '提交', input: { properties: { totalAmount: { type: 'integer', title: '請購金額' } } }, handler: { kind: 'sql', statement: '', flow: [] } };
  for (const source of [n('clause', 'VALUES', [n('list', 'Values', [decision])]), n('clause', 'SELECT', [n('output', 'Output', [decision])])]) {
    const logic = n('statement', 'INSERT', [n('clause', 'Columns', [n('output', 'requeststatus')]), n('clause', 'Source SELECT', [n('statement', 'SELECT', [source])])]);
    const handler = { kind: 'sql' as const, statement: '', flow: [{ index: 0, operation: 'INSERT', table: 'requests', mode: 'row' as const, reads: [], writes: ['requests'], returns: [], filter: null, cases: [], logic }] };
    const rules = businessRules({ ...atom, handler }, schemas, 'zh-TW');
    expect(rules.map(rule => rule.title)).toEqual(['新增 請購單', '決定「審核狀態」']);
    expect(rules[1]!.branches).toEqual([{ condition: '本次輸入「請購金額」 大於 10000', value: '待審核' }]);
    expect(rules[1]!.otherwise).toBe('已核准');
    const flow = businessFlow(atom.id, '提交', rules, true);
    expect(flow.nodes.filter(node => node.data.kind === 'condition')).toHaveLength(1);
    expect(flow.nodes.filter(node => node.data.kind === 'result').map(node => node.data.title)).toEqual(['待審核', '已核准']);
    if (source.label === 'SELECT') {
      const left = decision.children[0]!.children[0]!.children[0]!.children[0]!;
      left.label = 'r.totalamount'; left.column = { name: 'totalamount', relation: 'r' };
      const relation = n('table', 'budget'); relation.relation = { name: 'budget', alias: 'r' };
      logic.children[1]!.children[0]!.children.push(n('clause', 'FROM', [relation]));
      const sourceModel = { ...schemas[0]!, name: 'budget', title: '預算', schema: { properties: { totalAmount: { type: 'integer', title: '來源金額' } } } };
      expect(businessRules({ ...atom, handler }, [...schemas, sourceModel], 'zh-TW')[1]!.branches![0]!.condition).toBe('預算 · 來源金額 大於 10000');
    }
    logic.children[0]!.children.push(n('output', 'unmatched'));
    expect(businessRules({ ...atom, handler }, schemas, 'zh-TW')).toHaveLength(1);
  }
});
