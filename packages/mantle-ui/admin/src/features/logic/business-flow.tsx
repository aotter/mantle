import * as React from "react";
import dagre from "@dagrejs/dagre";
import { Database, GitBranch, Pencil, Workflow } from "lucide-react";
import { Handle, MarkerType, Position, type Edge, type Node, type NodeProps } from "@xyflow/react";
import type { BusinessRule } from "./business-rules";

type RuleData = { title: string; subtitle: string; kind: 'operation' | 'condition' | 'result'; zh: boolean; rule: BusinessRule };
type RuleNode = Node<RuleData, 'businessRule'>;
type GroupNode = Node<{ title: string; count: number; zh: boolean }, 'businessGroup'>;
const width = 184;
const height = 152;

export function BusinessRuleNode({ data }: NodeProps<RuleNode>): React.ReactElement {
  const Icon = data.kind === 'condition' ? GitBranch : data.kind === 'result' ? Pencil : Database;
  const tone = data.kind === 'condition' ? 'border-amber-400/70 bg-amber-500/10 text-amber-600 dark:text-amber-300' : data.kind === 'result' ? 'border-emerald-400/60 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : 'border-blue-400/60 bg-blue-500/10 text-blue-600 dark:text-blue-300';
  return <div className="group h-full text-center text-card-foreground">
    <Handle type="target" position={Position.Left} style={{ left: 60, top: 32 }} className="!size-2.5 !border-background !bg-muted-foreground" />
    <div className={`mx-auto flex size-16 items-center justify-center rounded-xl border-2 bg-card shadow-sm group-hover:ring-2 group-hover:ring-ring/40 ${tone}`}><Icon size={30} aria-hidden /></div>
    <div className="mt-2 line-clamp-3 text-[16px] font-semibold leading-5" title={data.title}>{data.title}</div>
    <div className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">{data.subtitle}</div>
    {data.kind === 'condition' ? <>
      <Handle id="yes" type="source" position={Position.Right} style={{ right: 60, top: 18 }} className="!size-2.5 !border-background !bg-emerald-500" />
      <Handle id="no" type="source" position={Position.Right} style={{ right: 60, top: 46 }} className="!size-2.5 !border-background !bg-amber-500" />
    </> : <Handle type="source" position={Position.Right} style={{ right: 60, top: 32 }} className="!size-2.5 !border-background !bg-muted-foreground" />}
  </div>;
}

export function BusinessGroupNode({ data }: NodeProps<GroupNode>): React.ReactElement {
  return <section className="h-full rounded-2xl border border-border bg-card/60 text-card-foreground">
    <Handle type="target" position={Position.Top} className="!opacity-0" />
    <header className="flex h-[76px] items-center gap-3 border-b border-border px-5">
      <Workflow className="size-6 text-amber-500" aria-hidden />
      <div><h2 className="text-lg font-semibold">{data.title}</h2><p className="mt-1 text-xs text-muted-foreground">{data.zh ? `${data.count} 項資料操作 · 同一交易，全部成功才提交` : `${data.count} operations · one transaction`}</p></div>
      <div className="ml-auto flex flex-col gap-1 text-xs text-muted-foreground"><span>{data.zh ? '實線 → 操作順序' : 'Solid → statement order'}</span><span>{data.zh ? '虛線 ⇢ 欄位值選擇' : 'Dashed → value choice'}</span></div>
    </header>
    <Handle type="source" position={Position.Bottom} className="!opacity-0" />
  </section>;
}

/** CASE edges select a value for their statement; only statement edges describe operation order. */
export function businessFlow(owner: string, title: string, rules: BusinessRule[], zh: boolean): { group: Node; nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const operations = rules.filter((r) => r.kind === 'operation');
  const add = (id: string, kind: RuleData['kind'], title: string, subtitle: string, rule: BusinessRule) => {
    nodes.push({ id, type: 'businessRule', parentId: owner, extent: 'parent', position: { x: 0, y: 0 }, data: { kind, title, subtitle, zh, rule }, style: { width, height }, draggable: false, ariaLabel: title });
  };
  const link = (source: string, target: string, value: boolean, label?: string, handle?: string) => edges.push({ id: `RuleEdge:${source}:${target}`, source, target, sourceHandle: handle, type: 'smoothstep', label, labelStyle: { fontSize: 12, fontWeight: 600, fill: 'var(--foreground)' }, labelBgStyle: { fill: 'var(--card)' }, labelBgPadding: [6, 4], labelBgBorderRadius: 5, style: { stroke: handle === 'yes' ? '#10b981' : handle === 'no' ? '#d97706' : value ? '#10b981' : '#64748b', strokeWidth: 1.8, ...(value ? { strokeDasharray: '5 4' } : {}) }, markerEnd: { type: MarkerType.ArrowClosed, color: handle === 'yes' ? '#10b981' : handle === 'no' ? '#d97706' : value ? '#10b981' : '#64748b', width: 14, height: 14 } });
  operations.forEach((op, i) => {
    const id = `Rule:${owner}:operation:${op.statement}`;
    add(id, 'operation', op.title, op.summary || (zh ? '點選查看資料來源與條件' : 'Select for sources and conditions'), op);
    if (i) link(`Rule:${owner}:operation:${operations[i - 1]!.statement}`, id, false, zh ? '接著' : 'Next');
    rules.filter((r) => r.kind === 'case' && r.statement === op.statement).forEach((rule, ci) => {
      const prefix = `Rule:${owner}:case:${op.statement}:${ci}`;
      const branches = rule.branches ?? [];
      branches.forEach((branch, bi) => {
        const condition = `${prefix}:condition:${bi}`;
        const result = `${prefix}:result:${bi}`;
        add(condition, 'condition', branch.condition, rule.field ?? rule.title, rule);
        add(result, 'result', branch.value, rule.field ?? '', rule);
        link(condition, result, true, zh ? '成立' : 'True', 'yes');
        link(condition, bi + 1 < branches.length ? `${prefix}:condition:${bi + 1}` : `${prefix}:otherwise`, true, zh ? '未成立／未知' : 'False / unknown', 'no');
        link(result, id, true);
      });
      add(`${prefix}:otherwise`, 'result', rule.otherwise ?? (zh ? '空值' : 'Empty value'), rule.field ?? '', rule);
      link(`${prefix}:otherwise`, id, true);
    });
  });
  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: 'LR', ranksep: 60, nodesep: 64, marginx: 28, marginy: 28 });
  nodes.forEach((n) => layout.setNode(n.id, { width, height }));
  edges.forEach((e) => layout.setEdge(e.source, e.target));
  dagre.layout(layout);
  nodes.forEach((n) => { const p = layout.node(n.id); n.position = { x: p.x - width / 2, y: p.y - height / 2 + 76 }; });
  // Keep n8n's familiar TRUE-above / otherwise-below reading order for a two-way choice.
  edges.filter((e) => e.sourceHandle === 'yes').forEach((yes) => {
    const no = edges.find((e) => e.source === yes.source && e.sourceHandle === 'no');
    const a = nodes.find((n) => n.id === yes.target);
    const b = nodes.find((n) => n.id === no?.target);
    if (a && b && a.position.x === b.position.x && a.position.y > b.position.y) [a.position.y, b.position.y] = [b.position.y, a.position.y];
  });
  const size = layout.graph();
  return { group: { id: owner, type: 'businessGroup', position: { x: 0, y: 0 }, style: { width: size.width, height: size.height + 76 }, data: { title, count: operations.length, zh }, selectable: false, draggable: false, focusable: false }, nodes, edges };
}
