import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { SqlLogicNode } from '../../lib/types';

export function sqlCardText(item: SqlLogicNode): string {
  const children = item.children.map(sqlCardText);
  if (!children.length) return item.label;
  if (item.kind === 'expression' && children.length === 2) return `(${children[0]} ${item.label} ${children[1]})`;
  if (item.kind === 'predicate' && /^(AND|OR) ·/.test(item.label)) return `(${children.join(`\n${item.label.split(' ·')[0]} `)})`;
  if (item.kind === 'output') return item.label === 'Output' ? children.join(', ') : `${item.label} = ${children.join(', ')}`;
  return `${item.label}\n${children.join('\n')}`;
}

/** Fold operands into cards. Keep the complete AST for inspection and explicit expansion. */
export function sqlFlowLayout(tree: SqlLogicNode, expanded: ReadonlySet<string> = new Set()): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [], edges: Edge[] = [];
  const add = (item: SqlLogicNode, id: string, parent?: string) => {
    nodes.push({ id, type: 'sqlCard', position: { x: 0, y: 0 }, data: { label: item.label, body: id === 'root' ? item.children.map((c) => c.label).join(' · ') : item.children.map(sqlCardText).join('\n'), kind: item.kind, tree: item } });
    if (parent) edges.push({ id: `${parent}-${id}`, source: parent, target: id, type: 'default', label: item.kind === 'when' ? item.label : item.label === 'ELSE' ? 'ELSE' : undefined });
    if (id === 'root' || expanded.has(id) || item.kind === 'case') {
      item.children.forEach((child, i) => { if (id !== 'root' || child.kind !== 'target') add(child, `${id}.${i}`, id); });
    } else {
      const cases = (child: SqlLogicNode, path: string) => {
        if (child.kind === 'case') add(child, path, id);
        else child.children.forEach((c, i) => cases(c, `${path}.${i}`));
      };
      item.children.forEach((child, i) => cases(child, `${id}.${i}`));
    }
  };
  const target = tree.children.find((c) => c.kind === 'target');
  add({ ...tree, label: `${tree.label}${target?.children[0] ? ` ${sqlCardText(target.children[0])}` : ''}` }, 'root');
  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 100 });
  nodes.forEach((n) => layout.setNode(n.id, { width: 240, height: 156 }));
  edges.forEach((e) => layout.setEdge(e.source, e.target));
  dagre.layout(layout);
  nodes.forEach((n) => { const p = layout.node(n.id); n.position = { x: p.x - 120, y: p.y - 78 }; });
  for (const node of nodes.filter((n) => n.data.kind === 'case')) {
    const outputs = edges.filter((e) => e.source === node.id);
    node.data.outputs = outputs.map((e) => ({ id: e.target, label: e.label ?? '' }));
    outputs.forEach((e) => { e.sourceHandle = e.target; });
    // Keep folded WHEN cards above ELSE; expanded subtrees retain Dagre's collision-free layout.
    if (outputs.every((e) => !edges.some((child) => child.source === e.target))) {
      const branches = outputs.map((e) => nodes.find((n) => n.id === e.target)!);
      const ys = branches.map((n) => n.position.y).sort((a, b) => a - b);
      branches.forEach((n, i) => { n.position.y = ys[i]!; });
    }
  }
  return { nodes, edges };
}
