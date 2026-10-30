import * as React from 'react';
import { Background, Controls, Handle, Position, ReactFlow, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Database, Filter, GitBranch, Braces, CornerDownRight } from 'lucide-react';
import { sqlCardText, sqlFlowLayout } from './sql-flow-layout';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger, Button } from '@aotter/mantle-ui/kit';
import { usePreferences, type AdminLanguage } from '../../app/preferences';
import { t } from '../../app/i18n';
import type { DeveloperAtom, DeveloperProcedureHandler, DeveloperSchemaModel, SqlLogicNode } from '../../lib/types';
import { ProcedureLogicPreview } from './procedure-logic-preview';

type Statements = NonNullable<Extract<DeveloperProcedureHandler, { kind: 'sql' }>['flow']>;

type SqlHandler = Extract<DeveloperProcedureHandler, { kind: 'sql' }>;

/** The Procedure page: the steps that actually exist, the shared logic graph (#1892) and, folded, the SQL syntax trees. */
export function ProcedureFlow({ atom, schemas, statements, hooks = [], authorization, guard }: { atom: DeveloperAtom; schemas: readonly DeveloperSchemaModel[]; statements: Statements; hooks?: SqlHandler['hooks']; authorization: unknown[]; guard: string | null }): React.ReactElement {
  const { language } = usePreferences();
  const say = (key: Parameters<typeof t>[1], vars?: Record<string, string>) => t(language, key, vars);
  const labeled = (label: string, value: string) => say('developer.logic.labeled', { label, value });
  const before = hooks.filter((h) => h.on.some((on) => on.startsWith('before_'))).map((h) => h.procedure);
  const after = hooks.filter((h) => h.on.some((on) => on.startsWith('after_'))).map((h) => h.procedure);
  const steps = [
    authorization.length ? labeled(say('developer.logic.authorize'), authorization.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(', ')) : say('developer.logic.authorize'),
    ...(guard ? [labeled('Guard', guard)] : []),
    ...(before.length ? [labeled(say('developer.logic.beforeHooks'), before.join(', '))] : []),
    say('developer.logic.statements', { count: String(statements.length) }),
    say('developer.logic.commitOrRollback'),
    ...(after.length ? [labeled(say('developer.logic.afterHooks'), after.join(', '))] : []),
  ];
  return <section className="space-y-3" aria-label={say('developer.logic.rules')}>
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label={say('developer.logic.steps')}>
      {steps.map((step, index) => <li key={step} className="flex items-center gap-1.5">{index ? <span className="text-muted-foreground" aria-hidden>→</span> : null}<span className="rounded-md border bg-muted/40 px-2 py-1 font-mono">{step}</span></li>)}
    </ol>
    <ProcedureLogicPreview atom={atom} schemas={schemas} density="full" />
    {statements.some((statement) => statement.logic) ? <details className="rounded-lg border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{say('developer.logic.ast')}</summary>
      <div className="space-y-3 border-t p-3">
        {statements.map((statement) => statement.logic ? <div key={statement.index}>
          <h3 className="font-mono text-xs font-semibold">{statement.index + 1}. {statement.operation} {statement.table}</h3>
          <SqlSyntaxFlow tree={statement.logic} language={language} />
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

function SqlSyntaxFlow({ tree, language }: { tree: SqlLogicNode; language: AdminLanguage }): React.ReactElement {
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
    {detail.children.length && selected.id !== 'root' && detail.kind !== 'case' ? <Button variant="outline" size="sm" className="mt-4" onClick={() => setExpanded((previous) => { const next = new Set(previous); if (next.has(selected.id)) next.delete(selected.id); else next.add(selected.id); return next; })}>{t(language, expanded.has(selected.id) ? 'developer.logic.ast.collapseChildren' : 'developer.logic.ast.expandChildren')}</Button> : null}
  </aside>;
  return <div className="mt-4 overflow-hidden rounded-xl border bg-muted/30">
    <div className="flex items-center justify-between gap-3 border-b bg-card px-4 py-3"><div><p className="text-sm font-semibold">{t(language, 'developer.logic.ast.title')}</p><p className="mt-1 text-xs text-muted-foreground">{t(language, 'developer.logic.ast.hint')}</p></div>
      <Dialog><DialogTrigger asChild><Button variant="outline" size="sm">{t(language, 'developer.logic.ast.expand')}</Button></DialogTrigger>
        <DialogContent className="flex h-[90vh] w-[95vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none" closeLabel={t(language, 'common.close')}>
          <div className="border-b px-6 py-4"><DialogTitle>{t(language, 'developer.logic.ast.title')}</DialogTitle><DialogDescription className="mt-1">{t(language, 'developer.logic.ast.dialogHint')}</DialogDescription></div>
          <div className="flex min-h-0 flex-1 flex-col md:flex-row"><div className="min-h-[180px] min-w-0 flex-1 bg-muted/30">{canvas}</div>{inspector}</div>
        </DialogContent>
      </Dialog>
    </div>
    <div className="h-[480px]" role="img" aria-label={t(language, "developer.logic.labeled", { label: tree.label, value: t(language, "developer.logic.ast.title") })}>{canvas}</div>
    <div className="border-t bg-card px-4 py-3"><span className="text-xs font-medium">{detail.label}</span><p className="mt-1 line-clamp-2 whitespace-pre-wrap font-mono text-xs text-muted-foreground" aria-live="polite">{sqlCardText(detail)}</p></div>
  </div>;
}
