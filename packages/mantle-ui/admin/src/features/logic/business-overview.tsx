import * as React from 'react';
import dagre from '@dagrejs/dagre';
import { Workflow } from 'lucide-react';
import { Handle, MarkerType, Position, type Node, type NodeProps, type Edge } from '@xyflow/react';
import type { DeveloperConsoleSnapshot, DeveloperSchemaModel } from '../../lib/types';
import type { AdminLanguage } from '../../app/preferences';
import { resolveLocalizedText } from '../../lib/localized-text';
import { enumOptions } from '../../../../src/react/values';
import { businessRules } from './business-rules';

type Step = Node<{ title: string; subtitle: string }, 'businessStep'>;
export function BusinessStepNode({ data }: NodeProps<Step>): React.ReactElement {
  return <div className="h-full rounded-xl border-2 bg-card p-3 text-card-foreground shadow-sm">
    <Handle type="target" position={Position.Top} />
    <div className="flex items-start gap-3"><Workflow className="mt-0.5 size-6 shrink-0 text-amber-500" aria-hidden /><div>
      <div className="text-base font-semibold leading-6">{data.title}</div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">{data.subtitle}</div>
    </div></div>
    <Handle type="source" position={Position.Bottom} />
  </div>;
}

/** Only a required enum equality and direct literal assignments prove a possible state handoff.
 * Other predicates, guards and subsequent writes still apply: this is neither execution nor authorization.
 */
export function businessOverview(graph: DeveloperConsoleSnapshot['graph'], schemas: readonly DeveloperSchemaModel[], language: AdminLanguage): { nodes: Node[]; edges: Edge[] } {
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const add = (id: string, title: string, subtitle: string) => nodes.set(id, { id, type: 'businessStep', position: { x: 0, y: 0 }, data: { title, subtitle }, style: { width: 270, height: 112 }, draggable: false, ariaLabel: `${title} ${subtitle}` });
  const steps = graph.atoms.filter((a) => a.kind === 'Procedure').flatMap((atom) => {
    const transitions = businessRules(atom, schemas, language).flatMap((r) => r.transitions ?? []);
    const supported = transitions.filter((t) => atom.handler?.kind === 'sql' && atom.handler.flow?.filter((s) => s.table?.toLowerCase() === t.schema.toLowerCase() && s.logic?.children.find((c) => c.label === 'SET')?.children.some((c) => c.label.toLowerCase() === t.field.toLowerCase())).length === 1);
    return supported.map((transition) => ({ atom, transition }));
  });
  const valueTitle = (t: typeof steps[number]['transition'], value: string) => {
    const schema = schemas.find((s) => s.name === t.schema)!;
    return resolveLocalizedText(enumOptions(schema.schema.properties?.[t.field])?.find((o) => o.value === value)?.title ?? null, language) || value;
  };
  for (const { atom, transition: t } of steps) {
    const description = `${valueTitle(t, t.from)} → ${t.to.map((v) => valueTitle(t, v)).join('／')}`;
    const prior = nodes.get(atom.id);
    add(atom.id, resolveLocalizedText(atom.title, language) || atom.name, prior ? `${prior.data.subtitle}；${description}` : description);
    for (const next of steps) {
      if (next.atom.id === atom.id || next.transition.schema !== t.schema || next.transition.field !== t.field || !t.to.includes(next.transition.from)) continue;
      const id = `StateEdge:${JSON.stringify([atom.id, next.atom.id, t.schema, t.field, next.transition.from])}`;
      if (edges.some((e) => e.id === id)) continue;
      edges.push({ id, source: atom.id, target: next.atom.id, type: 'smoothstep', label: valueTitle(t, next.transition.from), labelStyle: { fill: 'var(--foreground)', fontSize: 12 }, labelBgStyle: { fill: 'var(--card)' }, style: { stroke: '#64748b', strokeWidth: 2, strokeDasharray: '5 4' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b' } });
    }
  }
  // Opaque and non-state procedures remain in the procedure picker without invented edges.
  if (!nodes.size) graph.atoms.filter((a) => a.kind === 'Procedure').forEach((a) => add(a.id, resolveLocalizedText(a.title, language) || a.name, resolveLocalizedText(a.description ?? null, language) || ''));
  const dag = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  dag.setGraph({ rankdir: 'TB', ranksep: 40, nodesep: 32 });
  nodes.forEach((n) => dag.setNode(n.id, { width: 270, height: 112 }));
  edges.forEach((e) => dag.setEdge(e.source, e.target));
  dagre.layout(dag);
  nodes.forEach((n) => { const p = dag.node(n.id); n.position = { x: p.x - 135, y: p.y - 56 }; });
  return { nodes: [...nodes.values()], edges };
}
