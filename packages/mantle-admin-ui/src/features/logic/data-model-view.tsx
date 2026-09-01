import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  Braces,
  Check,
  ChevronRight,
  Copy,
  Database,
  Eye,
  KeyRound,
  Languages,
  Link2,
  ListTree,
  Search,
  type LucideIcon,
} from "lucide-react";

import { t } from "../../app/i18n";
import type { AdminLanguage } from "../../app/preferences";
import { usePreferences } from "../../app/preferences";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { resolveLocalizedText } from "../../lib/localized-text";
import { developerConsoleQueryOptions } from "../../lib/queries";
import type {
  DeveloperAtom,
  DeveloperAtomRelation,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { atomKindTone, relationLabel } from "./atom-graph";

type ModelItem =
  | { kind: "Schema"; id: string; model: DeveloperSchemaModel }
  | { kind: "View"; id: string; model: DeveloperViewModel };

export interface SchemaFieldRow {
  path: string;
  pointer: string;
  type: string;
  required: boolean;
  constraints: string[];
  reference: string | null;
}

export type SchemaFieldMarker =
  | { kind: "reference"; target: string; sourceId: string; pointer: string }
  | { kind: "translation"; target: string; direction: "outgoing" | "incoming"; sourceId: string; pointer: string }
  | { kind: "unique"; index: number; fields: string[]; sourceId: string; pointer: string }
  | { kind: "index"; index: number; fields: string[]; sourceId: string; pointer: string };

export function flattenSchemaFields(schema: JsonSchema): SchemaFieldRow[] {
  const rows: SchemaFieldRow[] = [];
  const walk = (container: JsonSchema, prefix = "", pointer = "/spec/schema"): void => {
    const required = new Set(container.required ?? []);
    for (const [name, property] of Object.entries(container.properties ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      const fieldPointer = `${pointer}/properties/${jsonPointerSegment(name)}`;
      rows.push({
        path,
        pointer: fieldPointer,
        type: schemaType(property),
        required: required.has(name),
        constraints: schemaConstraints(property),
        reference: typeof property["x-mantle-ref"] === "string" ? property["x-mantle-ref"] : null,
      });
      if (property.properties) walk(property, path, fieldPointer);
      if (property.items?.properties) walk(property.items, `${path}[]`, `${fieldPointer}/items`);
    }
  };
  walk(schema);
  return rows;
}

export function schemaFieldMarkers(
  field: SchemaFieldRow,
  model: DeveloperSchemaModel,
  schemas: readonly DeveloperSchemaModel[],
): SchemaFieldMarker[] {
  const sourceId = `Schema:${model.name}`;
  return [
    ...(field.reference ? [{ kind: "reference" as const, target: field.reference, sourceId, pointer: `${field.pointer}/x-mantle-ref` }] : []),
    ...(model.translates?.on === field.path ? [{ kind: "translation" as const, target: `${model.translates.parent}.${field.path}`, direction: "outgoing" as const, sourceId, pointer: "/spec/translates" }] : []),
    ...schemas.flatMap((schema) => schema.translates?.parent === model.name && schema.translates.on === field.path
      ? [{ kind: "translation" as const, target: `${schema.name}.${field.path}`, direction: "incoming" as const, sourceId: `Schema:${schema.name}`, pointer: "/spec/translates" }]
      : []),
    ...model.uniqueIndexes.flatMap((fields, index) => fields.includes(field.path)
      ? [{ kind: "unique" as const, index, fields, sourceId, pointer: `/spec/uniqueIndexes/${index}` }]
      : []),
    ...model.indexes.flatMap((fields, index) => fields.includes(field.path)
      ? [{ kind: "index" as const, index, fields, sourceId, pointer: `/spec/indexes/${index}` }]
      : []),
  ];
}

function jsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
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
  for (const key of ["x-mantle-bind", "x-mcp-hint"] as const) {
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
  const params = new URLSearchParams(location.search);
  const requestedId = params.get("selected");
  const selected = items.find((item) => item.id === requestedId) ?? items[0] ?? null;
  const manifestOpen = params.get("tab") === "manifest";
  const manifestFocus = manifestOpen ? params.get("pointer") : null;
  const query = search.trim().toLowerCase();
  const visibleItems = query
    ? items.filter((item) => `${item.kind} ${item.model.name} ${resolveLocalizedText(item.model.title, language) ?? ""}`.toLowerCase().includes(query))
    : items;
  const modelIds = new Set(items.map(({ id }) => id));
  const select = (id: string): void => navigate(`/admin/dev/model?selected=${encodeURIComponent(id)}`, { replace: true });
  const openManifest = (id: string, pointer: string): void => {
    if (!modelIds.has(id)) return;
    navigate(`/admin/dev/model?selected=${encodeURIComponent(id)}&tab=manifest&pointer=${encodeURIComponent(pointer)}`, { replace: true });
  };

  if (snapshot.isError) return <div className="p-6"><ErrorBox error={snapshot.error} /></div>;
  if (snapshot.isLoading) return <Skeleton className="h-full w-full rounded-none" />;
  if (!snapshot.data || !selected) return <></>;

  return (
    <section className="grid h-full min-h-0 grid-cols-[15rem_minmax(0,1fr)]" aria-label={t(language, "model.title")}>
      <ModelSidebar items={visibleItems} selectedId={selected.id} search={search} onSearch={setSearch} onSelect={select} />
      <div className="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(28rem,1fr)_24rem] xl:grid-rows-1">
        <main className="min-w-0 overflow-y-auto border-b xl:border-e xl:border-b-0">
          {selected.kind === "Schema"
            ? <SchemaDefinition key={`${selected.id}:${manifestFocus ?? ""}`} model={selected.model} schemas={snapshot.data.dataModel.schemas} manifestOpen={manifestOpen} manifestFocus={manifestFocus} onOpenManifest={openManifest} />
            : <ViewDefinition key={`${selected.id}:${manifestFocus ?? ""}`} model={selected.model} manifestOpen={manifestOpen} manifestFocus={manifestFocus} />}
        </main>
        <RelatedAtomsList selectedId={selected.id} graph={snapshot.data.graph} modelIds={modelIds} onSelect={select} onOpenManifest={openManifest} />
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

function SchemaDefinition({ model, schemas, manifestOpen, manifestFocus, onOpenManifest }: { model: DeveloperSchemaModel; schemas: readonly DeveloperSchemaModel[]; manifestOpen: boolean; manifestFocus: string | null; onOpenManifest: (id: string, pointer: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  const fields = flattenSchemaFields(model.schema);
  return (
    <>
      <DefinitionHeader name={model.name} title={resolveLocalizedText(model.title, language)} />
      <DefinitionTabs definitionLabel={t(language, "model.fields")} rawLabel={t(language, "model.rawSchema")} rawValue={model.schema} manifestValue={model.manifest} manifestOpen={manifestOpen} manifestFocus={manifestFocus}>
        <Table>
          <TableHeader><TableRow><TableHead className="ps-5">{t(language, "model.path")}</TableHead><TableHead>{t(language, "model.type")}</TableHead><TableHead>{t(language, "model.required")}</TableHead><TableHead>{t(language, "model.constraints")}</TableHead></TableRow></TableHeader>
          <TableBody>
            {fields.map((field) => (
              <TableRow key={field.path}>
                <TableCell className="ps-5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">{field.path}</span>
                    <FieldMarkers markers={schemaFieldMarkers(field, model, schemas)} onOpenManifest={onOpenManifest} />
                  </div>
                </TableCell>
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

function FieldMarkers({ markers, onOpenManifest }: { markers: readonly SchemaFieldMarker[]; onOpenManifest: (id: string, pointer: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  return <span className="inline-flex items-center gap-1">{markers.map((marker) => {
    const presentation = markerPresentation(language, marker);
    const Icon = presentation.icon;
    return (
      <Tooltip key={`${marker.kind}:${marker.sourceId}:${marker.pointer}`}>
        <TooltipTrigger asChild>
          <button type="button" className={cn("inline-flex h-5 items-center gap-1 rounded border px-1 font-mono text-[9px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", presentation.tone)} aria-label={presentation.label} onClick={() => onOpenManifest(marker.sourceId, marker.pointer)}>
            <Icon className="size-3" aria-hidden />
            {presentation.short ? <span>{presentation.short}</span> : null}
          </button>
        </TooltipTrigger>
        <TooltipContent>{presentation.label}</TooltipContent>
      </Tooltip>
    );
  })}</span>;
}

function markerPresentation(language: AdminLanguage, marker: SchemaFieldMarker): { icon: LucideIcon; label: string; short: string | null; tone: string } {
  if (marker.kind === "reference") return { icon: Link2, label: t(language, "model.marker.reference", { target: marker.target }), short: null, tone: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300" };
  if (marker.kind === "translation") return { icon: Languages, label: t(language, marker.direction === "outgoing" ? "model.marker.translationParent" : "model.marker.translationChild", { target: marker.target }), short: null, tone: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300" };
  if (marker.kind === "unique") return { icon: KeyRound, label: t(language, "model.marker.unique", { index: String(marker.index + 1), fields: marker.fields.join(" + ") }), short: `UQ${marker.index + 1}`, tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" };
  return { icon: ListTree, label: t(language, "model.marker.index", { index: String(marker.index + 1), fields: marker.fields.join(" + ") }), short: `IDX${marker.index + 1}`, tone: "border-border bg-muted/60 text-muted-foreground" };
}

function ViewDefinition({ model, manifestOpen, manifestFocus }: { model: DeveloperViewModel; manifestOpen: boolean; manifestFocus: string | null }): React.ReactElement {
  const { language } = usePreferences();
  const query = model.query;
  return (
    <>
      <DefinitionHeader name={model.name} title={resolveLocalizedText(model.title, language)} />
      <DefinitionTabs definitionLabel={t(language, "model.queryKind")} rawLabel={t(language, "model.rawQuery")} rawValue={query} manifestValue={model.manifest} manifestOpen={manifestOpen} manifestFocus={manifestFocus}>
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

function RelatedAtomsList({ selectedId, graph, modelIds, onSelect, onOpenManifest }: { selectedId: string; graph: DeveloperConsoleSnapshot["graph"]; modelIds: ReadonlySet<string>; onSelect: (id: string) => void; onOpenManifest: (id: string, pointer: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  const atoms = new Map(graph.atoms.map((atom) => [atom.id, atom]));
  const outgoing = graph.relations.filter(({ sourceId }) => sourceId === selectedId);
  const incoming = graph.relations.filter(({ targetId }) => targetId === selectedId);
  const count = outgoing.length + incoming.length;
  return (
    <aside className="flex min-h-0 flex-col" aria-label={t(language, "model.relationships")}>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-sm font-medium">{t(language, "model.relationships")}</h2>
        <span className="font-mono text-xs text-muted-foreground">{count}</span>
        <Button asChild variant="ghost" size="sm" className="ms-auto">
          <a href="/admin/dev"><Braces aria-hidden />{t(language, "model.openGraph")}</a>
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {outgoing.length ? <RelationGroup title={t(language, "model.references")} relations={outgoing} outgoing atoms={atoms} modelIds={modelIds} onSelect={onSelect} onOpenManifest={onOpenManifest} /> : null}
        {incoming.length ? <RelationGroup title={t(language, "model.referencedBy")} relations={incoming} outgoing={false} atoms={atoms} modelIds={modelIds} onSelect={onSelect} onOpenManifest={onOpenManifest} /> : null}
        {!count ? <p className="text-sm text-muted-foreground">{t(language, "model.noRelations")}</p> : null}
      </div>
    </aside>
  );
}

function RelationGroup({ title, relations, outgoing, atoms, modelIds, onSelect, onOpenManifest }: { title: string; relations: readonly DeveloperAtomRelation[]; outgoing: boolean; atoms: ReadonlyMap<string, DeveloperAtom>; modelIds: ReadonlySet<string>; onSelect: (id: string) => void; onOpenManifest: (id: string, pointer: string) => void }): React.ReactElement {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="space-y-2">
        {relations.map((relation) => {
          const relatedId = outgoing ? relation.targetId : relation.sourceId;
          const atom = atoms.get(relatedId);
          return atom ? <RelationCard key={relation.id} relation={relation} atom={atom} outgoing={outgoing} canSelect={modelIds.has(relatedId)} canOpenManifest={modelIds.has(relation.sourceId)} onSelect={onSelect} onOpenManifest={onOpenManifest} /> : null;
        })}
      </div>
    </section>
  );
}

function RelationCard({ relation, atom, outgoing, canSelect, canOpenManifest, onSelect, onOpenManifest }: { relation: DeveloperAtomRelation; atom: DeveloperAtom; outgoing: boolean; canSelect: boolean; canOpenManifest: boolean; onSelect: (id: string) => void; onOpenManifest: (id: string, pointer: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  const title = resolveLocalizedText(atom.title, language);
  const DirectionIcon = outgoing ? ArrowDownRight : ArrowUpRight;
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex min-w-0 items-center gap-2">
        <DirectionIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className={cn("inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", atomKindTone[atom.kind])}>{atom.kind}</span>
        {canSelect ? <button type="button" onClick={() => onSelect(atom.id)} className="min-w-0 truncate font-mono text-xs font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{atom.name}</button> : <span className="min-w-0 truncate font-mono text-xs font-semibold">{atom.name}</span>}
      </div>
      {title && title !== atom.name ? <div className="mt-1 truncate ps-5 text-xs text-muted-foreground">{title}</div> : null}
      <div className="mt-2 text-xs font-medium">{relationLabel(language, relation.kind)}</div>
      {canOpenManifest ? (
        <button type="button" onClick={() => onOpenManifest(relation.sourceId, relation.pointer)} className="mt-2 block w-full rounded-md bg-muted/50 p-2 text-start hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t(language, "model.openDeclaration")}>
          <code className="block truncate text-[10px] text-muted-foreground">{relation.sourceId.replace(":", "/")}</code>
          <code className="mt-0.5 block break-all text-[10px]">{relation.pointer} = {JSON.stringify(relation.value)}</code>
        </button>
      ) : (
        <div className="mt-2 rounded-md bg-muted/50 p-2">
          <code className="block truncate text-[10px] text-muted-foreground">{relation.sourceId.replace(":", "/")}</code>
          <code className="mt-0.5 block break-all text-[10px]">{relation.pointer} = {JSON.stringify(relation.value)}</code>
        </div>
      )}
    </div>
  );
}

function FactGrid({ entries }: { entries: Array<[string, string]> }): React.ReactElement {
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">{entries.map(([label, value]) => <React.Fragment key={label}><dt className="text-muted-foreground">{label}</dt><dd className="break-words font-mono text-foreground">{value}</dd></React.Fragment>)}</dl>;
}

function DefinitionTabs({ definitionLabel, rawLabel, rawValue, manifestValue, manifestOpen, manifestFocus, children }: { definitionLabel: string; rawLabel: string; rawValue: unknown; manifestValue: unknown; manifestOpen: boolean; manifestFocus: string | null; children: React.ReactNode }): React.ReactElement {
  const { language } = usePreferences();
  const [value, setValue] = React.useState(manifestOpen ? "manifest" : "definition");
  return (
    <Tabs value={value} onValueChange={setValue} className="gap-0">
      <TabsList variant="line" className="h-10 w-full justify-start rounded-none border-b px-5">
        <TabsTrigger value="definition" className="flex-none px-3">{definitionLabel}</TabsTrigger>
        <TabsTrigger value="raw" className="flex-none px-3">{rawLabel}</TabsTrigger>
        <TabsTrigger value="manifest" className="flex-none px-3">{t(language, "model.manifest")}</TabsTrigger>
      </TabsList>
      <TabsContent value="definition">{children}</TabsContent>
      <TabsContent value="raw"><CodeTab value={rawValue} label={rawLabel} /></TabsContent>
      <TabsContent value="manifest"><CodeTab value={manifestValue} label={t(language, "model.compiledManifest")} focus={manifestFocus} /></TabsContent>
    </Tabs>
  );
}

function CodeTab({ value, label, focus }: { value: unknown; label: string; focus?: string | null }): React.ReactElement {
  const raw = JSON.stringify(value, null, 2) ?? "";
  return (
    <div className="space-y-3 p-5">
      {focus ? <div className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2"><div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div><code className="mt-1 block break-all text-xs font-medium text-foreground">{focus}</code></div> : null}
      <div className="relative"><JsonCopyButton value={raw} label={label} /><CodeBlock value={raw} className="max-h-none pe-12" /></div>
    </div>
  );
}

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
  return <section><h3 className="mb-2 text-sm font-medium">{label}</h3><CodeBlock value={JSON.stringify(value, null, 2) ?? ""} /></section>;
}

function CodeBlock({ value, className }: { value: string; className?: string }): React.ReactElement {
  return <pre className={cn("max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-5", className)}><code>{value}</code></pre>;
}
