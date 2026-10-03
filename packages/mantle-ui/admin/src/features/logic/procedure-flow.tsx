import * as React from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Database, Filter, GitBranch, Braces, CornerDownRight } from 'lucide-react';
import { sqlCardText, sqlFlowLayout } from './sql-flow-layout';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger, Button } from '@aotter/mantle-ui/kit';
import { usePreferences } from '../../app/preferences';
import type { DeveloperProcedureHandler, SqlLogicNode } from '../../lib/types';

type Statements = NonNullable<Extract<DeveloperProcedureHandler, { kind: 'sql' }>['flow']>;

type SqlHandler = Extract<DeveloperProcedureHandler, { kind: 'sql' }>;
export function ProcedureFlow({ statements, hooks = [], authorization, guard }: { statements: Statements; hooks?: SqlHandler['hooks']; authorization: unknown[]; guard: string | null }): React.ReactElement {
  const { language } = usePreferences();
  const zh = language === 'zh-TW' || language === 'zh-CN';
  return <section className="space-y-3" aria-label={zh ? 'SQL 業務規則' : 'SQL business rules'}>
    <h2 className="text-sm font-medium">{zh ? 'SQL 業務規則 · 同一原子交易' : 'SQL business rules · one atomic transaction'}</h2>
    <p className="text-xs text-muted-foreground">{zh ? '依編譯後 AST 呈現。CASE 依順序選擇欄位值；WHERE 篩選資料列。圖中沒有實際執行紀錄。' : 'Derived from compiled AST. CASE selects field values in order; WHERE filters rows. This is not an execution trace.'}</p>
    <ExecutionFlow statements={statements} hooks={hooks} authorization={authorization} guard={guard} zh={zh} />
    {statements.map((statement) => <div key={statement.index} className="rounded-lg border bg-card p-3">
      <h3 className="font-mono text-xs font-semibold">{statement.index + 1}. {statement.operation} {statement.table}</h3>
      {statement.filter ? <p className="mt-2 break-words font-mono text-xs text-muted-foreground">WHERE {statement.filter}</p> : null}
      <p className="mt-2 text-xs text-muted-foreground">{zh ? '讀取依賴' : 'Reads'}: {statement.reads.join(', ') || '—'} · {zh ? '寫入' : 'Writes'}: {statement.writes.join(', ') || '—'}</p>
      <p className="mt-2 text-xs">{statement.mode === 'row' ? (zh ? '單筆操作：影響筆數必須為 1，否則整批回滾。' : 'Row operation: exactly one affected row, otherwise the batch rolls back.') : statement.mode === 'set' ? (zh ? '集合操作：零筆符合是正常結果，後續 SQL 仍繼續。' : 'Set operation: zero affected rows is a valid result; later SQL still runs.') : (zh ? '讀取結果' : 'Read result')}</p>
      {statement.returns.length ? <p className="mt-2 font-mono text-xs">RETURNING {statement.returns.join(', ')}</p> : null}
      {statement.logic ? <SqlSyntaxFlow tree={statement.logic} zh={zh} /> : null}
      {statement.cases.map((c, caseIndex) => <CaseFlow key={caseIndex} field={c.field} branches={c.branches} otherwise={c.otherwise} zh={zh} />)}
    </div>)}
  </section>;
}

function ExecutionFlow({ statements, hooks = [], authorization, guard, zh }: { statements: Statements; hooks?: SqlHandler['hooks']; authorization: unknown[]; guard: string | null; zh: boolean }): React.ReactElement {
  const before = hooks.filter((h) => h.on.some((on) => on.startsWith('before_'))).map((h) => h.procedure);
  const after = hooks.filter((h) => h.on.some((on) => on.startsWith('after_'))).map((h) => h.procedure);
  const labels = [
    zh ? `授權檢查\n${authorization.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(', ') || '無額外條件'}` : `Authorize\n${JSON.stringify(authorization)}`,
    zh ? '輸入驗證／補預設值' : 'Validate input / defaults',
    guard ? `Guard: ${guard}` : (zh ? '無 Guard' : 'No guard'),
    zh ? `Before hooks\n${before.join(', ') || '無'}\n拒絕時不寫入` : `Before hooks\n${before.join(', ') || 'none'}\nFail closed`,
    (zh ? '原子 SQL 批次\n' : 'Atomic SQL batch\n') + statements.map((s) => `${s.index + 1}. ${s.operation} ${s.table ?? ''}`).join('\n'),
    zh ? 'COMMIT\n全部寫入成功' : 'COMMIT\nAll writes succeeded',
    zh ? `After hooks\n${after.join(', ') || '無'}\n失敗不撤銷已提交資料` : `After hooks\n${after.join(', ') || 'none'}\nBest effort after commit`,
    zh ? '輸出驗證／回應\n驗證失敗不回滾提交' : 'Validate output / respond\nFailure does not roll back commit',
  ];
  const positions = [[0,0],[340,0],[680,0],[0,210],[340,210],[680,210],[0,420],[340,420]];
  const nodes: Node[] = labels.map((label, i) => ({ id: String(i), position: { x: positions[i]![0]!, y: positions[i]![1]! }, data: { label }, sourcePosition: Position.Right, targetPosition: Position.Left, style: { width: 250, fontSize: 12, whiteSpace: 'pre-line', background: i === 4 ? '#fef3c7' : '#f1f5f9', color: '#172033', borderRadius: 8, padding: 12 } }));
  nodes.push({ id: 'rollback', position: { x: 680, y: 420 }, data: { label: zh ? 'ROLLBACK\n資料庫／前置條件失敗\n不留下部分寫入' : 'ROLLBACK\nDatabase / precondition failed\nNo partial writes' }, style: { width: 250, fontSize: 12, whiteSpace: 'pre-line', background: '#fee2e2', color: '#172033', borderRadius: 8 } });
  const edges: Edge[] = labels.slice(1).map((_, i) => ({ id: `${i}-${i+1}`, source: String(i), target: String(i+1), type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } }));
  edges.push({ id: 'failure', source: '4', target: 'rollback', label: zh ? '交易失敗' : 'Transaction fails', type: 'smoothstep', style: { stroke: '#dc2626' }, markerEnd: { type: MarkerType.ArrowClosed } });
  nodes.forEach((n) => { const label = String(n.data.label); n.type = 'sqlCard'; n.data = { label: label.split('\n')[0], body: label.split('\n').slice(1).join('\n'), kind: n.id === 'rollback' ? 'predicate' : 'statement' }; n.style = undefined; });
  return <div className="h-[460px] rounded border bg-muted/30" role="img" aria-label={labels.join(' → ')}><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} defaultEdgeOptions={edgeOptions} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} colorMode="system"><Background /><Controls showInteractive={false} /></ReactFlow></div>;
}

function CaseFlow({ field, branches, otherwise, zh }: Statements[number]['cases'][number] & { zh: boolean }): React.ReactElement {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const node = (id: string, label: string, x: number, y: number, color: string) => nodes.push({ id, position: { x, y }, data: { label }, sourcePosition: Position.Bottom, targetPosition: Position.Top, style: { width: 250, borderRadius: 8, fontSize: 12, background: color, color: '#172033', border: '1px solid #94a3b8', padding: 14 } });
  const edge = (source: string, target: string, label?: string) => edges.push({ id: `${source}-${target}`, source, target, label, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } });
  branches.forEach((b, i) => {
    node(`when-${i}`, b.condition, 0, i * 200, '#fef3c7');
    node(`value-${i}`, `${field} = ${b.value}`, 340, i * 200, '#dcfce7');
    edge(`when-${i}`, `value-${i}`, 'TRUE');
    edge(`when-${i}`, i + 1 < branches.length ? `when-${i + 1}` : 'otherwise', 'FALSE / NULL');
    edge(`value-${i}`, 'assign');
  });
  node('otherwise', `${field} = ${otherwise}`, 0, branches.length * 200, '#e0f2fe');
  node('assign', zh ? `將選出的值寫入 ${field}` : `Assign selected value to ${field}`, 340, (branches.length + 1) * 200, '#f1f5f9');
  edge('otherwise', 'assign');
  nodes.forEach((n) => { n.type = 'sqlCard'; n.data = { label: n.id.startsWith('when-') ? 'CASE · WHEN' : n.id === 'otherwise' ? 'ELSE' : n.id === 'assign' ? 'SET' : 'THEN', body: n.data.label, kind: n.id.startsWith('when-') ? 'case' : 'value' }; n.style = undefined; });
  return <div className="mt-3 h-[440px] rounded border bg-muted/30" role="img" aria-label={`CASE ${field}: ${branches.map((b) => `${b.condition} → ${b.value}`).join('; ')}; ELSE ${otherwise}`}>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} defaultEdgeOptions={edgeOptions} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} minZoom={0.2} maxZoom={1.5} colorMode="system"><Background /><Controls showInteractive={false} /></ReactFlow>
  </div>;
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
