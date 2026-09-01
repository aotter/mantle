import * as React from "react";
import dagre from "@dagrejs/dagre";
import { useQuery } from "@tanstack/react-query";
import {
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { Check, ChevronRight, Copy, Database, Eye, Search, type LucideIcon } from "lucide-react";

import "@xyflow/react/dist/style.css";

import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { resolveLocalizedText } from "../../lib/localized-text";
import { developerConsoleQueryOptions } from "../../lib/queries";
import type {
  DeveloperConsoleSnapshot,
  DeveloperSchemaModel,
  DeveloperViewModel,
  JsonSchema,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import { ErrorBox } from "../../ui/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SidebarContent, SidebarHeader, SidebarInput } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type ModelItem =
  | { kind: "Schema"; id: string; model: DeveloperSchemaModel }
  | { kind: "View"; id: string; model: DeveloperViewModel };

export interface SchemaFieldRow {
  path: string;
  type: string;
  required: boolean;
  constraints: string[];
}

export function flattenSchemaFields(schema: JsonSchema): SchemaFieldRow[] {
  const rows: SchemaFieldRow[] = [];
  const walk = (container: JsonSchema, prefix = ""): void => {
    const required = new Set(container.required ?? []);
    for (const [name, property] of Object.entries(container.properties ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      rows.push({ path, type: schemaType(property), required: required.has(name), constraints: schemaConstraints(property) });
      if (property.properties) walk(property, path);
      if (property.items?.properties) walk(property.items, `${path}[]`);
    }
  };
  walk(schema);
  return rows;
}

function schemaType(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (schema.type) return schema.type;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "—";
}

function schemaConstraints(schema: JsonSchema): string[] {
  const constraints: string[] = [];
  if (schema.enum) constraints.push(`enum: ${schema.enum.map(displayValue).join(" | ")}`);
  if (schema.format) constraints.push(`format: ${schema.format}`);
  if (schema.pattern) constraints.push(`pattern: ${schema.pattern}`);
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (schema[key] !== undefined) constraints.push(`${key}: ${schema[key]}`);
  }
  if (schema.default !== undefined) constraints.push(`default: ${displayValue(schema.default)}`);
  if (schema.readOnly) constraints.push("readOnly");
  if (schema.nullable) constraints.push("nullable");
  if (schema.additionalProperties === false) constraints.push("closed object");
  for (const key of ["x-mantle-bind", "x-mantle-ref", "x-mcp-hint"] as const) {
    if (schema[key]) constraints.push(`${key}: ${schema[key]}`);
  }
  return constraints;
}

function displayValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

export function DataModelView(): React.ReactElement {
  const { language } = usePreferences();
  const location = useAdminLocation();
  const { navigate } = useAdminRouter();
  const [search, setSearch] = React.useState("");
  const snapshot = useQuery(developerConsoleQueryOptions());
  const items: ModelItem[] = snapshot.data ? [
    ...snapshot.data.dataModel.schemas.map((model) => ({ kind: "Schema" as const, id: `Schema:${model.name}`, model })),
    ...snapshot.data.dataModel.views.map((model) => ({ kind: "View" as const, id: `View:${model.name}`, model })),
  ] : [];
  const requestedId = new URLSearchParams(location.search).get("selected");
  const selected = items.find((item) => item.id === requestedId) ?? items[0] ?? null;
  const query = search.trim().toLowerCase();
  const visibleItems = query
    ? items.filter((item) => `${item.kind} ${item.model.name} ${resolveLocalizedText(item.model.title, language) ?? ""}`.toLowerCase().includes(query))
    : items;
  const select = (id: string): void => navigate(`/admin/dev/model?selected=${encodeURIComponent(id)}`, { replace: true });

  if (snapshot.isError) return <div className="p-6"><ErrorBox error={snapshot.error} /></div>;
  if (snapshot.isLoading) return <Skeleton className="h-full w-full rounded-none" />;
  if (!snapshot.data || !selected) return <></>;

  return (
    <section className="grid h-full min-h-0 grid-cols-[15rem_minmax(0,1fr)]" aria-label={t(language, "model.title")}>
      <ModelSidebar items={visibleItems} selectedId={selected.id} search={search} onSearch={setSearch} onSelect={select} />
      <div className="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(28rem,1fr)_24rem] xl:grid-rows-1">
        <main className="min-w-0 overflow-y-auto border-b xl:border-e xl:border-b-0">
          {selected.kind === "Schema" ? <SchemaDefinition model={selected.model} /> : <ViewDefinition model={selected.model} />}
        </main>
        <RelatedAtomsGraph key={selected.id} selectedId={selected.id} graph={snapshot.data.graph} onSelect={select} />
      </div>
    </section>
  );
}

function ModelSidebar({ items, selectedId, search, onSearch, onSelect }: { items: ModelItem[]; selectedId: string; search: string; onSearch: (value: string) => void; onSelect: (id: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  return (
    <aside className="flex min-h-0 flex-col border-e bg-sidebar text-sidebar-foreground" aria-label={t(language, "model.objects")}>
      <SidebarHeader className="border-b border-sidebar-border">
        <label className="relative">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <span className="sr-only">{t(language, "model.search")}</span>
          <SidebarInput value={search} onChange={(event) => onSearch(event.currentTarget.value)} placeholder={t(language, "model.search")} className="ps-8" />
        </label>
      </SidebarHeader>
      <SidebarContent className="gap-0 p-2">
        <ModelGroup title={t(language, "model.schemas")} icon={Database} items={items.filter((item) => item.kind === "Schema")} selectedId={selectedId} onSelect={onSelect} />
        <ModelGroup title={t(language, "model.views")} icon={Eye} items={items.filter((item) => item.kind === "View")} selectedId={selectedId} onSelect={onSelect} />
      </SidebarContent>
    </aside>
  );
}

function ModelGroup({ title, icon: Icon, items, selectedId, onSelect }: { title: string; icon: LucideIcon; items: ModelItem[]; selectedId: string; onSelect: (id: string) => void }): React.ReactElement {
  return (
    <Collapsible defaultOpen className="group/model mb-1">
      <CollapsibleTrigger className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
        <Icon className="size-4" aria-hidden />
        <span className="flex-1 text-start">{title}</span>
        <span className="font-mono text-[10px] text-sidebar-foreground/60">{items.length}</span>
        <ChevronRight className="size-4 transition-transform group-data-[state=open]/model:rotate-90" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent className="ms-4 border-s border-sidebar-border ps-2">
        {items.map((item) => (
          <button key={item.id} type="button" onClick={() => onSelect(item.id)} aria-pressed={item.id === selectedId} className={cn("mt-1 block h-8 w-full truncate rounded-md px-2 text-start font-mono text-xs hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring", item.id === selectedId && "bg-sidebar-accent font-medium text-sidebar-accent-foreground")}>
            {item.model.name}
          </button>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function DefinitionHeader({ name, title }: { name: string; title: string | null }): React.ReactElement {
  return (
    <div className="flex min-h-14 items-center gap-3 border-b px-5 py-3">
      <h1 className="min-w-0 font-mono text-sm font-semibold">{name}</h1>
      {title && title !== name ? <span className="truncate text-sm text-muted-foreground">{title}</span> : null}
    </div>
  );
}

function SchemaDefinition({ model }: { model: DeveloperSchemaModel }): React.ReactElement {
  const { language } = usePreferences();
  const fields = flattenSchemaFields(model.schema);
  return (
    <>
      <DefinitionHeader name={model.name} title={resolveLocalizedText(model.title, language)} />
      <DefinitionTabs
        definitionLabel={t(language, "model.fields")}
        rawLabel={t(language, "model.rawSchema")}
        rawValue={model.schema}
      >
        <Table>
          <TableHeader><TableRow><TableHead className="ps-5">{t(language, "model.path")}</TableHead><TableHead>{t(language, "model.type")}</TableHead><TableHead>{t(language, "model.required")}</TableHead><TableHead>{t(language, "model.constraints")}</TableHead></TableRow></TableHeader>
          <TableBody>
            {fields.map((field) => (
              <TableRow key={field.path}>
                <TableCell className="ps-5 font-mono text-xs">{field.path}</TableCell>
                <TableCell><Badge variant="secondary" className="font-mono text-[10px]">{field.type}</Badge></TableCell>
                <TableCell>{field.required ? t(language, "common.yes") : "—"}</TableCell>
                <TableCell className="max-w-md whitespace-normal text-xs text-muted-foreground">{field.constraints.length ? field.constraints.join(" · ") : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!fields.length ? <p className="p-5 text-sm text-muted-foreground">{t(language, "model.noFields")}</p> : null}
      </DefinitionTabs>
    </>
  );
}

function ViewDefinition({ model }: { model: DeveloperViewModel }): React.ReactElement {
  const { language } = usePreferences();
  const query = model.query;
  return (
    <>
      <DefinitionHeader name={model.name} title={resolveLocalizedText(model.title, language)} />
      <DefinitionTabs definitionLabel={t(language, "model.queryKind")} rawLabel={t(language, "model.rawQuery")} rawValue={query}>
        <div className="space-y-5 p-5">
          <FactGrid entries={query.kind === "declarative" ? [
            [t(language, "model.queryKind"), query.kind],
            [t(language, "model.source"), query.from],
            [t(language, "model.fields"), query.fields?.join(", ") ?? t(language, "model.allFields")],
            [t(language, "model.order"), query.orderBy.length ? query.orderBy.map(({ field, direction }) => `${field} ${direction}`).join(", ") : "—"],
            [t(language, "model.limit"), query.limit?.toString() ?? "—"],
          ] : [
            [t(language, "model.queryKind"), query.kind],
            [t(language, "model.dialect"), query.dialect],
            [t(language, "model.limit"), query.limit?.toString() ?? "—"],
          ]} />
          {query.kind === "native" ? <CodeBlock value={query.statement} /> : null}
          {query.kind === "declarative" && query.filter ? <RawSection label={t(language, "model.filter")} value={query.filter} /> : null}
          {query.params ? <RawSection label={t(language, "model.params")} value={query.params} /> : null}
        </div>
      </DefinitionTabs>
    </>
  );
}

function RelatedAtomsGraph({ selectedId, graph, onSelect }: { selectedId: string; graph: DeveloperConsoleSnapshot["graph"]; onSelect: (id: string) => void }): React.ReactElement {
  const { language, theme } = usePreferences();
  const relations = graph.relations.filter(({ sourceId, targetId }) => sourceId === selectedId || targetId === selectedId);
  const ids = new Set([selectedId, ...relations.flatMap(({ sourceId, targetId }) => [sourceId, targetId])]);
  const atoms = graph.atoms.filter(({ id }) => ids.has(id));
  const layout = new dagre.graphlib.Graph({ multigraph: true }).setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 72, marginx: 16, marginy: 16 });
  atoms.forEach(({ id }) => layout.setNode(id, { width: 220, height: 76 }));
  relations.forEach(({ id, sourceId, targetId }) => layout.setEdge(sourceId, targetId, {}, id));
  dagre.layout(layout);
  const nodes: Node[] = atoms.map((atom) => {
    const position = layout.node(atom.id);
    const title = resolveLocalizedText(atom.title, language);
    const navigable = atom.kind === "Schema" || atom.kind === "View";
    return {
      id: atom.id,
      position: { x: position.x - 110, y: position.y - 38 },
      data: { label: <div className="min-w-0 space-y-1.5 text-start"><span className={cn("inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", atomKindTone[atom.kind])}>{atom.kind}</span><div><div className="truncate font-mono text-xs font-semibold">{atom.name}</div>{title && title !== atom.name ? <div className="truncate text-[10px] text-muted-foreground">{title}</div> : null}</div></div> },
      ariaLabel: `${atom.kind} ${atom.name}`,
      className: cn("!w-[220px] !rounded-xl !border-border/80 !bg-card !px-3 !py-2.5 !text-card-foreground !shadow-md transition-colors", atom.id === selectedId ? "!border-primary !bg-primary/10 !ring-2 !ring-primary/30" : "hover:!border-foreground/30", navigable && atom.id !== selectedId && "cursor-pointer"),
    };
  });
  const edges: Edge[] = relations.map(({ id, sourceId, targetId, label }) => ({
    id,
    source: sourceId,
    target: targetId,
    label: label.split(".").slice(-2).join("."),
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--muted-foreground)" },
    style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
    labelStyle: { fill: "var(--foreground)", fontFamily: "ui-monospace, monospace", fontSize: 10, fontWeight: 500 },
    labelShowBg: true,
    labelBgStyle: { fill: "var(--background)", fillOpacity: 0.95 },
    labelBgPadding: [5, 3],
    labelBgBorderRadius: 5,
  }));
  return (
    <aside className="flex min-h-0 flex-col" aria-label={t(language, "model.relatedAtoms")}>
      <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <h2 className="text-sm font-medium">{t(language, "model.relatedAtoms")}</h2>
        <span className="font-mono text-xs text-muted-foreground">{atoms.length - 1}</span>
      </div>
      <ReactFlow
        className="bg-muted/10"
        nodes={nodes}
        edges={edges}
        colorMode={theme}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.45}
        maxZoom={1.5}
        nodesConnectable={false}
        nodesDraggable={false}
        onNodeClick={(_, node) => {
          if (node.id.startsWith("Schema:") || node.id.startsWith("View:")) onSelect(node.id);
        }}
      >
        <Controls className="overflow-hidden rounded-lg border bg-background/90 shadow-sm" showInteractive={false} />
      </ReactFlow>
    </aside>
  );
}

function FactGrid({ entries }: { entries: Array<[string, string]> }): React.ReactElement {
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">{entries.map(([label, value]) => <React.Fragment key={label}><dt className="text-muted-foreground">{label}</dt><dd className="break-words font-mono text-foreground">{value}</dd></React.Fragment>)}</dl>;
}

function DefinitionTabs({ definitionLabel, rawLabel, rawValue, children }: { definitionLabel: string; rawLabel: string; rawValue: unknown; children: React.ReactNode }): React.ReactElement {
  const raw = JSON.stringify(rawValue, null, 2);
  return (
    <Tabs defaultValue="definition" className="gap-0">
      <TabsList variant="line" className="h-10 w-full justify-start rounded-none border-b px-5">
        <TabsTrigger value="definition" className="flex-none px-3">{definitionLabel}</TabsTrigger>
        <TabsTrigger value="raw" className="flex-none px-3">{rawLabel}</TabsTrigger>
      </TabsList>
      <TabsContent value="definition">{children}</TabsContent>
      <TabsContent value="raw" className="p-5"><div className="relative"><JsonCopyButton value={raw} label={rawLabel} /><CodeBlock value={raw} className="max-h-none pe-12" /></div></TabsContent>
    </Tabs>
  );
}

const atomKindTone = {
  Schema: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  View: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  Procedure: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  Trigger: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
} as const;

function JsonCopyButton({ value, label }: { value: string; label: string }): React.ReactElement {
  const { language } = usePreferences();
  const [copied, setCopied] = React.useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Button type="button" variant="secondary" size="icon-sm" className="absolute end-2 top-2 z-10 shadow-sm" onClick={() => void copy()} aria-label={`${t(language, "common.copy")} ${label}`} aria-pressed={copied}>
      {copied ? <Check className="text-[color:var(--success)]" aria-hidden /> : <Copy aria-hidden />}
    </Button>
  );
}

function RawSection({ label, value }: { label: string; value: unknown }): React.ReactElement {
  return <section><h3 className="mb-2 text-sm font-medium">{label}</h3><CodeBlock value={JSON.stringify(value, null, 2)} /></section>;
}

function CodeBlock({ value, className }: { value: string; className?: string }): React.ReactElement {
  return <pre className={cn("max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-5", className)}><code>{value}</code></pre>;
}
