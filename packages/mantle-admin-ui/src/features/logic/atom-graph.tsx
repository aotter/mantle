import * as React from "react";
import dagre from "@dagrejs/dagre";
import {
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import { t } from "../../app/i18n";
import type { AdminLanguage } from "../../app/preferences";
import { usePreferences } from "../../app/preferences";
import { resolveLocalizedText } from "../../lib/localized-text";
import type {
  DeveloperAtom,
  DeveloperConsoleSnapshot,
  DeveloperRelationKind,
} from "../../lib/types";
import { cn } from "../../lib/utils";

export const atomKindTone = {
  Schema: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  View: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  Procedure: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  Trigger: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
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
  onSelect,
}: {
  graph: DeveloperConsoleSnapshot["graph"];
  onSelect: (atom: DeveloperAtom) => void;
}): React.ReactElement {
  const { language, theme } = usePreferences();
  const { nodes, edges } = React.useMemo(() => layoutGraph(graph, language), [graph, language]);
  const atomsById = React.useMemo(() => new Map(graph.atoms.map((atom) => [atom.id, atom])), [graph.atoms]);

  return (
    <ReactFlow
      className="bg-background"
      nodes={nodes}
      edges={edges}
      colorMode={theme}
      fitView
      fitViewOptions={{ padding: 0.16 }}
      minZoom={0.2}
      maxZoom={1.6}
      nodesConnectable={false}
      nodesDraggable={false}
      onNodeClick={(_, node) => {
        const atom = atomsById.get(node.id);
        if (atom && (atom.kind === "Schema" || atom.kind === "View")) onSelect(atom);
      }}
    >
      <Controls className="overflow-hidden rounded-lg border bg-background/90 shadow-sm" showInteractive={false} />
    </ReactFlow>
  );
}

function layoutGraph(
  graph: DeveloperConsoleSnapshot["graph"],
  language: AdminLanguage,
): { nodes: Node[]; edges: Edge[] } {
  const layout = new dagre.graphlib.Graph({ multigraph: true }).setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 96, marginx: 48, marginy: 48 });
  graph.atoms.forEach(({ id }) => layout.setNode(id, { width: 200, height: 68 }));
  graph.relations.forEach(({ id, sourceId, targetId }) => layout.setEdge(sourceId, targetId, {}, id));
  dagre.layout(layout);

  return {
    nodes: graph.atoms.map((atom) => {
      const position = layout.node(atom.id);
      const title = resolveLocalizedText(atom.title, language);
      const navigable = atom.kind === "Schema" || atom.kind === "View";
      return {
        id: atom.id,
        position: { x: position.x - 100, y: position.y - 34 },
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
          "!h-[68px] !w-[200px] !rounded-xl !border-border/80 !bg-card !px-3 !py-2 !text-card-foreground !shadow-md",
          navigable && "cursor-pointer transition-colors hover:!border-primary/60 hover:!ring-2 hover:!ring-primary/15",
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
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--muted-foreground)" },
      style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
      labelStyle: { fill: "var(--foreground)", fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: "var(--background)", fillOpacity: 0.94 },
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 5,
    } satisfies Edge)),
  };
}
