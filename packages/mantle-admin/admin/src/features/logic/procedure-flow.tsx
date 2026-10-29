import * as React from 'react';
import { Background, Controls, Handle, Position, ReactFlow, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Database, Filter, GitBranch, Braces, CornerDownRight } from 'lucide-react';
import { sqlCardText, sqlFlowLayout } from './sql-flow-layout';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger, Button } from '@aotter/mantle-ui/kit';
import { usePreferences } from '../../app/preferences';
import type { DeveloperAtom, DeveloperProcedureHandler, DeveloperSchemaModel, SqlLogicNode } from '../../lib/types';
import { ProcedureLogicPreview } from './procedure-logic-preview';

type Statements = NonNullable<Extract<DeveloperProcedureHandler, { kind: 'sql' }>['flow']>;

type SqlHandler = Extract<DeveloperProcedureHandler, { kind: 'sql' }>;

/** The Procedure page: the steps that actually exist, the shared logic graph (#1892) and, folded, the SQL syntax trees. */
export function ProcedureFlow({ atom, schemas, statements, hooks = [], authorization, guard }: { atom: DeveloperAtom; schemas: readonly DeveloperSchemaModel[]; statements: Statements; hooks?: SqlHandler['hooks']; authorization: unknown[]; guard: string | null }): React.ReactElement {
  const { language } = usePreferences();
  const zh = language === 'zh-TW' || language === 'zh-CN';
  const before = hooks.filter((h) => h.on.some((on) => on.startsWith('before_'))).map((h) => h.procedure);
  const after = hooks.filter((h) => h.on.some((on) => on.startsWith('after_'))).map((h) => h.procedure);
  const steps = [
    `${zh ? '授權' : 'Authorize'}${authorization.length ? `：${authorization.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(', ')}` : ''}`,
    ...(guard ? [`Guard：${guard}`] : []),
    ...(before.length ? [`${zh ? '前置 hook' : 'Before hooks'}：${before.join(', ')}`] : []),
    zh ? `${statements.length} 段 SQL · 同一交易` : `${statements.length} SQL statements · one transaction`,
    zh ? 'COMMIT 或整批 ROLLBACK' : 'COMMIT, or ROLLBACK of the whole batch',
    ...(after.length ? [`${zh ? '提交後 hook' : 'After hooks'}：${after.join(', ')}`] : []),
  ];
  return <section className="space-y-3" aria-label={zh ? 'SQL 業務規則' : 'SQL business rules'}>
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label={zh ? '執行步驟' : 'Execution steps'}>
      {steps.map((step, index) => <li key={step} className="flex items-center gap-1.5">{index ? <span className="text-muted-foreground" aria-hidden>→</span> : null}<span className="rounded-md border bg-muted/40 px-2 py-1 font-mono">{step}</span></li>)}
    </ol>
    <ProcedureLogicPreview atom={atom} schemas={schemas} density="full" />
    {statements.some((statement) => statement.logic) ? <details className="rounded-lg border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{zh ? '進階：SQL 語法樹' : 'Advanced: SQL syntax trees'}</summary>
      <div className="space-y-3 border-t p-3">
        {statements.map((statement) => statement.logic ? <div key={statement.index}>
          <h3 className="font-mono text-xs font-semibold">{statement.index + 1}. {statement.operation} {statement.table}</h3>
          <SqlSyntaxFlow tree={statement.logic} zh={zh} />
        </div> : null)}
      </div>
    </details> : null}
  </section>;
}

function SqlCard({ data, selected }: NodeProps): React.ReactElement {
  const kind = String(data.kind ?? 'statement');
  const decision = kind === 'case' || kind === 'predicate' || String(data.label).startsWith('WHERE');
  const Icon = kind === 'statement' ? Database : decision ? GitBranch : kind === 'when' || kind === 'value' ? CornerDownRight : kind === 'clause' ? Filter : Braces;
  const outputs = data.outputs as { id: string; label: string }[] | undefined;
  return <div className={`relative h-[156px] w-[240px] rounded-2xl border-2 bg-card text-card-foreground shadow-sm ${selected ? 'border-orange-500 shadow-lg ring-4 ring-orange-500/10' : 'border-border'}`}>
    <Handle type="target" position={Position.Left} style={{ width: 12, height: 12, background: 'var(--card)', border: '2px solid #94a3b8' }} />
    <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${decision ? 'bg-orange-500/10 text-orange-600' : 'bg-indigo-500/10 text-indigo-500'}`}><Icon size={19} /></span>
      <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{kind}</p><p className="truncate text-sm font-semibold" title={String(data.label)}>{String(data.label)}</p></div>
    </div>
    <p className="line-clamp-4 whitespace-pre-wrap break-words px-4 pt-3 font-mono text-[11px] leading-[17px] text-muted-foreground">{String(data.body ?? '') || '—'}</p>
    {(outputs?.length ? outputs : [{ id: undefined, label: "" }]).map((port, i, ports) => <Handle key={port.id ?? "output"} id={port.id} type="source" position={Position.Right} title={port.label} style={{ top: `${(i + 1) * 100 / (ports.length + 1)}%`, width: 12, height: 12, background: decision ? '#f97316' : '#64748b', border: '2px solid var(--card)' }} />)}
  </div>;
}
const nodeTypes = { sqlCard: SqlCard };
const edgeOptions = { style: { stroke: '#94a3b8', strokeWidth: 2 }, labelStyle: { fontSize: 11, fill: '#64748b' }, labelBgPadding: [8, 4] as [number, number], labelBgBorderRadius: 6 };

function SqlSyntaxFlow({ tree, zh }: { tree: SqlLogicNode; zh: boolean }): React.ReactElement {
  const [selectedId, setSelectedId] = React.useState('root');
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const { resolvedTheme } = usePreferences();
  const { nodes, edges } = React.useMemo(() => sqlFlowLayout(tree, expanded), [tree, expanded]);
  const selected = nodes.find((n) => n.id === selectedId) ?? nodes[0]!;
  const detail = selected.data.tree as SqlLogicNode;
  const canvas = <ReactFlow nodes={nodes.map((n) => ({ ...n, selected: n.id === selected.id }))} edges={edges} nodeTypes={nodeTypes} defaultEdgeOptions={edgeOptions} fitView fitViewOptions={{ padding: 0.18, maxZoom: 1 }} nodesDraggable={false} nodesConnectable={false} minZoom={0.15} maxZoom={1.8} deleteKeyCode={null} colorMode={resolvedTheme} onNodeClick={(_event, node) => setSelectedId(node.id)}><Background gap={24} size={1} /><Controls showInteractive={false} /></ReactFlow>;
  const inspector = <aside className="max-h-[35vh] w-full shrink-0 overflow-auto border-t bg-card p-4 md:max-h-none md:w-64 md:border-t-0 md:border-l">
    <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-orange-600">SQL · {detail.kind}</p>
    <h4 className="mb-3 text-sm font-semibold">{detail.label}</h4>
    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-muted-foreground" aria-live="polite">{sqlCardText(detail)}</pre>
    {detail.children.length && selected.id !== 'root' && detail.kind !== 'case' ? <Button variant="outline" size="sm" className="mt-4" onClick={() => setExpanded((previous) => { const next = new Set(previous); if (next.has(selected.id)) next.delete(selected.id); else next.add(selected.id); return next; })}>{expanded.has(selected.id) ? (zh ? '收合子節點' : 'Collapse children') : (zh ? '展開子節點' : 'Expand children')}</Button> : null}
  </aside>;
  return <div className="mt-4 overflow-hidden rounded-xl border bg-muted/30">
    <div className="flex items-center justify-between gap-3 border-b bg-card px-4 py-3"><div><p className="text-sm font-semibold">{zh ? 'SQL 規則圖' : 'SQL rule graph'}</p><p className="mt-1 text-xs text-muted-foreground">{zh ? '點選卡片查看條件；線表示語法依賴，AND／OR 保留 SQL 三值邏輯。' : 'Select cards for details. Edges are syntax dependencies; AND/OR retain SQL three-valued logic.'}</p></div>
      <Dialog><DialogTrigger asChild><Button variant="outline" size="sm">{zh ? '放大 SQL 條件圖' : 'Expand SQL graph'}</Button></DialogTrigger>
        <DialogContent className="flex h-[90vh] w-[95vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none" closeLabel={zh ? '關閉' : 'Close'}>
          <div className="border-b px-6 py-4"><DialogTitle>{zh ? 'SQL 規則圖' : 'SQL rule graph'}</DialogTitle><DialogDescription className="mt-1">{zh ? '依編譯後 AST 呈現。拖曳平移、縮放，點選卡片檢視或展開條件。' : 'Compiled AST. Pan, zoom, select cards to inspect or expand conditions.'}</DialogDescription></div>
          <div className="flex min-h-0 flex-1 flex-col md:flex-row"><div className="min-h-[180px] min-w-0 flex-1 bg-muted/30">{canvas}</div>{inspector}</div>
        </DialogContent>
      </Dialog>
    </div>
    <div className="h-[480px]" role="img" aria-label={`${tree.label}: SQL syntax and data dependencies`}>{canvas}</div>
    <div className="border-t bg-card px-4 py-3"><span className="text-xs font-medium">{detail.label}</span><p className="mt-1 line-clamp-2 whitespace-pre-wrap font-mono text-xs text-muted-foreground" aria-live="polite">{sqlCardText(detail)}</p></div>
  </div>;
}
