import * as React from "react";
import dagre from "@dagrejs/dagre";
import { ArrowDownRight, ArrowUpRight, ExternalLink, LayoutGrid, X } from "lucide-react";
import {
  ControlButton,
  Controls,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
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
  DeveloperAtom,
  DeveloperAtomRelation,
  DeveloperConsoleSnapshot,
  DeveloperRelationKind,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button } from "@/components/ui/button";

export const atomKindTone = {
  Schema: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  View: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  Procedure: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  Trigger: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
} as const;

const atomKindNodeTone = {
  Schema: "!border-blue-400/70 !bg-blue-500/10 dark:!bg-blue-950/70",
  View: "!border-violet-400/70 !bg-violet-500/10 dark:!bg-violet-950/70",
  Procedure: "!border-amber-400/70 !bg-amber-500/10 dark:!bg-amber-950/70",
  Trigger: "!border-rose-400/70 !bg-rose-500/10 dark:!bg-rose-950/70",
} as const;

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

export function AtomGraph({
  graph,
  onOpen,
}: {
  graph: DeveloperConsoleSnapshot["graph"];
  onOpen: (atom: DeveloperAtom) => void;
}): React.ReactElement {
  const { language, theme } = usePreferences();
  const layout = React.useMemo(() => layoutGraph(graph, language), [graph, language]);
  const [nodes, setNodes, onNodesChange] = useNodesState(layout.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layout.edges);
  const [flow, setFlow] = React.useState<ReactFlowInstance<Node, Edge> | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const atomsById = React.useMemo(() => new Map(graph.atoms.map((atom) => [atom.id, atom])), [graph.atoms]);
  const selected = selectedId ? atomsById.get(selectedId) ?? null : null;

  React.useEffect(() => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
    setSelectedId(null);
  }, [layout, setEdges, setNodes]);

  const inspect = (id: string): void => {
    const family = new Set(connectedComponents(graph).find((component) => component.includes(id)) ?? [id]);
    setSelectedId(id);
    setNodes((current) => current.map((node) => ({
      ...node,
      selected: node.id === id,
      style: { ...node.style, opacity: family.has(node.id) ? 1 : 0.16, transition: "opacity 180ms ease" },
      zIndex: family.has(node.id) ? 1 : 0,
    })));
    setEdges((current) => current.map((edge) => {
      const active = family.has(edge.source) && family.has(edge.target);
      return {
        ...edge,
        style: { ...edge.style, opacity: active ? 1 : 0.08, stroke: active ? "var(--foreground)" : "var(--muted-foreground)", strokeWidth: active ? 2.5 : 1.25 },
        labelStyle: { ...edge.labelStyle, opacity: active ? 1 : 0.08 },
        labelBgStyle: { ...edge.labelBgStyle, opacity: active ? 1 : 0.08 },
        markerEnd: typeof edge.markerEnd === "object" ? { ...edge.markerEnd, color: active ? "var(--foreground)" : "var(--muted-foreground)" } : edge.markerEnd,
        zIndex: active ? 1 : 0,
      };
    }));
    window.requestAnimationFrame(() => void flow?.fitView({
      nodes: [...family].map((familyId) => ({ id: familyId })),
      padding: { top: "12%", right: "34%", bottom: "12%", left: "8%" },
      maxZoom: 1.05,
      duration: 320,
    }));
  };

  const closeHud = (): void => {
    setSelectedId(null);
    setNodes((current) => current.map((node) => ({ ...node, selected: false, style: { ...node.style, opacity: 1 }, zIndex: 0 })));
    setEdges((current) => current.map((edge) => ({
      ...edge,
      style: { ...edge.style, opacity: 1, stroke: "var(--muted-foreground)", strokeWidth: 2 },
      labelStyle: { ...edge.labelStyle, opacity: 1 },
      labelBgStyle: { ...edge.labelBgStyle, opacity: 1 },
      markerEnd: typeof edge.markerEnd === "object" ? { ...edge.markerEnd, color: "var(--muted-foreground)" } : edge.markerEnd,
      zIndex: 0,
    })));
  };

  const relayout = (): void => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
    setSelectedId(null);
    window.requestAnimationFrame(() => void flow?.fitView({ padding: 0.08, duration: 240 }));
  };

  return (
    <ReactFlow
      className="bg-background"
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onInit={setFlow}
      colorMode={theme}
      fitView
      fitViewOptions={{ padding: 0.08 }}
      minZoom={0.25}
      maxZoom={1.8}
      nodesConnectable={false}
      nodesDraggable
      onNodeClick={(_, node) => {
        inspect(node.id);
      }}
      onPaneClick={closeHud}
    >
      <Controls className="overflow-hidden rounded-lg border bg-background/95 shadow-md" showInteractive={false} fitViewOptions={{ padding: 0.08, duration: 240 }}>
        <ControlButton onClick={relayout} title={t(language, "developer.graph.relayout")} aria-label={t(language, "developer.graph.relayout")}>
          <LayoutGrid aria-hidden />
        </ControlButton>
      </Controls>
      {selected ? (
        <Panel position="top-right" className="!m-3 w-[22rem] max-w-[calc(100%-1.5rem)]">
          <GraphHud atom={selected} graph={graph} atomsById={atomsById} onClose={closeHud} onInspect={inspect} onOpen={onOpen} />
        </Panel>
      ) : null}
    </ReactFlow>
  );
}

function layoutGraph(
  graph: DeveloperConsoleSnapshot["graph"],
  language: AdminLanguage,
): { nodes: Node[]; edges: Edge[] } {
  const positions = layoutComponents(graph);

  return {
    nodes: graph.atoms.map((atom) => {
      const position = positions.get(atom.id) ?? { x: 0, y: 0 };
      const title = resolveLocalizedText(atom.title, language);
      return {
        id: atom.id,
        position,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: {
          label: (
            <div className="min-w-0 space-y-1.5 text-start">
              <span className={cn("inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", atomKindTone[atom.kind])}>{atom.kind}</span>
              <div className="truncate font-mono text-xs font-semibold">{atom.name}</div>
              {title && title !== atom.name ? <div className="truncate text-[10px] text-muted-foreground">{title}</div> : null}
            </div>
          ),
        },
        ariaLabel: `${atom.kind} ${atom.name}`,
        className: cn(
          "!h-[76px] !w-[220px] !cursor-grab !rounded-xl !border-2 !px-3 !py-2 !text-card-foreground !shadow-lg transition-[border-color,box-shadow,filter] hover:brightness-110 active:!cursor-grabbing [&.selected]:!ring-2 [&.selected]:!ring-primary/50",
          atomKindNodeTone[atom.kind],
        ),
      } satisfies Node;
    }),
    edges: graph.relations.map((relation) => ({
      id: relation.id,
      source: relation.sourceId,
      target: relation.targetId,
      type: "smoothstep",
      label: relationLabel(language, relation.kind),
      ariaLabel: `${relationLabel(language, relation.kind)}: ${relation.sourceId} to ${relation.targetId}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--muted-foreground)" },
      style: { stroke: "var(--muted-foreground)", strokeWidth: 2 },
      labelStyle: { fill: "var(--foreground)", fontSize: 12, fontWeight: 700 },
      labelBgStyle: { fill: "var(--popover)", fillOpacity: 1, stroke: "var(--border)", strokeWidth: 1 },
      labelBgPadding: [8, 4],
      labelBgBorderRadius: 7,
    } satisfies Edge)),
  };
}

export function layoutComponents(graph: DeveloperConsoleSnapshot["graph"]): Map<string, { x: number; y: number }> {
  const nodeWidth = 220;
  const nodeHeight = 76;
  const gap = 72;
  const targetRowWidth = 1800;
  const components = connectedComponents(graph);
  const laidOut = components.map((ids) => {
    const idSet = new Set(ids);
    const layout = new dagre.graphlib.Graph({ multigraph: true }).setDefaultEdgeLabel(() => ({}));
    layout.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 112, edgesep: 20, marginx: 28, marginy: 28 });
    ids.forEach((id) => layout.setNode(id, { width: nodeWidth, height: nodeHeight }));
    graph.relations.filter(({ sourceId, targetId }) => idSet.has(sourceId) && idSet.has(targetId)).forEach(({ id, sourceId, targetId }) => layout.setEdge(sourceId, targetId, {}, id));
    dagre.layout(layout);
    const bounds = ids.reduce((current, id) => {
      const node = layout.node(id);
      return {
        minX: Math.min(current.minX, node.x - nodeWidth / 2),
        minY: Math.min(current.minY, node.y - nodeHeight / 2),
        maxX: Math.max(current.maxX, node.x + nodeWidth / 2),
        maxY: Math.max(current.maxY, node.y + nodeHeight / 2),
      };
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    return {
      ids,
      layout,
      bounds,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
    };
  }).sort((a, b) => (b.width * b.height) - (a.width * a.height));

  const positions = new Map<string, { x: number; y: number }>();
  let x = gap;
  let y = gap;
  let rowHeight = 0;
  laidOut.forEach((component) => {
    if (x > gap && x + component.width > targetRowWidth) {
      x = gap;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    component.ids.forEach((id) => {
      const node = component.layout.node(id);
      positions.set(id, { x: x + node.x - component.bounds.minX - nodeWidth / 2, y: y + node.y - component.bounds.minY - nodeHeight / 2 });
    });
    x += component.width + gap;
    rowHeight = Math.max(rowHeight, component.height);
  });
  return positions;
}

export function connectedComponents(graph: DeveloperConsoleSnapshot["graph"]): string[][] {
  const adjacency = new Map(graph.atoms.map(({ id }) => [id, new Set<string>()]));
  graph.relations.forEach(({ sourceId, targetId }) => {
    adjacency.get(sourceId)?.add(targetId);
    adjacency.get(targetId)?.add(sourceId);
  });
  const remaining = new Set(adjacency.keys());
  const components: string[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value as string;
    const component: string[] = [];
    const pending = [first];
    remaining.delete(first);
    while (pending.length) {
      const id = pending.pop();
      if (!id) continue;
      component.push(id);
      adjacency.get(id)?.forEach((related) => {
        if (!remaining.delete(related)) return;
        pending.push(related);
      });
    }
    components.push(component);
  }
  return components;
}

function GraphHud({ atom, graph, atomsById, onClose, onInspect, onOpen }: { atom: DeveloperAtom; graph: DeveloperConsoleSnapshot["graph"]; atomsById: ReadonlyMap<string, DeveloperAtom>; onClose: () => void; onInspect: (id: string) => void; onOpen: (atom: DeveloperAtom) => void }): React.ReactElement {
  const { language } = usePreferences();
  const title = resolveLocalizedText(atom.title, language);
  const outgoing = graph.relations.filter(({ sourceId }) => sourceId === atom.id);
  const incoming = graph.relations.filter(({ targetId }) => targetId === atom.id);
  const navigable = atom.kind === "Schema" || atom.kind === "View";
  return (
    <aside className="max-h-[calc(100vh-7rem)] overflow-y-auto rounded-xl border bg-popover/95 text-popover-foreground shadow-2xl backdrop-blur" aria-label={t(language, "developer.graph.details")}>
      <header className="sticky top-0 z-10 flex items-start gap-3 border-b bg-popover/95 p-4 backdrop-blur">
        <div className="min-w-0 flex-1">
          <span className={cn("inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", atomKindTone[atom.kind])}>{atom.kind}</span>
          <h2 className="mt-2 truncate font-mono text-sm font-semibold">{atom.name}</h2>
          {title && title !== atom.name ? <p className="mt-1 truncate text-xs text-muted-foreground">{title}</p> : null}
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label={t(language, "common.close")}><X aria-hidden /></Button>
      </header>
      <div className="space-y-5 p-4">
        {outgoing.length ? <HudRelationGroup title={t(language, "model.references")} relations={outgoing} outgoing atomsById={atomsById} onInspect={onInspect} /> : null}
        {incoming.length ? <HudRelationGroup title={t(language, "model.referencedBy")} relations={incoming} outgoing={false} atomsById={atomsById} onInspect={onInspect} /> : null}
        {!outgoing.length && !incoming.length ? <p className="text-sm text-muted-foreground">{t(language, "model.noRelations")}</p> : null}
        {navigable ? <Button type="button" className="w-full" onClick={() => onOpen(atom)}>{t(language, "developer.graph.openModel")}<ExternalLink aria-hidden /></Button> : null}
      </div>
    </aside>
  );
}

function HudRelationGroup({ title, relations, outgoing, atomsById, onInspect }: { title: string; relations: readonly DeveloperAtomRelation[]; outgoing: boolean; atomsById: ReadonlyMap<string, DeveloperAtom>; onInspect: (id: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  const DirectionIcon = outgoing ? ArrowDownRight : ArrowUpRight;
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="space-y-2">
        {relations.map((relation) => {
          const related = atomsById.get(outgoing ? relation.targetId : relation.sourceId);
          return related ? (
            <div key={relation.id} className="rounded-lg border bg-card p-3 text-card-foreground">
              <div className="flex items-center gap-2">
                <DirectionIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-xs font-medium">{relationLabel(language, relation.kind)}</span>
                <button type="button" className="ms-auto min-w-0 truncate font-mono text-xs font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onInspect(related.id)}>{related.name}</button>
              </div>
              <code className="mt-2 block break-all rounded bg-muted/60 p-2 text-[10px] text-muted-foreground">{relation.sourceId.replace(":", "/")}{relation.pointer} = {JSON.stringify(relation.value)}</code>
            </div>
          ) : null;
        })}
      </div>
    </section>
  );
}
