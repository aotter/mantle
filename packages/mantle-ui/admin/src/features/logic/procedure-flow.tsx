import * as React from 'react';
import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
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
  const positions = [[0,0],[300,0],[600,0],[0,150],[300,150],[600,150],[0,330],[300,330]];
  const nodes: Node[] = labels.map((label, i) => ({ id: String(i), position: { x: positions[i]![0]!, y: positions[i]![1]! }, data: { label }, sourcePosition: Position.Right, targetPosition: Position.Left, style: { width: 250, fontSize: 12, whiteSpace: 'pre-line', background: i === 4 ? '#fef3c7' : '#f1f5f9', color: '#172033', borderRadius: 8, padding: 12 } }));
  nodes.push({ id: 'rollback', position: { x: 600, y: 330 }, data: { label: zh ? 'ROLLBACK\n資料庫／前置條件失敗\n不留下部分寫入' : 'ROLLBACK\nDatabase / precondition failed\nNo partial writes' }, style: { width: 250, fontSize: 12, whiteSpace: 'pre-line', background: '#fee2e2', color: '#172033', borderRadius: 8 } });
  const edges: Edge[] = labels.slice(1).map((_, i) => ({ id: `${i}-${i+1}`, source: String(i), target: String(i+1), type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } }));
  edges.push({ id: 'failure', source: '4', target: 'rollback', label: zh ? '交易失敗' : 'Transaction fails', type: 'smoothstep', style: { stroke: '#dc2626' }, markerEnd: { type: MarkerType.ArrowClosed } });
  return <div className="h-[430px] rounded border bg-slate-50" role="img" aria-label={labels.join(' → ')}><ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} colorMode="light"><Background /><Controls showInteractive={false} /></ReactFlow></div>;
}

function CaseFlow({ field, branches, otherwise, zh }: Statements[number]['cases'][number] & { zh: boolean }): React.ReactElement {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const node = (id: string, label: string, x: number, y: number, color: string) => nodes.push({ id, position: { x, y }, data: { label }, sourcePosition: Position.Bottom, targetPosition: Position.Top, style: { width: 250, borderRadius: 8, fontSize: 12, background: color, color: '#172033', border: '1px solid #94a3b8', padding: 14 } });
  const edge = (source: string, target: string, label?: string) => edges.push({ id: `${source}-${target}`, source, target, label, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } });
  branches.forEach((b, i) => {
    node(`when-${i}`, b.condition, 0, i * 140, '#fef3c7');
    node(`value-${i}`, `${field} = ${b.value}`, 340, i * 140, '#dcfce7');
    edge(`when-${i}`, `value-${i}`, 'TRUE');
    edge(`when-${i}`, i + 1 < branches.length ? `when-${i + 1}` : 'otherwise', 'FALSE / NULL');
    edge(`value-${i}`, 'assign');
  });
  node('otherwise', `${field} = ${otherwise}`, 0, branches.length * 140, '#e0f2fe');
  node('assign', zh ? `將選出的值寫入 ${field}` : `Assign selected value to ${field}`, 340, (branches.length + 1) * 140, '#f1f5f9');
  edge('otherwise', 'assign');
  return <div className="mt-3 h-[380px] rounded border bg-slate-50" role="img" aria-label={`CASE ${field}: ${branches.map((b) => `${b.condition} → ${b.value}`).join('; ')}; ELSE ${otherwise}`}>
    <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} minZoom={0.2} maxZoom={1.5} colorMode="light"><Background /><Controls showInteractive={false} /></ReactFlow>
  </div>;
}


function SqlSyntaxFlow({ tree, zh }: { tree: SqlLogicNode; zh: boolean }): React.ReactElement {
  const [selected, setSelected] = React.useState(tree.label);
  const { nodes, edges } = React.useMemo(() => {
    const nodes: Node[] = [], edges: Edge[] = [];
    let leaf = 0;
    const visit = (item: SqlLogicNode, depth: number, parent?: string): number => {
      const id = String(nodes.length);
      const current: Node = { id, position: { x: depth * 270, y: 0 }, data: { label: item.label }, sourcePosition: Position.Right, targetPosition: Position.Left, style: { width: 230, fontSize: 12, whiteSpace: 'pre-wrap', background: item.kind === 'predicate' || item.kind === 'case' ? '#fef3c7' : item.kind === 'opaque' ? '#fee2e2' : '#f1f5f9', color: '#172033', borderRadius: 8 } };
      nodes.push(current);
      if (parent) edges.push({ id: `${parent}-${id}`, source: parent, target: id, type: 'smoothstep' });
      const ys = item.children.map((child) => visit(child, depth + 1, id));
      const y = ys.length ? (ys[0]! + ys[ys.length - 1]!) / 2 : leaf++ * 95;
      current.position.y = y;
      return y;
    };
    visit(tree, 0);
    return { nodes, edges };
  }, [tree]);
  return <div className="mt-3 space-y-2">
    <p className="text-xs text-muted-foreground">{zh ? 'SQL 結構與條件圖：線表示語法／資料依賴，不代表求值順序。AND／OR 遵循 SQL 三值邏輯；點選節點可讀完整文字。' : 'SQL structure and predicates: edges are syntax/data dependencies, not evaluation order. AND/OR use SQL three-valued logic. Select a node to read its label.'}</p>
    <div className="h-[500px] rounded border bg-slate-50" role="img" aria-label={`${tree.label}: SQL syntax and data dependencies`}>
      <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} nodesConnectable={false} minZoom={0.05} maxZoom={2} colorMode="light" onNodeClick={(_event, node) => setSelected(String(node.data.label))}><Background /><Controls showInteractive={false} /></ReactFlow>
    </div>
    <Dialog>
      <DialogTrigger asChild><Button variant="outline" size="sm">{zh ? '放大 SQL 條件圖' : 'Expand SQL graph'}</Button></DialogTrigger>
      <DialogContent className="flex h-[90vh] w-[95vw] max-w-none sm:max-w-none flex-col" closeLabel={zh ? '關閉' : 'Close'}>
        <DialogTitle>{zh ? 'SQL 結構與條件圖' : 'SQL structure and predicates'}</DialogTitle>
        <DialogDescription>{zh ? '拖曳平移、縮放，或點選節點查看完整文字。線表示語法與資料依賴。' : 'Pan, zoom or select a node. Edges represent syntax and data dependencies.'}</DialogDescription>
        <div className="min-h-0 flex-1"><ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} nodesConnectable={false} minZoom={0.05} maxZoom={2} colorMode="light" onNodeClick={(_event, node) => setSelected(String(node.data.label))}><Background /><Controls showInteractive={false} /></ReactFlow></div>
        <p className="break-words font-mono text-xs" aria-live="polite">{selected}</p>
      </DialogContent>
    </Dialog>
    <p className="break-words rounded border p-2 font-mono text-xs" aria-live="polite">{selected}</p>
  </div>;
}
