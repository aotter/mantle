import * as React from "react";
import dagre from "@dagrejs/dagre";
import { BaseEdge, Handle, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, getSmoothStepPath, type Edge, type EdgeProps, type EdgeTypes, type Node, type NodeProps, type NodeTypes, type ReactFlowInstance, useEdgesState, useNodesInitialized, useNodesState } from "@xyflow/react";
import { ArrowDownNarrowWide, Columns3, Database, Diamond, Fingerprint, Info, KeyRound, Link, Search, ShieldCheck, Table2, X } from "lucide-react";

import { t } from "../../app/i18n";
import type { AdminLanguage } from "../../app/preferences";
import { usePreferences } from "../../app/preferences";
import { resolveLocalizedText } from "../../lib/localized-text";
import { mantleRefOf, type DeveloperAtomRelation, type DeveloperConsoleSnapshot, type DeveloperSchemaModel, type JsonSchema } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Badge } from "@aotter/mantle-ui/kit";
import { Button } from "@aotter/mantle-ui/kit";
import { flattenSchemaFields } from "./data-model-view";
import { GraphControls, graphCanvasClassName, relationLabel } from "./atom-graph";

// An ER diagram of the Schemas (#1890): one row per column with its key markers, edges from the referencing column to
// the referenced one, crow's-foot cardinality, and a layout that keeps tables without relations out of the way.
const nodeWidth = 300;
const headerHeight = 48;
const rowHeight = 26;

export type ErdMode = "all" | "keys" | "names";

/** One column of a table card. `name` is the field path (or the native column); handles are keyed by it. */
export interface ErdRow {
  name: string;
  type: string;
  system: boolean;
  required: boolean;
  primary: boolean;
  reference: { schema: string; field: string } | null;
  unique: string[] | null;
  indexed: boolean;
  scope: boolean;
  search: boolean;
}

type SchemaGraphNode = Node<{ model: DeveloperSchemaModel; rows: ErdRow[]; language: AdminLanguage; active: ReadonlySet<string> | null }, "schema">;
type ErdEdge = Edge<{ label: string; kind: DeveloperAtomRelation["kind"]; source: Cardinality; target: Cardinality; active: boolean; offset: number }, "erd">;
type Cardinality = "many" | "one" | "zeroOrOne";

const nodeTypes = { schema: SchemaNode } satisfies NodeTypes;
const edgeTypes = { erd: ErdRelationEdge } satisfies EdgeTypes;

export function SchemaDiagram({ snapshot, onOpen }: { snapshot: DeveloperConsoleSnapshot; onOpen: (id: string) => void }): React.ReactElement {
  return <ReactFlowProvider><SchemaDiagramCanvas snapshot={snapshot} onOpen={onOpen} /></ReactFlowProvider>;
}

function SchemaDiagramCanvas({ snapshot, onOpen }: { snapshot: DeveloperConsoleSnapshot; onOpen: (id: string) => void }): React.ReactElement {
  const { language, theme } = usePreferences();
  const [mode, setMode] = React.useState<ErdMode>("all");
  const [legend, setLegend] = React.useState(false);
  const layout = React.useMemo(() => buildSchemaDiagram(snapshot, language, mode), [snapshot, language, mode]);
  const [nodes, setNodes, onNodesChange] = useNodesState(layout.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layout.edges);
  const [flow, setFlow] = React.useState<ReactFlowInstance<SchemaGraphNode, ErdEdge> | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const nodesInitialized = useNodesInitialized();
  const fitted = React.useRef(false);

  React.useEffect(() => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
    setSelectedId(null);
    if (fitted.current) window.requestAnimationFrame(() => void flow?.fitView({ padding: 0.08, maxZoom: 1, duration: 240 }));
  }, [layout, setEdges, setNodes, flow]);

  React.useEffect(() => {
    if (flow && nodesInitialized && !fitted.current) {
      fitted.current = true;
      void flow.fitView({ padding: 0.08, maxZoom: 1 });
    }
  }, [flow, nodesInitialized]);

  // Selecting a table keeps it, its neighbours, the connecting edges and the rows at both ends of each edge.
  const select = (id: string | null): void => {
    setSelectedId(id);
    const rows = new Map<string, Set<string>>();
    const mark = (node: string, handle: string | null | undefined): void => {
      const set = rows.get(node) ?? rows.set(node, new Set()).get(node)!;
      if (handle) set.add(handle.split(":")[0]!);
    };
    if (id) {
      mark(id, null);
      layout.edges.forEach((edge) => {
        if (edge.source !== id && edge.target !== id) return;
        mark(edge.source, edge.sourceHandle);
        mark(edge.target, edge.targetHandle);
      });
    }
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === id, data: { ...node.data, active: id ? rows.get(node.id) ?? null : null }, style: { ...node.style, opacity: !id || rows.has(node.id) ? 1 : 0.2 } })));
    setEdges((current) => current.map((edge) => {
      const active = Boolean(id) && (edge.source === id || edge.target === id);
      return { ...edge, zIndex: active ? 1 : 0, style: { ...edge.style, opacity: !id || active ? 1 : 0.08 }, data: edge.data ? { ...edge.data, active } : edge.data };
    }));
  };

  const relayout = (): void => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
    setSelectedId(null);
    window.requestAnimationFrame(() => void flow?.fitView({ padding: 0.08, maxZoom: 1, duration: 240 }));
  };

  const modes: Array<[ErdMode, React.ComponentType<{ "aria-hidden"?: boolean }>]> = [["all", Columns3], ["keys", KeyRound], ["names", Table2]];
  return (
    <ReactFlow<SchemaGraphNode, ErdEdge>
      className={graphCanvasClassName}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={theme}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onInit={setFlow}
      onNodeClick={(_, node) => select(node.id)}
      onNodeDoubleClick={(_, node) => onOpen(node.id)}
      onPaneClick={() => select(null)}
      nodesConnectable={false}
      onlyRenderVisibleElements
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
      minZoom={0.15}
      maxZoom={1.8}
    >
      <CardinalityMarkers />
      <GraphControls onRelayout={relayout} />
      <Panel position="top-left" className="!m-3 flex gap-1 rounded-lg border bg-background/95 p-1 shadow-md" aria-label={t(language, "developer.erd.display")}>
        {modes.map(([value, Icon]) => (
          <Button key={value} type="button" size="sm" variant={mode === value ? "secondary" : "ghost"} aria-pressed={mode === value} onClick={() => setMode(value)}>
            <Icon aria-hidden />{t(language, `developer.erd.mode.${value}`)}
          </Button>
        ))}
        <Button type="button" size="sm" variant={legend ? "secondary" : "ghost"} aria-pressed={legend} aria-expanded={legend} onClick={() => setLegend((open) => !open)}>
          <Info aria-hidden />{t(language, "developer.erd.legend")}
        </Button>
      </Panel>
      {legend ? <Panel position="bottom-right" className="!mb-3 !mr-3"><ErdLegend /></Panel> : null}
      {layout.nodes.length > 8 ? <MiniMap pannable zoomable position="bottom-left" className="!mb-3 !ml-14 hidden overflow-hidden rounded-lg border shadow-md sm:block" style={{ width: 160, height: 110 }} nodeStrokeWidth={2} /> : null}
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

/** Native columns every row has (reference/schema "Reserved entry columns"); `status` and `published_at` only with publishing. */
function systemRows(model: DeveloperSchemaModel): Array<Pick<ErdRow, "name" | "type" | "required">> {
  return [
    { name: "author_id", type: "string", required: false },
    ...(model.lifecycle === "publishing" ? [{ name: "status", type: "string", required: true }, { name: "published_at", type: "date-time", required: false }] : []),
    { name: "version", type: "integer", required: true },
    { name: "created_at", type: "date-time", required: true },
    { name: "updated_at", type: "date-time", required: true },
  ];
}

/** The rows of a table card, all of them; `visibleRows` narrows them per display mode. */
export function erdRows(model: DeveloperSchemaModel): ErdRow[] {
  // Index, unique and search lists name storage columns: unquoted SQL folds a field name to lower case.
  const storage = (name: string): string => name.replace(/\./g, "_").toLowerCase();
  const unique = (name: string): string[] | null => model.uniqueIndexes.find((index) => index.includes(storage(name))) ?? null;
  const indexed = (name: string): boolean => model.indexes.some((index) => index.includes(storage(name)));
  const scope = typeof (model.manifest as { scope?: unknown } | null)?.scope === "string" ? (model.manifest as { scope: string }).scope : null;
  const property = (path: string): JsonSchema | undefined => path.split(".").reduce<JsonSchema | undefined>((schema, part) => schema?.properties?.[part], model.schema);
  const row = (name: string, type: string, required: boolean, system: boolean): ErdRow => ({
    name, type, required, system,
    primary: name === "id",
    reference: system ? null : mantleRefOf(property(name)),
    unique: system ? null : unique(name),
    indexed: indexed(name),
    scope: scope !== null && storage(name) === storage(scope),
    search: model.searchableFields.includes(storage(name)),
  });
  return [
    row("id", "string", true, true),
    ...flattenSchemaFields(model.schema).map((field) => row(field.path, field.type, field.required, false)),
    ...systemRows(model).map((column) => row(column.name, column.type, column.required, true)),
  ];
}

// Bookkeeping columns every row has; folded into one summary row unless one carries an index or an edge.
const bookkeeping = new Set(["author_id", "version", "created_at", "updated_at"]);

function visibleRows(rows: ErdRow[], mode: ErdMode, targeted: ReadonlySet<string>): ErdRow[] {
  if (mode === "names") return [];
  if (mode === "all") {
    const folded = rows.filter((row) => bookkeeping.has(row.name) && !targeted.has(row.name));
    const kept = rows.filter((row) => !folded.includes(row));
    return folded.length ? [...kept, { name: folded.map(({ name }) => name).join(" · "), type: "", system: true, required: true, primary: false, reference: null, unique: null, indexed: folded.some(({ indexed }) => indexed), scope: false, search: false }] : kept;
  }
  return rows.filter((row) => row.primary || row.reference || row.unique || row.scope || targeted.has(row.name));
}

export function buildSchemaDiagram(snapshot: DeveloperConsoleSnapshot, language: AdminLanguage, mode: ErdMode = "all"): { nodes: SchemaGraphNode[]; edges: ErdEdge[] } {
  const schemas = snapshot.dataModel.schemas;
  const byName = new Map(schemas.map((model) => [model.name, model]));
  const allRows = new Map(schemas.map((model) => [model.name, erdRows(model)]));
  const relations = snapshot.graph.relations.filter((relation) => (relation.kind === "schema-reference" || relation.kind === "translation-parent") && byName.has(relation.sourceId.slice(7)) && byName.has(relation.targetId.slice(7)));

  // Each relation joins a source column to a target column: a reference field to the column it names (`id` unless the
  // ref names another), and a translation's shared key to the same key on its parent.
  const ends = relations.map((relation) => {
    const source = byName.get(relation.sourceId.slice(7))!;
    if (relation.kind === "translation-parent") {
      const on = source.translates?.on ?? "id";
      return { relation, sourceColumn: on, targetColumn: on };
    }
    const sourceColumn = referenceField(relation.pointer);
    const reference = allRows.get(source.name)!.find((row) => row.name === sourceColumn)?.reference;
    return { relation, sourceColumn, targetColumn: reference?.field ?? "id" };
  });
  const targeted = new Map<string, Set<string>>();
  ends.forEach(({ relation, targetColumn, sourceColumn }) => {
    (targeted.get(relation.targetId) ?? targeted.set(relation.targetId, new Set()).get(relation.targetId)!).add(targetColumn);
    if (relation.kind === "translation-parent") (targeted.get(relation.sourceId) ?? targeted.set(relation.sourceId, new Set()).get(relation.sourceId)!).add(sourceColumn);
  });
  const rows = new Map(schemas.map((model) => [model.name, visibleRows(allRows.get(model.name)!, mode, targeted.get(`Schema:${model.name}`) ?? new Set())]));
  const height = (name: string): number => headerHeight + rows.get(name)!.length * rowHeight;

  // Referenced tables sit to the left of the tables that point at them; tables without relations go in a grid below.
  const related = new Set(relations.flatMap(({ sourceId, targetId }) => [sourceId, targetId]));
  const graph = new dagre.graphlib.Graph({ multigraph: true }).setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 120, edgesep: 16, ranker: "network-simplex" });
  schemas.filter(({ name }) => related.has(`Schema:${name}`)).forEach(({ name }) => graph.setNode(`Schema:${name}`, { width: nodeWidth, height: height(name) }));
  relations.forEach(({ id, sourceId, targetId }) => { if (sourceId !== targetId) graph.setEdge(targetId, sourceId, {}, id); });
  dagre.layout(graph);
  const positions = new Map<string, { x: number; y: number }>();
  graph.nodes().forEach((id) => { const { x, y, height: h } = graph.node(id); positions.set(id, { x: x - nodeWidth / 2, y: y - h / 2 }); });
  const bottom = Math.max(0, ...[...positions].map(([id, { y }]) => y + height(id.slice(7))));
  const loose = schemas.filter(({ name }) => !related.has(`Schema:${name}`));
  const columns = Math.max(1, Math.min(loose.length, Math.ceil(Math.sqrt(loose.length * 2))));
  let rowTop = positions.size ? bottom + 96 : 0;
  for (let start = 0; start < loose.length; start += columns) {
    const line = loose.slice(start, start + columns);
    line.forEach(({ name }, index) => positions.set(`Schema:${name}`, { x: index * (nodeWidth + 36), y: rowTop }));
    rowTop += Math.max(...line.map(({ name }) => height(name))) + 36;
  }

  const handle = (schema: string, column: string): string => (rows.get(schema)!.some((row) => row.name === column) ? column : "@");
  const pairs = new Map<string, number>();
  return {
    nodes: schemas.map((model) => {
      const id = `Schema:${model.name}`;
      return {
        id,
        type: "schema",
        position: positions.get(id) ?? { x: 0, y: 0 },
        data: { model, rows: rows.get(model.name)!, language, active: null },
        style: { width: nodeWidth, height: height(model.name) },
        ariaLabel: `${model.name} schema`,
      };
    }),
    edges: ends.map(({ relation, sourceColumn, targetColumn }) => {
      const source = byName.get(relation.sourceId.slice(7))!;
      const target = relation.targetId.slice(7);
      const from = positions.get(relation.sourceId)!, to = positions.get(relation.targetId)!;
      // Leave and enter on the facing sides; a table that references itself loops out and back on its right.
      const self = relation.sourceId === relation.targetId;
      const sourceSide = self || from.x <= to.x ? "r" : "l";
      const targetSide = self ? "r" : from.x <= to.x ? "l" : "r";
      const sourceRow = allRows.get(source.name)!.find((row) => row.name === sourceColumn);
      const translation = relation.kind === "translation-parent";
      // A reference alone in a unique index is one-to-one; otherwise many rows point at one. An optional reference
      // points at zero or one.
      const sourceCardinality: Cardinality = !translation && sourceRow?.unique?.length === 1 ? "one" : "many";
      const targetCardinality: Cardinality = translation || sourceRow?.required ? "one" : "zeroOrOne";
      const pair = [relation.sourceId, relation.targetId].sort().join("|");
      const index = pairs.get(pair) ?? 0;
      pairs.set(pair, index + 1);
      const label = relationText(relation, language);
      return {
        id: relation.id,
        source: relation.sourceId,
        target: relation.targetId,
        sourceHandle: `${handle(source.name, sourceColumn)}:s:${sourceSide}`,
        targetHandle: `${handle(target, targetColumn)}:t:${targetSide}`,
        type: "erd",
        data: { label, kind: relation.kind, source: sourceCardinality, target: targetCardinality, active: false, offset: 24 + index * 14 },
        style: translation ? { strokeDasharray: "6 4" } : {},
        ariaLabel: `${label}: ${source.name}.${sourceColumn} to ${target}.${targetColumn}`,
      };
    }),
  };
}

function SchemaNode({ data, selected }: NodeProps<SchemaGraphNode>): React.ReactElement {
  const { language } = usePreferences();
  const title = resolveLocalizedText(data.model.title, data.language);
  const anchors = (id: string, top?: number): React.ReactElement => (
    <>
      {(["l", "r"] as const).flatMap((side) => (["s", "t"] as const).map((kind) => (
        <Handle key={`${kind}${side}`} id={`${id}:${kind}:${side}`} type={kind === "s" ? "source" : "target"} position={side === "l" ? Position.Left : Position.Right} isConnectable={false} className="!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-transparent" style={top === undefined ? undefined : { top }} />
      )))}
    </>
  );
  return (
    <section className={cn("h-full overflow-hidden rounded-lg border bg-white text-card-foreground shadow-md dark:bg-[#0a1124]", selected ? "border-blue-500 ring-2 ring-blue-500/30 dark:border-blue-300" : "border-slate-300 dark:border-slate-700")}>
      <header className="relative flex h-[48px] items-center gap-2 border-b bg-slate-100 px-3 dark:bg-slate-800/60">
        {anchors("@")}
        <Table2 className="size-4 shrink-0 text-blue-600 dark:text-blue-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <strong className="block truncate font-mono text-sm">{data.model.name}</strong>
          {title && title !== data.model.name ? <span className="block truncate text-[11px] text-muted-foreground">{title}</span> : null}
        </div>
        {data.model.lifecycle === "publishing" ? <Badge variant="outline" className="shrink-0 text-[10px]">{t(language, "developer.erd.publishing")}</Badge> : null}
        {data.model.translates ? <Badge variant="outline" className="shrink-0 text-[10px]">{t(language, "developer.erd.translation")}</Badge> : null}
      </header>
      <ul>
        {data.rows.map((row) => {
          const active = data.active?.has(row.name);
          return (
            <li key={row.name} className={cn("relative flex h-[26px] items-center gap-1.5 border-b px-2 text-xs last:border-b-0", row.system && "bg-slate-50/70 text-muted-foreground dark:bg-slate-900/40", active && "bg-blue-500/15 text-foreground dark:bg-blue-400/20")}>
              {anchors(row.name, rowHeight / 2)}
              <span className="flex w-[52px] shrink-0 items-center gap-0.5"><RowMarkers row={row} language={language} /></span>
              <span className={cn("min-w-0 flex-1 truncate font-mono", (row.primary || row.reference) && "font-semibold")}>{row.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{row.type}</span>
              {row.type ? <RequiredMarker row={row} language={language} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RowMarkers({ row, language }: { row: ErdRow; language: AdminLanguage }): React.ReactElement {
  const icon = (key: string, Icon: typeof KeyRound, label: string, className: string): React.ReactElement => (
    <span key={key} title={label} role="img" aria-label={label} className="inline-flex"><Icon className={cn("size-3.5", className)} aria-hidden /></span>
  );
  return (
    <>
      {row.primary ? icon("pk", KeyRound, t(language, "developer.erd.primaryKey"), "text-amber-500") : null}
      {row.reference ? icon("fk", Link, t(language, "developer.erd.references", { target: `${row.reference.schema}.${row.reference.field}` }), "text-violet-500") : null}
      {row.unique ? icon("uq", Fingerprint, row.unique.length > 1 ? t(language, "developer.erd.uniqueWith", { fields: row.unique.join(", ") }) : t(language, "developer.erd.unique"), row.unique.length > 1 ? "text-sky-500/70" : "text-sky-500") : null}
      {row.indexed && !row.primary ? icon("ix", ArrowDownNarrowWide, t(language, "developer.erd.indexed"), "text-emerald-500") : null}
      {row.scope ? icon("sc", ShieldCheck, t(language, "developer.erd.scope"), "text-rose-500") : null}
      {row.search ? icon("se", Search, t(language, "developer.erd.searchable"), "text-slate-500") : null}
    </>
  );
}

function RequiredMarker({ row, language }: { row: ErdRow; language: AdminLanguage }): React.ReactElement {
  const label = t(language, row.required ? "developer.erd.required" : "developer.erd.optional");
  return <span title={label} role="img" aria-label={label} className="inline-flex"><Diamond className={cn("size-3", row.required ? "fill-current text-slate-500" : "text-slate-400")} aria-hidden /></span>;
}

function ErdLegend(): React.ReactElement {
  const { language } = usePreferences();
  const items: Array<[typeof KeyRound, string, string]> = [
    [KeyRound, "text-amber-500", t(language, "developer.erd.primaryKey")],
    [Link, "text-violet-500", t(language, "developer.erd.reference")],
    [Fingerprint, "text-sky-500", t(language, "developer.erd.unique")],
    [ArrowDownNarrowWide, "text-emerald-500", t(language, "developer.erd.indexed")],
    [ShieldCheck, "text-rose-500", t(language, "developer.erd.scope")],
    [Search, "text-slate-500", t(language, "developer.erd.searchable")],
  ];
  const line = (start: Cardinality, end: Cardinality, dashed = false): React.ReactElement => (
    <svg width="64" height="14" aria-hidden><line x1="6" y1="7" x2="58" y2="7" stroke="var(--muted-foreground)" strokeWidth="1.5" strokeDasharray={dashed ? "6 4" : undefined} markerStart={`url(#erd-${start})`} markerEnd={`url(#erd-${end})`} /></svg>
  );
  return (
    <aside className="w-64 rounded-lg border bg-background/95 p-3 text-xs shadow-md" aria-label={t(language, "developer.erd.legend")}>
      <ul className="grid gap-1.5">
        {items.map(([Icon, tone, label]) => <li key={label} className="flex items-center gap-2"><Icon className={cn("size-3.5", tone)} aria-hidden />{label}</li>)}
        <li className="flex items-center gap-2"><Diamond className="size-3 fill-current text-slate-500" aria-hidden />{t(language, "developer.erd.required")}<Diamond className="ml-2 size-3 text-slate-400" aria-hidden />{t(language, "developer.erd.optional")}</li>
        <li className="flex items-center gap-2">{line("many", "one")}{t(language, "developer.erd.manyToOne")}</li>
        <li className="flex items-center gap-2">{line("many", "zeroOrOne")}{t(language, "developer.erd.manyToOptional")}</li>
        <li className="flex items-center gap-2">{line("one", "one")}{t(language, "developer.erd.oneToOne")}</li>
        <li className="flex items-center gap-2">{line("many", "one", true)}{t(language, "developer.erd.translates")}</li>
      </ul>
    </aside>
  );
}

/** Crow's-foot markers, drawn for the path's end and reversed at its start; `-active` variants follow the highlight. */
function CardinalityMarkers(): React.ReactElement {
  const shapes: Record<Cardinality, React.ReactElement> = {
    many: <path d="M12,7 L0,7 M12,1 L4,7 L12,13 M2,1 L2,13" fill="none" />,
    one: <path d="M12,7 L0,7 M5,1 L5,13 M9,1 L9,13" fill="none" />,
    zeroOrOne: <><path d="M12,7 L10,7 M9,1 L9,13" fill="none" /><circle cx="4.5" cy="7" r="3" fill="var(--background)" /></>,
  };
  return (
    <svg className="absolute size-0" aria-hidden>
      <defs>
        {(["", "-active"] as const).flatMap((variant) => (Object.keys(shapes) as Cardinality[]).map((kind) => (
          <marker key={kind + variant} id={`erd-${kind}${variant}`} viewBox="0 0 14 14" markerWidth="14" markerHeight="14" refX="12" refY="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <g stroke={variant ? "var(--color-blue-500, #3b82f6)" : "var(--muted-foreground)"} strokeWidth="1.5">{shapes[kind]}</g>
          </marker>
        )))}
      </defs>
    </svg>
  );
}

function ErdRelationEdge({ id, data, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style }: EdgeProps<ErdEdge>): React.ReactElement {
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 10, offset: data?.offset ?? 24 });
  const suffix = data?.active ? "-active" : "";
  return (
    <BaseEdge
      id={id}
      path={path}
      markerStart={`url(#erd-${data?.source ?? "many"}${suffix})`}
      markerEnd={`url(#erd-${data?.target ?? "one"}${suffix})`}
      style={{ stroke: data?.active ? "var(--color-blue-500, #3b82f6)" : "var(--muted-foreground)", strokeWidth: data?.active ? 2 : 1.25, transition: "opacity 180ms ease", ...style }}
    />
  );
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
