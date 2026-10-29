import * as React from "react";
import { CircleCheck, CircleX, Database, GitBranch } from "lucide-react";
import { Handle, MarkerType, Position, type Edge, type Node, type NodeProps } from "@xyflow/react";
import type { BusinessRule } from "./business-rules";

// One Procedure-logic graph for the side panel and the Procedure page (#1892): a transaction box with the statements
// in order, one CASE card per CASE with its branches as numbered rows (first match wins, ELSE always shown), and the
// COMMIT and ROLLBACK ends. Branch-row cards follow n8n Switch, Windmill and Step Functions; the double border is BPMN's
// transaction marker.
type StepData = { rule: BusinessRule; zh: boolean; number: number };
type CaseData = { rule: BusinessRule; zh: boolean };
type EndData = { commit: boolean; zh: boolean };
type TxData = { zh: boolean };
export type LogicNode = Node<StepData, "logicStep"> | Node<CaseData, "logicCase"> | Node<EndData, "logicEnd"> | Node<TxData, "logicTx">;

const stepWidth = 280;
const caseWidth = 320;
const gap = 40;
const pad = 20;
const txHeader = 32;
const chip = 20;

function lines(text: string | undefined): string[] {
  return (text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

/** WHERE as short chips: the AND/OR heading becomes the joiner, each condition one chip. */
function conditionChips(rule: BusinessRule): { joiner: string | null; items: string[] } {
  const [first, ...rest] = lines(rule.conditions);
  if (!first) return { joiner: null, items: [] };
  // Only an AND/OR heading from businessRules joins its lines; any other line ending in a colon is part of a condition.
  return /^(全部條件成立|至少一個條件成立|All conditions|Any condition)[:：]$/.test(first) && rest.length ? { joiner: first.replace(/[:：]$/, ""), items: rest } : { joiner: null, items: [[first, ...rest].join(" ")] };
}

function stepHeight(rule: BusinessRule): number {
  const where = Math.min(conditionChips(rule).items.length, 3);
  return 56 + (where ? 16 + where * chip : 0) + (rule.assignments?.length ? 20 : 0) + 28;
}

function caseHeight(rule: BusinessRule): number {
  return 44 + ((rule.branches?.length ?? 0) + 1) * 44 + 22;
}

export function LogicStepNode({ data, selected }: NodeProps<Node<StepData, "logicStep">>): React.ReactElement {
  const { rule, zh, number } = data;
  const { joiner, items } = conditionChips(rule);
  const sets = rule.assignments?.map((line) => line.split(" ← ")[0]).join("、");
  const badge = rule.mode === "row" ? (zh ? "必須剛好 1 筆，否則回滾" : "Exactly one row, else roll back") : rule.mode === "set" ? (zh ? "0 筆以上皆可" : "Zero or more rows") : (zh ? "讀取" : "Read");
  return (
    <div className={`h-full rounded-xl border bg-card text-card-foreground shadow-sm ${selected ? "border-foreground/60 ring-2 ring-ring/40" : "border-border"}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} className="!opacity-0" />
      <Handle id="case" type="target" position={Position.Left} isConnectable={false} className="!opacity-0" />
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-500/15 font-mono text-xs font-semibold text-blue-700 dark:text-blue-300">{number}</span>
        <Database className="size-4 shrink-0 text-blue-600 dark:text-blue-300" aria-hidden />
        <strong className="min-w-0 truncate text-sm" title={rule.title}>{rule.title}</strong>
      </header>
      <div className="space-y-1.5 px-3 py-2 text-xs">
        {items.length ? (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{zh ? "條件" : "Where"}{joiner ? ` · ${joiner}` : ""}</p>
            <ul className="mt-1 space-y-1">{items.slice(0, 3).map((item) => <li key={item} className="truncate rounded bg-muted px-1.5 py-0.5" title={item}>{item}</li>)}{items.length > 3 ? <li className="text-muted-foreground">+{items.length - 3}</li> : null}</ul>
          </div>
        ) : null}
        {sets ? <p className="truncate text-muted-foreground" title={rule.assignments?.join("\n")}>{zh ? "設定" : "Sets"}：{sets}</p> : null}
        <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${rule.mode === "row" ? "bg-rose-500/10 text-rose-700 dark:text-rose-300" : "bg-muted text-muted-foreground"}`}>{badge}</span>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!opacity-0" />
      <Handle id="fail" type="source" position={Position.Right} isConnectable={false} className="!opacity-0" />
    </div>
  );
}

export function LogicCaseNode({ data, selected }: NodeProps<Node<CaseData, "logicCase">>): React.ReactElement {
  const { rule, zh } = data;
  const rows = [...(rule.branches ?? []).map((branch, index) => ({ when: `${index ? (zh ? "否則如果" : "Else if") : (zh ? "如果" : "If")} ${branch.condition}`, value: branch.value })), { when: zh ? "否則" : "Else", value: rule.otherwise ?? (zh ? "空值" : "Empty value") }];
  return (
    <div className={`h-full rounded-xl border bg-card text-card-foreground shadow-sm ${selected ? "border-foreground/60 ring-2 ring-ring/40" : "border-amber-400/60"}`}>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <GitBranch className="size-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
        <strong className="min-w-0 truncate text-sm" title={rule.title}>{rule.title}</strong>
      </header>
      <ol className="text-xs">
        {rows.map((row, index) => (
          <li key={index} className="flex h-[44px] items-center gap-2 border-b px-3 last:border-b-0">
            <span className="w-4 shrink-0 font-mono text-[10px] text-muted-foreground">{index < rows.length - 1 ? index + 1 : "—"}</span>
            <span className="line-clamp-2 min-w-0 flex-1 leading-4" title={row.when}>{row.when}</span>
            <span className="shrink-0 text-muted-foreground">→</span>
            <span className="max-w-[35%] shrink-0 truncate rounded bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-700 dark:text-emerald-300" title={row.value}>{row.value}</span>
          </li>
        ))}
      </ol>
      <p className="px-3 pb-1 text-[10px] text-muted-foreground">{zh ? "依序取第一個成立的；未知（空值）視為不成立" : "First match in order; unknown (NULL) counts as not matched"}</p>
      <Handle type="source" position={Position.Right} isConnectable={false} className="!opacity-0" />
    </div>
  );
}

export function LogicEndNode({ data }: NodeProps<Node<EndData, "logicEnd">>): React.ReactElement {
  const Icon = data.commit ? CircleCheck : CircleX;
  return (
    <div className={`flex h-full items-center gap-2 rounded-full border px-3 text-xs font-semibold ${data.commit ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300"}`}>
      <Handle type="target" position={data.commit ? Position.Top : Position.Left} isConnectable={false} className="!opacity-0" />
      <Icon className="size-4 shrink-0" aria-hidden />
      <span>{data.commit ? (data.zh ? "COMMIT · 全部保存" : "COMMIT · all saved") : (data.zh ? "ROLLBACK · 全部不保存" : "ROLLBACK · nothing saved")}</span>
    </div>
  );
}

export function LogicTxNode({ data }: NodeProps<Node<TxData, "logicTx">>): React.ReactElement {
  return (
    <section className="pointer-events-none h-full rounded-2xl border-[3px] border-double border-slate-400/70 bg-slate-500/[0.03] dark:border-slate-500/70">
      <p className="px-4 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{data.zh ? "同一交易 · 全部成功才保存" : "One transaction · all or nothing"}</p>
    </section>
  );
}

export const logicNodeTypes = { logicStep: LogicStepNode, logicCase: LogicCaseNode, logicEnd: LogicEndNode, logicTx: LogicTxNode };

/** Statements top to bottom inside the transaction box, each CASE to the left of the statement it sets. */
export function businessFlow(owner: string, rules: BusinessRule[], zh: boolean): { nodes: LogicNode[]; edges: Edge[] } {
  const operations = rules.filter((rule) => rule.kind === "operation");
  const cases = rules.filter((rule) => rule.kind === "case");
  const caseColumn = cases.length ? caseWidth + gap : 0;
  const children: LogicNode[] = [];
  const edges: Edge[] = [];
  const edge = (id: string, source: string, target: string, kind: "next" | "value" | "fail", sourceHandle?: string, targetHandle?: string) => {
    const color = kind === "fail" ? "#e11d48" : kind === "value" ? "#d97706" : "#64748b";
    edges.push({ id: `RuleEdge:${id}`, source, target, sourceHandle, targetHandle, type: kind === "next" ? "smoothstep" : "default", style: { stroke: color, strokeWidth: 1.5, ...(kind !== "next" && { strokeDasharray: "5 4" }) }, markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 } });
  };
  const box = `Rule:${owner}:tx`;
  let y = pad + txHeader;
  operations.forEach((op, index) => {
    const id = `Rule:${owner}:operation:${op.statement}`;
    const own = cases.filter((rule) => rule.statement === op.statement);
    const caseStack = own.reduce((sum, rule) => sum + caseHeight(rule) + 16, -16);
    const top = y;
    children.push({ id, type: "logicStep", parentId: box, extent: "parent", position: { x: pad + caseColumn, y: top }, data: { rule: op, zh, number: index + 1 }, style: { width: stepWidth, height: stepHeight(op) }, draggable: false, ariaLabel: `${index + 1}. ${op.title}` });
    let caseY = top;
    own.forEach((rule, caseIndex) => {
      const caseId = `Rule:${owner}:case:${op.statement}:${caseIndex}`;
      children.push({ id: caseId, type: "logicCase", parentId: box, extent: "parent", position: { x: pad, y: caseY }, data: { rule, zh }, style: { width: caseWidth, height: caseHeight(rule) }, draggable: false, ariaLabel: rule.title });
      edge(`${caseId}:value`, caseId, id, "value", undefined, "case");
      caseY += caseHeight(rule) + 16;
    });
    if (index) edge(`${operations[index - 1]!.statement}:next`, `Rule:${owner}:operation:${operations[index - 1]!.statement}`, id, "next");
    y = top + Math.max(stepHeight(op), caseStack) + gap;
  });
  const width = pad * 2 + caseColumn + stepWidth;
  const height = y - gap + pad;
  const commit = `Rule:${owner}:commit`;
  const rollback = `Rule:${owner}:rollback`;
  const last = operations.at(-1);
  if (last) edge("commit", `Rule:${owner}:operation:${last.statement}`, commit, "next");
  // A row rule or a data constraint can fail the batch; nothing else in the graph can.
  operations.filter((op) => op.mode === "row" || op.checks?.length).forEach((op) => edge(`${op.statement}:fail`, `Rule:${owner}:operation:${op.statement}`, rollback, "fail", "fail"));
  const failing = edges.some(({ target }) => target === rollback);
  return {
    nodes: [
      { id: box, type: "logicTx", position: { x: 0, y: 0 }, data: { zh }, style: { width, height }, selectable: false, draggable: false, focusable: false, zIndex: -1 },
      ...children,
      ...(last ? [{ id: commit, type: "logicEnd" as const, position: { x: pad + caseColumn + stepWidth / 2 - 90, y: height + 32 }, data: { commit: true, zh }, style: { width: 180, height: 32 }, selectable: false, draggable: false }] : []),
      ...(failing ? [{ id: rollback, type: "logicEnd" as const, position: { x: width + 48, y: Math.max(0, height / 2 - 16) }, data: { commit: false, zh }, style: { width: 200, height: 32 }, selectable: false, draggable: false }] : []),
    ],
    edges,
  };
}
