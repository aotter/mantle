import * as React from "react";
import dagre from "@dagrejs/dagre";
import { Handle, MarkerType, Panel, Position, ReactFlow, ReactFlowProvider, type Node, type NodeProps, type NodeTypes, type ReactFlowInstance, useEdgesState, useNodesInitialized, useNodesState } from "@xyflow/react";
import { Database, Link2, X } from "lucide-react";

import { t } from "../../app/i18n";
import type { AdminLanguage } from "../../app/preferences";
import { usePreferences } from "../../app/preferences";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { DeveloperAtomRelation, DeveloperConsoleSnapshot, DeveloperSchemaModel } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { flattenSchemaFields } from "./data-model-view";
import { GraphControls, graphCanvasClassName, manifestEdgeTypes, relationLabel, type ManifestGraphEdge } from "./atom-graph";

const nodeWidth = 280;
const headerHeight = 54;
const fieldHeight = 30;

type SchemaGraphNode = Node<{ model: DeveloperSchemaModel; language: AdminLanguage }, "schema">;

const nodeTypes = { schema: SchemaNode } satisfies NodeTypes;

export function SchemaDiagram({ snapshot, onOpen }: { snapshot: DeveloperConsoleSnapshot; onOpen: (id: string) => void }): React.ReactElement {
  return <ReactFlowProvider><SchemaDiagramCanvas snapshot={snapshot} onOpen={onOpen} /></ReactFlowProvider>;
}

function SchemaDiagramCanvas({ snapshot, onOpen }: { snapshot: DeveloperConsoleSnapshot; onOpen: (id: string) => void }): React.ReactElement {
  const { language, theme } = usePreferences();
  const layout = React.useMemo(() => buildSchemaDiagram(snapshot, language), [snapshot, language]);
  const [nodes, setNodes, onNodesChange] = useNodesState(layout.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layout.edges);
  const [flow, setFlow] = React.useState<ReactFlowInstance<SchemaGraphNode, ManifestGraphEdge> | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const nodesInitialized = useNodesInitialized();
  const fitted = React.useRef(false);

  React.useEffect(() => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
    setSelectedId(null);
  }, [layout, setEdges, setNodes]);

  React.useEffect(() => {
    if (flow && nodesInitialized && !fitted.current) {
      fitted.current = true;
      void flow.fitView({ padding: 0.12, maxZoom: 1 });
    }
  }, [flow, nodesInitialized]);

  const select = (id: string | null): void => {
    setSelectedId(id);
    const related = new Set(id ? [id] : []);
    if (id) layout.edges.forEach((edge) => {
      if (edge.source === id || edge.target === id) related.add(edge.source).add(edge.target);
    });
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === id, style: { ...node.style, opacity: !id || related.has(node.id) ? 1 : 0.18 } })));
    setEdges((current) => current.map((edge) => {
      const active = !id || edge.source === id || edge.target === id;
      return { ...edge, style: { ...edge.style, opacity: active ? 1 : 0.08 }, data: edge.data ? { ...edge.data, opacity: active ? 1 : 0.08 } : edge.data };
    }));
  };

  const relayout = (): void => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
    setSelectedId(null);
    window.requestAnimationFrame(() => void flow?.fitView({ padding: 0.12, maxZoom: 1, duration: 240 }));
  };

  return (
    <ReactFlow<SchemaGraphNode, ManifestGraphEdge>
      className={graphCanvasClassName}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={manifestEdgeTypes}
      colorMode={theme}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onInit={setFlow}
      onNodeClick={(_, node) => select(node.id)}
      onNodeDoubleClick={(_, node) => onOpen(node.id)}
      onPaneClick={() => select(null)}
      nodesConnectable={false}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      minZoom={0.35}
      maxZoom={1.8}
    >
      <GraphControls onRelayout={relayout} />
      {selectedId ? <Panel position="top-right" className="!m-3 w-72 max-w-[calc(100%-1.5rem)]"><SchemaHud model={snapshot.dataModel.schemas.find(({ name }) => `Schema:${name}` === selectedId)} relationCount={layout.edges.filter(({ source, target }) => source === selectedId || target === selectedId).length} onClose={() => select(null)} onOpen={() => onOpen(selectedId)} /></Panel> : null}
    </ReactFlow>
  );
}

function SchemaHud({ model, relationCount, onClose, onOpen }: { model: DeveloperSchemaModel | undefined; relationCount: number; onClose: () => void; onOpen: () => void }): React.ReactElement | null {
  const { language } = usePreferences();
  if (!model) return null;
  const fields = flattenSchemaFields(model.schema);
  const title = resolveLocalizedText(model.title, language);
  return <aside className="overflow-hidden rounded-xl border bg-white text-popover-foreground shadow-2xl dark:bg-[#090f20]" aria-label={t(language, "developer.graph.details")}><header className="flex items-start gap-3 border-b p-4"><div className="min-w-0 flex-1"><Badge variant="outline">{t(language, "developer.graph.kind.schema")}</Badge><h2 className="mt-2 truncate font-mono text-sm font-semibold">{model.name}</h2>{title && title !== model.name ? <p className="mt-1 truncate text-xs text-muted-foreground">{title}</p> : null}</div><Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label={t(language, "common.close")}><X aria-hidden /></Button></header><div className="space-y-4 p-4"><dl className="grid grid-cols-2 gap-3"><div><dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{t(language, "model.fields")}</dt><dd className="mt-1 font-mono text-sm font-semibold">{fields.length}</dd></div><div><dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{t(language, "model.relationships")}</dt><dd className="mt-1 font-mono text-sm font-semibold">{relationCount}</dd></div></dl><Button type="button" className="w-full" variant="outline" onClick={onOpen}><Database aria-hidden />{t(language, "developer.graph.openModel")}</Button></div></aside>;
}

export function buildSchemaDiagram(snapshot: DeveloperConsoleSnapshot, language: AdminLanguage): { nodes: SchemaGraphNode[]; edges: ManifestGraphEdge[] } {
  const schemas = snapshot.dataModel.schemas;
  const schemaIds = new Set(schemas.map(({ name }) => `Schema:${name}`));
  const relations = snapshot.graph.relations.filter((relation) => schemaIds.has(relation.sourceId) && schemaIds.has(relation.targetId) && (relation.kind === "schema-reference" || relation.kind === "translation-parent"));
  const graph = new dagre.graphlib.Graph({ multigraph: true }).setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", nodesep: 48, ranksep: 100, edgesep: 24 });
  schemas.forEach((model) => graph.setNode(`Schema:${model.name}`, { width: nodeWidth, height: schemaNodeHeight(model) }));
  relations.forEach(({ id, sourceId, targetId }) => graph.setEdge(sourceId, targetId, {}, id));
  dagre.layout(graph);

  return {
    nodes: schemas.map((model) => {
      const id = `Schema:${model.name}`;
      const height = schemaNodeHeight(model);
      const position = graph.node(id) ?? { x: nodeWidth / 2, y: height / 2 };
      return {
        id,
        type: "schema",
        position: { x: position.x - nodeWidth / 2, y: position.y - height / 2 },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: { model, language },
        style: { width: nodeWidth, height },
        ariaLabel: `${model.name} schema`,
      };
    }),
    edges: relations.map((relation) => ({
      id: relation.id,
      source: relation.sourceId,
      target: relation.targetId,
      type: "manifest",
      data: { kind: relation.kind, label: relationText(relation, language), opacity: 1 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--muted-foreground)" },
      style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
      ariaLabel: `${relationText(relation, language)}: ${relation.sourceId} to ${relation.targetId}`,
    })),
  };
}

function SchemaNode({ data, selected }: NodeProps<SchemaGraphNode>): React.ReactElement {
  const fields = flattenSchemaFields(data.model.schema);
  const title = resolveLocalizedText(data.model.title, data.language);
  return (
    <section className={cn("h-full overflow-hidden rounded-xl border-2 border-blue-400/70 bg-white text-card-foreground shadow-lg dark:bg-[#0a1124]", selected && "border-blue-500 ring-2 ring-blue-500/30 dark:border-blue-300 dark:ring-blue-400/45")}>
      <Handle type="target" position={Position.Left} className="!bg-blue-500" />
      <header className="flex h-[54px] flex-col justify-center border-b border-blue-400/30 bg-blue-500/10 px-3">
        <strong className="truncate font-mono text-sm">{data.model.name}</strong>
        {title && title !== data.model.name ? <span className="truncate text-xs text-muted-foreground">{title}</span> : null}
      </header>
      {fields.map((field) => (
        <div key={field.pointer} className="flex h-[30px] items-center gap-2 border-b px-3 text-xs last:border-b-0">
          <span className={cn("min-w-0 flex-1 truncate font-mono", field.required && "font-semibold")}>{field.path}</span>
          {field.reference ? <Link2 className="size-3.5 shrink-0 text-violet-500" aria-hidden /> : null}
          <span className="shrink-0 font-mono text-muted-foreground">{field.type}</span>
        </div>
      ))}
      <Handle type="source" position={Position.Right} className="!bg-blue-500" />
    </section>
  );
}

function schemaNodeHeight(model: DeveloperSchemaModel): number {
  return headerHeight + Math.max(flattenSchemaFields(model.schema).length, 1) * fieldHeight;
}

function relationText(relation: DeveloperAtomRelation, language: AdminLanguage): string {
  const field = relation.kind === "schema-reference" ? referenceField(relation.pointer) : null;
  return field ? `${field} · ${relationLabel(language, relation.kind)}` : relationLabel(language, relation.kind);
}

function referenceField(pointer: string): string {
  const parts = pointer.split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  const fields: string[] = [];
  parts.forEach((part, index) => {
    if (part === "properties" && parts[index + 1]) fields.push(parts[index + 1]!);
  });
  return fields.join(".");
}
