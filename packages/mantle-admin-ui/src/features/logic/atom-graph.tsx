import * as React from "react";
import dagre from "@dagrejs/dagre";
import { ArrowDownRight, ArrowUpRight, ChevronDown, ChevronUp, Database, Info, LayoutGrid, Workflow, X } from "lucide-react";
import {
  BaseEdge,
  ControlButton,
  Controls,
  EdgeLabelRenderer,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import { t } from "../../app/i18n";
import type { AdminLanguage } from "../../app/preferences";
import { usePreferences } from "../../app/preferences";
import { resolveLocalizedText } from "../../lib/localized-text";
import type {
  DeveloperAudience,
  DeveloperAtom,
  DeveloperAtomRelation,
  DeveloperConsoleSnapshot,
  DeveloperRelationKind,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const atomKindTone = {
  Schema: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  View: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  Procedure: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  Trigger: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
} as const;

const atomKindNodeTone = {
  Schema: "!border-blue-400/70 [&.selected]:!border-blue-500 [&.selected]:!ring-2 [&.selected]:!ring-blue-500/30 [&.selected]:!shadow-[0_14px_28px_-10px_rgba(59,130,246,0.65)] dark:[&.selected]:!border-blue-300 dark:[&.selected]:!ring-blue-400/45 dark:[&.selected]:!shadow-[0_0_32px_rgba(96,165,250,0.8)]",
  View: "!border-violet-400/70 [&.selected]:!border-violet-500 [&.selected]:!ring-2 [&.selected]:!ring-violet-500/30 [&.selected]:!shadow-[0_14px_28px_-10px_rgba(139,92,246,0.65)] dark:[&.selected]:!border-violet-300 dark:[&.selected]:!ring-violet-400/45 dark:[&.selected]:!shadow-[0_0_32px_rgba(167,139,250,0.8)]",
  Procedure: "!border-amber-400/70 [&.selected]:!border-amber-500 [&.selected]:!ring-2 [&.selected]:!ring-amber-500/30 [&.selected]:!shadow-[0_14px_28px_-10px_rgba(245,158,11,0.65)] dark:[&.selected]:!border-amber-300 dark:[&.selected]:!ring-amber-400/45 dark:[&.selected]:!shadow-[0_0_32px_rgba(251,191,36,0.8)]",
  Trigger: "!border-rose-400/70 [&.selected]:!border-rose-500 [&.selected]:!ring-2 [&.selected]:!ring-rose-500/30 [&.selected]:!shadow-[0_14px_28px_-10px_rgba(244,63,94,0.65)] dark:[&.selected]:!border-rose-300 dark:[&.selected]:!ring-rose-400/45 dark:[&.selected]:!shadow-[0_0_32px_rgba(251,113,133,0.8)]",
} as const;

const audiences = ["public", "members", "staff", "system", "api-clients"] as const satisfies readonly DeveloperAudience[];

type ManifestGraphEdge = Edge<{ kind: DeveloperRelationKind; label: string; opacity: number }, "manifest">;
type FocusSlice = { startId: string; nodeIds: Set<string>; relationIds: Set<string> };
type AudienceGroupGraphNode = Node<{ audience: DeveloperAudience; count: number; language: AdminLanguage }, "audience">;

const edgeTypes = { manifest: ManifestEdge } satisfies EdgeTypes;
const nodeTypes = { audience: AudienceGroupNode } satisfies NodeTypes;

export function relationLabel(language: AdminLanguage, kind: DeveloperRelationKind): string {
  if (kind === "translation-parent") return t(language, "developer.graph.relation.translationParent");
  if (kind === "schema-reference") return t(language, "developer.graph.relation.schemaReference");
  if (kind === "view-source") return t(language, "developer.graph.relation.viewSource");
  if (kind === "authorization-guard") return t(language, "developer.graph.relation.guard");
  if (kind === "procedure-schema") return t(language, "developer.graph.relation.procedureSchema");
  if (kind === "collection-action") return t(language, "developer.graph.relation.collectionAction");
  if (kind === "input-reference") return t(language, "developer.graph.relation.inputReference");
  if (kind === "trigger-target") return t(language, "developer.graph.relation.triggerTarget");
  return t(language, "developer.graph.relation.lifecycleSource");
}

export function audienceLabel(language: AdminLanguage, audience: DeveloperAudience): string {
  if (audience === "public") return t(language, "developer.graph.audience.public");
  if (audience === "members") return t(language, "developer.graph.audience.members");
  if (audience === "staff") return t(language, "developer.graph.audience.staff");
  if (audience === "system") return t(language, "developer.graph.audience.system");
  return t(language, "developer.graph.audience.apiClients");
}

export function atomKindLabel(language: AdminLanguage, kind: DeveloperAtom["kind"]): string {
  if (kind === "Schema") return t(language, "developer.graph.kind.schema");
  if (kind === "View") return t(language, "developer.graph.kind.view");
  if (kind === "Procedure") return t(language, "developer.graph.kind.procedure");
  return t(language, "developer.graph.kind.trigger");
}

function audienceDescription(language: AdminLanguage, audience: DeveloperAudience): string {
  if (audience === "public") return t(language, "developer.graph.audienceDescription.public");
  if (audience === "members") return t(language, "developer.graph.audienceDescription.members");
  if (audience === "staff") return t(language, "developer.graph.audienceDescription.staff");
  if (audience === "system") return t(language, "developer.graph.audienceDescription.system");
  return t(language, "developer.graph.audienceDescription.apiClients");
}

function AudienceBadge({ language, audience, prominent = false }: { language: AdminLanguage; audience: DeveloperAudience; prominent?: boolean }): React.ReactElement {
  const label = audienceLabel(language, audience);
  const description = audienceDescription(language, audience);
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border font-semibold uppercase tracking-wider", prominent ? "border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-800 shadow-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" : "border-border bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground")}>
      {label}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="nodrag nopan pointer-events-auto inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${label}: ${description}`}>
            <Info className={prominent ? "size-3.5" : "size-3"} aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent>{description}</TooltipContent>
      </Tooltip>
    </span>
  );
}

function AudienceGroupNode({ data }: NodeProps<AudienceGroupGraphNode>): React.ReactElement {
  return (
    <section className="pointer-events-none h-full w-full overflow-hidden rounded-2xl border-2 border-blue-200 bg-blue-50 text-slate-950 shadow-sm dark:border-slate-600 dark:bg-[#111d35] dark:text-slate-50">
      <header className="flex h-12 items-center justify-between border-b border-blue-200 bg-blue-100 px-4 dark:border-slate-600 dark:bg-[#172845]">
        <AudienceBadge language={data.language} audience={data.audience} prominent />
        <span className="rounded-full border border-slate-300 bg-white px-2.5 py-1 font-mono text-[11px] font-bold text-slate-700 shadow-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100">{data.count}</span>
      </header>
    </section>
  );
}

export function AtomGraph({
  graph,
  selectedAtomId,
  onSelect,
  onOpen,
}: {
  graph: DeveloperConsoleSnapshot["graph"];
  selectedAtomId: string | null;
  onSelect: (id: string | null) => void;
  onOpen: (atom: DeveloperAtom) => void;
}): React.ReactElement {
  const { language, theme } = usePreferences();
  const layout = React.useMemo(() => layoutGraph(graph, language), [graph, language]);
  const [nodes, setNodes, onNodesChange] = useNodesState(layout.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layout.edges);
  const [flow, setFlow] = React.useState<ReactFlowInstance<Node, Edge> | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [trace, setTrace] = React.useState<FocusSlice | null>(null);
  const atomsById = React.useMemo(() => new Map(graph.atoms.map((atom) => [atom.id, atom])), [graph.atoms]);
  const selected = selectedId ? atomsById.get(selectedId) ?? null : null;
  const traceAtoms = React.useMemo(() => trace ? traceAtomIds(graph, trace.nodeIds, trace.startId).map((id) => atomsById.get(id)).filter((atom): atom is DeveloperAtom => Boolean(atom)) : [], [atomsById, graph, trace]);

  React.useEffect(() => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
    setSelectedId(null);
    setTrace(null);
  }, [layout, setEdges, setNodes]);

  const highlight = (nodeIds: ReadonlySet<string>, relationIds: ReadonlySet<string>): void => {
    setNodes((current) => current.map((node) => {
      const inactive = atomsById.has(node.id) && !nodeIds.has(node.id);
      return {
        ...node,
        style: { ...node.style, opacity: inactive ? "var(--graph-inactive-opacity)" : 1, filter: inactive ? "var(--graph-inactive-filter)" : "none", transition: "filter 180ms ease, opacity 180ms ease" },
        zIndex: atomsById.has(node.id) ? nodeIds.has(node.id) ? 1 : 0 : -1,
      };
    }));
    setEdges((current) => current.map((edge) => {
      const active = relationIds.has(edge.id);
      return {
        ...edge,
        style: { ...edge.style, opacity: active ? 1 : 0.08, stroke: active ? "var(--foreground)" : "var(--muted-foreground)", strokeWidth: active ? 2.5 : 1.25 },
        data: edge.data ? { ...edge.data, opacity: active ? 1 : 0.08 } : edge.data,
        markerEnd: typeof edge.markerEnd === "object" ? { ...edge.markerEnd, color: active ? "var(--foreground)" : "var(--muted-foreground)" } : edge.markerEnd,
        zIndex: active ? 1 : 0,
      };
    }));
  };

  const inspect = (id: string, slice = focusSlice(graph, id)): void => {
    setSelectedId(id);
    setTrace(slice);
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === id })));
    highlight(slice.nodeIds, slice.relationIds);
  };

  React.useEffect(() => {
    if (!flow || !selectedId) return;
    const compact = window.innerWidth < 640;
    void flow.fitView({
      nodes: [{ id: selectedId }],
      padding: { top: "20%", right: compact ? "60%" : "34%", bottom: "20%", left: compact ? "2%" : "8%" },
      minZoom: compact ? 0.78 : 0.9,
      maxZoom: compact ? 1 : 1.2,
      duration: 320,
    });
  }, [flow, selectedId]);

  const selectAtom = (id: string, slice = focusSlice(graph, id)): void => {
    inspect(id, slice);
    onSelect(id);
  };

  const moveAlongTrace = (id: string): void => selectAtom(id, trace?.nodeIds.has(id) ? trace : focusSlice(graph, id));

  const closeHud = (): void => {
    setSelectedId(null);
    setTrace(null);
    setNodes((current) => current.map((node) => ({ ...node, selected: false, style: { ...node.style, opacity: 1, filter: "none" }, zIndex: atomsById.has(node.id) ? 0 : -1 })));
    setEdges(layout.edges);
  };

  const clearSelection = (): void => {
    closeHud();
    onSelect(null);
  };

  React.useEffect(() => {
    if (selectedAtomId && atomsById.has(selectedAtomId)) {
      if (selectedAtomId !== selectedId) inspect(selectedAtomId);
      return;
    }
    if (selectedId) closeHud();
  }, [atomsById, layout, selectedAtomId, selectedId]);

  const relayout = (): void => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
    setSelectedId(null);
    setTrace(null);
    onSelect(null);
    window.requestAnimationFrame(() => void flow?.fitView({ padding: 0.08, duration: 240 }));
  };

  return (
    <ReactFlow
      className="bg-background [--graph-inactive-filter:none] [--graph-inactive-opacity:0.16] dark:[--graph-inactive-filter:brightness(0.42)_saturate(0.2)] dark:[--graph-inactive-opacity:1]"
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onInit={setFlow}
      edgeTypes={edgeTypes}
      nodeTypes={nodeTypes}
      colorMode={theme}
      fitView
      fitViewOptions={{ padding: 0.08 }}
      minZoom={0.25}
      maxZoom={1.8}
      nodesConnectable={false}
      nodesDraggable
      onNodeClick={(_, node) => {
        if (atomsById.has(node.id)) selectAtom(node.id);
      }}
      onPaneClick={clearSelection}
    >
      <Controls className="overflow-hidden rounded-lg border bg-background/95 shadow-md" showInteractive={false} fitViewOptions={{ padding: 0.08, duration: 240 }}>
        <ControlButton onClick={relayout} title={t(language, "developer.graph.relayout")} aria-label={t(language, "developer.graph.relayout")}>
          <LayoutGrid aria-hidden />
        </ControlButton>
      </Controls>
      {selected ? (
        <Panel position="top-right" className="!m-3 w-[20rem] max-w-[calc(100%-1.5rem)] sm:w-[22rem]">
          <GraphHud atom={selected} graph={graph} atomsById={atomsById} traceAtoms={traceAtoms} onClose={clearSelection} onSelect={moveAlongTrace} onOpen={onOpen} />
        </Panel>
      ) : null}
    </ReactFlow>
  );
}

function layoutGraph(
  graph: DeveloperConsoleSnapshot["graph"],
  language: AdminLanguage,
): { nodes: Node[]; edges: Edge[] } {
  const { positions, groups } = layoutTopDown(graph);

  return {
    nodes: [
      ...groups.map((group) => ({
        id: `Audience:${group.audience}`,
        type: "audience",
        position: { x: group.x, y: group.y },
        data: { audience: group.audience, count: group.count, language },
        className: "pointer-events-none !border-0 !bg-transparent !p-0 !shadow-none",
        style: { width: group.width, height: group.height },
        selectable: false,
        draggable: false,
        connectable: false,
        focusable: false,
        zIndex: -1,
      } satisfies Node)),
      ...graph.atoms.map((atom) => {
      const position = positions.get(atom.id) ?? { x: 0, y: 0 };
      const title = resolveLocalizedText(atom.title, language);
      return {
        id: atom.id,
        position,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: {
          label: (
            <div className="min-w-0 space-y-1.5 text-start">
              <div className="flex items-center gap-1.5">
                <span className={cn("inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", atomKindTone[atom.kind])}>{atomKindLabel(language, atom.kind)}</span>
                {atom.transport ? <span className="inline-flex rounded border bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{atom.transport}</span> : null}
              </div>
              <div className="truncate font-mono text-xs font-semibold">{atom.name}</div>
              {title && title !== atom.name ? <div className="truncate text-[10px] text-muted-foreground">{title}</div> : null}
            </div>
          ),
        },
        ariaLabel: `${atomKindLabel(language, atom.kind)} ${atom.name}`,
        className: cn(
          "!h-[76px] !w-[220px] !cursor-grab !rounded-xl !border-2 !bg-white !px-3 !py-2 !text-card-foreground !shadow-lg transition-[border-color,box-shadow,filter] hover:brightness-110 active:!cursor-grabbing dark:!bg-[#0a1124]",
          atomKindNodeTone[atom.kind],
        ),
      } satisfies Node;
    }),
    ],
    edges: graph.relations.map((relation) => ({
      id: relation.id,
      source: relation.sourceId,
      target: relation.targetId,
      type: "manifest",
      data: { kind: relation.kind, label: relationLabel(language, relation.kind), opacity: 0 },
      ariaLabel: `${relationLabel(language, relation.kind)}: ${relation.sourceId} to ${relation.targetId}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--muted-foreground)" },
      style: { opacity: relationOpacity(relation.kind), stroke: "var(--muted-foreground)", strokeWidth: relationOpacity(relation.kind) > 0.2 ? 1.5 : 1 },
    } satisfies Edge)),
  };
}

function ManifestEdge({ id, data, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, markerEnd, style }: EdgeProps<ManifestGraphEdge>): React.ReactElement {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-none absolute z-20 whitespace-nowrap rounded-md border bg-popover px-1.5 py-0.5 text-[10px] font-semibold text-popover-foreground shadow-sm"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity: data?.opacity ?? 1, boxShadow: "0 0 0 3px var(--background)", transition: "opacity 180ms ease" }}
        >
          {data?.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export function layoutComponents(graph: DeveloperConsoleSnapshot["graph"]): Map<string, { x: number; y: number }> {
  return layoutTopDown(graph).positions;
}

function layoutTopDown(graph: DeveloperConsoleSnapshot["graph"]): { positions: Map<string, { x: number; y: number }>; groups: Array<{ audience: DeveloperAudience; x: number; y: number; width: number; height: number; count: number }> } {
  const nodeWidth = 220;
  const nodeHeight = 76;
  const gap = 32;
  const groupPadding = 24;
  const groupHeader = 48;
  const groupColumns = 4;
  const layout = new dagre.graphlib.Graph({ multigraph: true }).setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: "TB", nodesep: gap, ranksep: 160, edgesep: 20 });
  graph.atoms.forEach(({ id }) => layout.setNode(id, { width: nodeWidth, height: nodeHeight }));
  graph.relations.filter(({ kind }) => ["trigger-target", "procedure-schema", "collection-action", "view-source"].includes(kind)).forEach(({ id, sourceId, targetId }) => layout.setEdge(sourceId, targetId, {}, id));
  dagre.layout(layout);

  const positions = new Map<string, { x: number; y: number }>();
  const groups: Array<{ audience: DeveloperAudience; x: number; y: number; width: number; height: number; count: number }> = [];
  const relationTarget = new Map(graph.relations.filter(({ kind }) => kind === "trigger-target" || kind === "view-source").map(({ sourceId, targetId }) => [sourceId, targetId]));
  let groupX = 72;
  audiences.forEach((audience) => {
    const atoms = graph.atoms.filter((atom) => (atom.kind === "Trigger" || atom.kind === "View") && (atom.audience ?? "public") === audience).sort((a, b) => `${relationTarget.get(a.id) ?? ""}:${a.id}`.localeCompare(`${relationTarget.get(b.id) ?? ""}:${b.id}`));
    if (!atoms.length) return;
    const columns = Math.min(groupColumns, atoms.length);
    const rows = Math.ceil(atoms.length / groupColumns);
    const width = groupPadding * 2 + columns * nodeWidth + (columns - 1) * gap;
    const height = groupHeader + groupPadding + rows * nodeHeight + (rows - 1) * gap + groupPadding;
    groups.push({ audience, x: groupX, y: 48, width, height, count: atoms.length });
    atoms.forEach((atom, index) => positions.set(atom.id, { x: groupX + groupPadding + index % groupColumns * (nodeWidth + gap), y: 48 + groupHeader + groupPadding + Math.floor(index / groupColumns) * (nodeHeight + gap) }));
    groupX += width + 56;
  });

  const surfaceBottom = Math.max(...groups.map(({ y, height }) => y + height), 200);
  const preferredX = (atom: DeveloperAtom, kinds: readonly DeveloperRelationKind[]): number => {
    const related = graph.relations.filter(({ targetId, kind }) => targetId === atom.id && kinds.includes(kind)).map(({ sourceId }) => positions.get(sourceId)).filter((position): position is { x: number; y: number } => Boolean(position));
    return related.length ? related.reduce((sum, position) => sum + position.x + nodeWidth / 2, 0) / related.length : layout.node(atom.id).x;
  };
  const bandColumns = 7;
  const pack = (atoms: DeveloperAtom[], y: number, kinds: readonly DeveloperRelationKind[]): number => {
    const ordered = atoms.map((atom) => ({ atom, preferred: preferredX(atom, kinds) })).sort((a, b) => a.preferred - b.preferred);
    const columns = Math.min(bandColumns, ordered.length);
    ordered.forEach(({ atom }, index) => positions.set(atom.id, { x: 72 + index % bandColumns * (nodeWidth + 52), y: y + Math.floor(index / bandColumns) * (nodeHeight + gap) }));
    return Math.ceil(ordered.length / Math.max(columns, 1)) * (nodeHeight + gap);
  };
  const procedureY = surfaceBottom + 180;
  const procedureHeight = pack(graph.atoms.filter(({ kind }) => kind === "Procedure"), procedureY, ["trigger-target"]);
  pack(graph.atoms.filter(({ kind }) => kind === "Schema"), procedureY + procedureHeight + 140, ["procedure-schema", "collection-action", "view-source"]);
  return { positions, groups };
}

export function focusSlice(graph: DeveloperConsoleSnapshot["graph"], selectedId: string): FocusSlice {
  const nodeIds = new Set([selectedId]);
  const relationIds = new Set<string>();
  const selectedKind = graph.atoms.find(({ id }) => id === selectedId)?.kind;
  const add = (relation: DeveloperAtomRelation): void => {
    relationIds.add(relation.id);
    nodeIds.add(relation.sourceId);
    nodeIds.add(relation.targetId);
  };
  const direct = graph.relations.filter(({ sourceId, targetId }) => sourceId === selectedId || targetId === selectedId);

  if (selectedKind === "Trigger") {
    const targets = graph.relations.filter(({ sourceId, kind }) => sourceId === selectedId && kind === "trigger-target");
    targets.forEach((relation) => add(relation));
    const procedureIds = new Set(targets.map(({ targetId }) => targetId));
    graph.relations.filter(({ sourceId, kind }) => procedureIds.has(sourceId) && ["procedure-schema", "collection-action"].includes(kind)).forEach((relation) => add(relation));
  } else if (selectedKind === "Procedure") {
    direct.filter(({ kind }) => ["trigger-target", "procedure-schema", "collection-action"].includes(kind)).forEach((relation) => add(relation));
  } else if (selectedKind === "View") {
    direct.filter(({ kind }) => kind === "view-source").forEach((relation) => add(relation));
  } else if (selectedKind === "Schema") {
    direct.filter(({ sourceId, kind }) => sourceId === selectedId && ["schema-reference", "translation-parent"].includes(kind)).forEach((relation) => add(relation));
    const upstream = direct.filter(({ targetId, kind }) => targetId === selectedId && ["procedure-schema", "collection-action", "input-reference", "lifecycle-source"].includes(kind));
    upstream.forEach((relation) => add(relation));
    const procedureIds = new Set(upstream.filter(({ sourceId }) => sourceId.startsWith("Procedure:")).map(({ sourceId }) => sourceId));
    graph.relations.filter(({ targetId, kind }) => procedureIds.has(targetId) && kind === "trigger-target").forEach((relation) => add(relation));
  }

  return { startId: selectedId, nodeIds, relationIds };
}

export function traceAtomIds(graph: DeveloperConsoleSnapshot["graph"], nodeIds: ReadonlySet<string>, startId?: string): string[] {
  const rank = { Trigger: 0, View: 0, Procedure: 1, Schema: 2 } as const;
  return graph.atoms
    .filter(({ id }) => nodeIds.has(id))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || Number(b.id === startId) - Number(a.id === startId) || a.name.localeCompare(b.name))
    .map(({ id }) => id);
}

function relationOpacity(kind: DeveloperRelationKind): number {
  return ["schema-reference", "translation-parent", "input-reference", "authorization-guard"].includes(kind) ? 0.12 : 0.58;
}

function GraphHud({ atom, graph, atomsById, traceAtoms, onClose, onSelect, onOpen }: { atom: DeveloperAtom; graph: DeveloperConsoleSnapshot["graph"]; atomsById: ReadonlyMap<string, DeveloperAtom>; traceAtoms: readonly DeveloperAtom[]; onClose: () => void; onSelect: (id: string) => void; onOpen: (atom: DeveloperAtom) => void }): React.ReactElement {
  const { language } = usePreferences();
  const title = resolveLocalizedText(atom.title, language);
  const description = resolveLocalizedText(atom.description ?? null, language);
  const outgoing = graph.relations.filter(({ sourceId }) => sourceId === atom.id);
  const incoming = graph.relations.filter(({ targetId }) => targetId === atom.id);
  const modelAtom = atom.kind === "Schema" || atom.kind === "View";
  const OpenIcon = modelAtom ? Database : Workflow;
  const openLabel = t(language, modelAtom ? "developer.graph.openModel" : "developer.graph.openLogic");
  const currentIndex = Math.max(0, traceAtoms.findIndex(({ id }) => id === atom.id));
  const previous = traceAtoms[currentIndex - 1];
  const next = traceAtoms[currentIndex + 1];
  const facts = hudFacts(language, atom);
  return (
    <aside className="max-h-[calc(100vh-7rem)] overflow-y-auto rounded-xl border bg-white text-popover-foreground shadow-2xl dark:bg-[#090f20]" aria-label={t(language, "developer.graph.details")}>
      <header className="sticky top-0 z-10 border-b bg-white p-4 dark:bg-[#090f20]">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={cn("inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", atomKindTone[atom.kind])}>{atomKindLabel(language, atom.kind)}</span>
              {atom.transport ? <span className="inline-flex rounded border bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{atom.transport}</span> : null}
              {atom.audience ? <AudienceBadge language={language} audience={atom.audience} /> : null}
            </div>
            <h2 className="mt-2 truncate text-sm font-semibold">{title || atom.name}</h2>
            {title && title !== atom.name ? <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{atom.name}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" onClick={() => onOpen(atom)} aria-label={openLabel}><OpenIcon aria-hidden /></Button></TooltipTrigger><TooltipContent>{openLabel}</TooltipContent></Tooltip>
            <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label={t(language, "common.close")}><X aria-hidden /></Button>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 border-t pt-3">
          <Button type="button" variant="outline" size="icon-sm" disabled={!previous} onClick={() => previous && onSelect(previous.id)} aria-label={t(language, "developer.graph.previous")}><ChevronUp aria-hidden /></Button>
          <span className="min-w-0 flex-1 text-center text-[11px] font-medium text-muted-foreground">{t(language, "developer.graph.step", { current: String(currentIndex + 1), total: String(traceAtoms.length) })}</span>
          <Button type="button" variant="outline" size="icon-sm" disabled={!next} onClick={() => next && onSelect(next.id)} aria-label={t(language, "developer.graph.next")}><ChevronDown aria-hidden /></Button>
        </div>
      </header>
      <div className="space-y-5 p-4">
        <p className="text-sm leading-6 text-popover-foreground">{description || hudSummary(language, atom, outgoing, incoming, atomsById)}</p>
        {facts.length ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border bg-muted/35 p-3">
            {facts.map(({ label, value }) => <div key={label} className="min-w-0"><dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</dt><dd className="mt-1 break-words font-mono text-xs font-semibold">{value}</dd></div>)}
          </dl>
        ) : null}
        {incoming.length ? <HudRelationGroup title={t(language, "developer.graph.comesFrom")} relations={incoming} outgoing={false} atomsById={atomsById} onSelect={onSelect} /> : null}
        {outgoing.length ? <HudRelationGroup title={t(language, "developer.graph.continuesTo")} relations={outgoing} outgoing atomsById={atomsById} onSelect={onSelect} /> : null}
        {!outgoing.length && !incoming.length ? <p className="text-sm text-muted-foreground">{t(language, "model.noRelations")}</p> : null}
      </div>
    </aside>
  );
}

function hudSummary(language: AdminLanguage, atom: DeveloperAtom, outgoing: readonly DeveloperAtomRelation[], incoming: readonly DeveloperAtomRelation[], atomsById: ReadonlyMap<string, DeveloperAtom>): string {
  const target = outgoing[0] ? atomsById.get(outgoing[0].targetId)?.name : null;
  if (atom.kind === "Trigger") return t(language, "developer.graph.summary.trigger", { audience: audienceLabel(language, atom.audience ?? "public"), transport: atom.transport?.toUpperCase() ?? "manifest", target: target ?? "—" });
  if (atom.kind === "Procedure" && atom.handler?.kind === "builtin") return t(language, "developer.graph.summary.builtin", { op: atom.handler.op, schema: atom.handler.schema });
  if (atom.kind === "Procedure" && atom.handler?.kind === "ref") return t(language, "developer.graph.summary.ref", { ref: atom.handler.ref });
  if (atom.kind === "View") return t(language, "developer.graph.summary.view", { audience: audienceLabel(language, atom.audience ?? "public"), target: target ?? "—" });
  return t(language, "developer.graph.summary.schema", { incoming: String(incoming.length), outgoing: String(outgoing.length) });
}

function hudFacts(language: AdminLanguage, atom: DeveloperAtom): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];
  if (atom.transport) facts.push({ label: t(language, "developer.graph.fact.transport"), value: atom.transport.toUpperCase() });
  if (atom.handler?.kind === "ref") facts.push({ label: t(language, "developer.graph.fact.handler"), value: atom.handler.ref });
  if (atom.handler?.kind === "builtin") {
    facts.push({ label: t(language, "developer.graph.fact.handler"), value: t(language, "developer.graph.builtin") });
    facts.push({ label: t(language, "developer.graph.fact.operation"), value: atom.handler.op });
    facts.push({ label: t(language, "developer.graph.fact.schema"), value: atom.handler.schema });
    if (atom.handler.match?.length) facts.push({ label: t(language, "developer.graph.fact.match"), value: atom.handler.match.join(" + ") });
  }
  return facts;
}

function HudRelationGroup({ title, relations, outgoing, atomsById, onSelect }: { title: string; relations: readonly DeveloperAtomRelation[]; outgoing: boolean; atomsById: ReadonlyMap<string, DeveloperAtom>; onSelect: (id: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  const DirectionIcon = outgoing ? ArrowDownRight : ArrowUpRight;
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="space-y-2">
        {relations.map((relation) => {
          const related = atomsById.get(outgoing ? relation.targetId : relation.sourceId);
          return related ? (
            <div key={relation.id} className="rounded-lg border bg-white p-3 text-card-foreground dark:bg-[#0a1124]">
              <button type="button" className="flex w-full min-w-0 items-center gap-2 text-start hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(related.id)}>
                <DirectionIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-xs font-medium">{relationLabel(language, relation.kind)}</span>
                <span className="ms-auto min-w-0 truncate font-mono text-xs font-semibold">{related.name}</span>
              </button>
              <details className="mt-2 border-t pt-2">
                <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">{t(language, "developer.graph.manifestSource")}</summary>
                <code className="mt-2 block break-all rounded bg-muted p-2 text-[10px] text-muted-foreground">{relation.sourceId.replace(":", "/")}{relation.pointer} = {JSON.stringify(relation.value)}</code>
              </details>
            </div>
          ) : null;
        })}
      </div>
    </section>
  );
}
