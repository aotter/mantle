import { expect, it } from 'vitest';
import { sqlCardText, sqlFlowLayout } from './sql-flow-layout';
import type { SqlLogicNode } from '../../lib/types';

it('folds operands, preserves nested boolean groups and CASE order, and expands on demand without duplicate nodes', () => {
  const n = (kind: string, label: string, children: SqlLogicNode[] = []): SqlLogicNode => ({ kind, label, children });
  const boolean = n('predicate', 'AND · all conditions', [n('value', 'a'), n('predicate', 'OR · any condition', [n('value', 'b'), n('value', 'c')])]);
  expect(sqlCardText(boolean)).toBe('(a\nAND (b\nOR c))');
  const tree = n('statement', 'UPDATE', [n('target', 'Target', [n('table', 'requests')]), n('clause', 'SET', [n('output', 'state', [n('case', 'CASE · first TRUE condition', [n('when', 'WHEN 1', [n('value', 'a')]), n('value', 'ELSE', [n('value', 'NULL')])])])]), n('clause', 'WHERE', [boolean])]);
  const folded = sqlFlowLayout(tree);
  expect(folded.nodes).toHaveLength(6);
  expect(folded.nodes[0]!.data.label).toBe('UPDATE requests');
  expect(folded.edges.filter((e) => e.label).map((e) => e.label)).toEqual(['WHEN 1', 'ELSE']);
  const when = folded.nodes.find((n) => n.data.label === 'WHEN 1')!;
  const otherwise = folded.nodes.find((n) => n.data.label === 'ELSE')!;
  expect(when.position.y).toBeLessThan(otherwise.position.y);
  expect(folded.edges.filter((e) => e.label).every((e) => e.sourceHandle === e.target)).toBe(true);
  const expanded = sqlFlowLayout(tree, new Set(['root.2', 'root.1']));
  expect(expanded.nodes.length).toBeGreaterThan(folded.nodes.length);
  expect(new Set(expanded.nodes.map((n) => n.id)).size).toBe(expanded.nodes.length);
  expect(expanded.nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
});
