import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Database, Eye, Search } from "lucide-react";

import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { resolveLocalizedText } from "../../lib/localized-text";
import { developerConsoleQueryOptions } from "../../lib/queries";
import type {
  DeveloperConsoleSnapshot,
  DeveloperSchemaModel,
  DeveloperSurface,
  DeveloperViewModel,
  JsonSchema,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import { ErrorBox, PageHeader } from "../../ui/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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
  const [kind, setKind] = React.useState<"all" | ModelItem["kind"]>("all");
  const snapshot = useQuery(developerConsoleQueryOptions());
  const items: ModelItem[] = snapshot.data ? [
    ...snapshot.data.dataModel.schemas.map((model) => ({ kind: "Schema" as const, id: `Schema:${model.name}`, model })),
    ...snapshot.data.dataModel.views.map((model) => ({ kind: "View" as const, id: `View:${model.name}`, model })),
  ] : [];
  const requestedId = new URLSearchParams(location.search).get("selected");
  const selected = items.find((item) => item.id === requestedId) ?? items[0] ?? null;
  const query = search.trim().toLowerCase();
  const visibleItems = items.filter((item) => {
    const title = resolveLocalizedText(item.model.title, language) ?? "";
    return (kind === "all" || item.kind === kind)
      && (!query || `${item.kind} ${item.model.name} ${title}`.toLowerCase().includes(query));
  });
  const select = (id: string): void => navigate(`/admin/dev/model?selected=${encodeURIComponent(id)}`, { replace: true });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t(language, "model.eyebrow")}
        title={t(language, "model.title")}
        description={t(language, "model.description")}
        actions={<Button asChild variant="outline"><a href="/admin/dev"><ArrowLeft className="size-4" aria-hidden />{t(language, "model.back")}</a></Button>}
      />
      {snapshot.isError ? <ErrorBox error={snapshot.error} /> : null}
      {snapshot.isLoading ? <Skeleton className="h-[40rem] w-full rounded-xl" /> : null}
      {snapshot.data && selected ? (
        <section className="overflow-hidden rounded-xl border bg-card/55" aria-label={t(language, "model.workbench")}>
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <Database className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-sm font-medium">{t(language, "model.workbench")}</span>
            <Badge variant="secondary">{snapshot.data.dataModel.schemas.length} {t(language, "model.schemas")}</Badge>
            <Badge variant="outline">{snapshot.data.dataModel.views.length} {t(language, "model.views")}</Badge>
            <code className="ms-auto hidden max-w-48 truncate text-[10px] text-muted-foreground lg:block" title={snapshot.data.fingerprint}>{snapshot.data.fingerprint}</code>
          </div>
          <div className="grid min-h-[40rem] lg:grid-cols-[15rem_minmax(28rem,1fr)_18rem]">
            <aside className="border-b lg:border-b-0 lg:border-e" aria-label={t(language, "model.objects")}>
              <div className="space-y-3 border-b p-3">
                <label className="relative block">
                  <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <span className="sr-only">{t(language, "model.search")}</span>
                  <Input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder={t(language, "model.search")} className="ps-9" />
                </label>
                <div className="flex gap-1">
                  {(["all", "Schema", "View"] as const).map((value) => (
                    <Button key={value} type="button" size="sm" variant={kind === value ? "default" : "outline"} className="h-7 px-2 text-xs" onClick={() => setKind(value)}>
                      {value === "all" ? t(language, "model.all") : value}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="max-h-72 overflow-auto p-2 lg:max-h-[calc(100svh-20rem)]">
                {visibleItems.length ? visibleItems.map((item) => {
                  const Icon = item.kind === "Schema" ? Database : Eye;
                  return (
                    <button key={item.id} type="button" onClick={() => select(item.id)} aria-pressed={item.id === selected.id} className={cn("mb-1 flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", item.id === selected.id ? "border-border bg-accent" : "hover:bg-muted/70")}>
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-xs font-medium">{item.model.name}</span>
                        <span className="block text-[11px] text-muted-foreground">{item.kind}</span>
                      </span>
                    </button>
                  );
                }) : <p className="p-4 text-center text-sm text-muted-foreground">{t(language, "model.noResults")}</p>}
              </div>
            </aside>
            <main className="min-w-0 border-b lg:border-b-0 lg:border-e">
              {selected.kind === "Schema" ? <SchemaDefinition model={selected.model} /> : <ViewDefinition model={selected.model} />}
            </main>
            {selected.kind === "Schema"
              ? <SchemaInspector model={selected.model} snapshot={snapshot.data} onSelect={select} />
              : <ViewInspector model={selected.model} onSelect={select} />}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function DefinitionHeader({ kind, name, title, description }: { kind: ModelItem["kind"]; name: string; title: string | null; description?: string | null }): React.ReactElement {
  return (
    <div className="border-b p-5">
      <div className="flex items-center gap-2"><Badge variant="outline">{kind}</Badge><code className="font-semibold">{name}</code></div>
      {title && title !== name ? <h2 className="mt-3 text-xl font-semibold">{title}</h2> : null}
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}

function SchemaDefinition({ model }: { model: DeveloperSchemaModel }): React.ReactElement {
  const { language } = usePreferences();
  const fields = flattenSchemaFields(model.schema);
  return (
    <>
      <DefinitionHeader kind="Schema" name={model.name} title={resolveLocalizedText(model.title, language)} description={resolveLocalizedText(model.description, language)} />
      <div className="p-5">
        <h3 className="font-semibold">{t(language, "model.fields")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t(language, "model.fieldsBody")}</p>
      </div>
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
      <RawDefinition label={t(language, "model.rawSchema")} value={model.schema} />
    </>
  );
}

function ViewDefinition({ model }: { model: DeveloperViewModel }): React.ReactElement {
  const { language } = usePreferences();
  const query = model.query;
  return (
    <>
      <DefinitionHeader kind="View" name={model.name} title={resolveLocalizedText(model.title, language)} />
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
      <RawDefinition label={t(language, "model.rawQuery")} value={query} />
    </>
  );
}

function SchemaInspector({ model, snapshot, onSelect }: { model: DeveloperSchemaModel; snapshot: DeveloperConsoleSnapshot; onSelect: (id: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  const views = snapshot.dataModel.views.filter((view) => {
    const query = view.query;
    return query.kind === "declarative" && query.from === model.name;
  });
  const surfaces = snapshot.surfaces.filter((surface) => surface.ownerId === `Schema:${model.name}`);
  return (
    <aside className="space-y-5 p-4">
      <InspectorSection title={t(language, "model.behavior")}>
        <FactGrid entries={[
          [t(language, "model.lifecycle"), model.lifecycle],
          [t(language, "model.localized"), model.localized ? t(language, "common.yes") : t(language, "common.no")],
          [t(language, "model.translation"), model.translates ? `${model.translates.parent} · ${model.translates.on}` : "—"],
        ]} />
      </InspectorSection>
      <InspectorSection title={t(language, "model.indexes")}>
        <StringList label={t(language, "model.unique")} items={model.uniqueIndexes.map((fields) => fields.join(" + "))} />
        <StringList label={t(language, "model.nonUnique")} items={model.indexes.map((fields) => fields.join(" + "))} />
        <StringList label={t(language, "model.searchable")} items={model.searchableFields} />
      </InspectorSection>
      <InspectorSection title={t(language, "model.relatedViews")}>
        {views.length ? views.map((view) => <ModelLink key={view.name} label={view.name} onClick={() => onSelect(`View:${view.name}`)} />) : <Empty />}
      </InspectorSection>
      <InspectorSection title={t(language, "model.surfaces")}>
        {surfaces.length ? surfaces.map((surface) => <SurfaceItem key={surface.id} surface={surface} />) : <Empty />}
      </InspectorSection>
    </aside>
  );
}

function ViewInspector({ model, onSelect }: { model: DeveloperViewModel; onSelect: (id: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  const source = model.query.kind === "declarative" ? model.query.from : null;
  return (
    <aside className="space-y-5 p-4">
      <InspectorSection title={t(language, "model.access")}>
        <FactGrid entries={[
          [t(language, "model.surface"), model.surface],
          [t(language, "model.guard"), model.guard ?? "—"],
        ]} />
        {model.authorization.length ? <CodeBlock value={JSON.stringify(model.authorization, null, 2)} /> : <p className="text-xs text-muted-foreground">{t(language, "model.noAuth")}</p>}
      </InspectorSection>
      {source ? (
        <InspectorSection title={t(language, "model.sourceSchema")}>
          <ModelLink label={source} onClick={() => onSelect(`Schema:${source}`)} />
        </InspectorSection>
      ) : null}
    </aside>
  );
}

function FactGrid({ entries }: { entries: Array<[string, string]> }): React.ReactElement {
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">{entries.map(([label, value]) => <React.Fragment key={label}><dt className="text-muted-foreground">{label}</dt><dd className="break-words font-mono text-foreground">{value}</dd></React.Fragment>)}</dl>;
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return <section><h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</h2><div className="space-y-2">{children}</div></section>;
}

function StringList({ label, items }: { label: string; items: string[] }): React.ReactElement {
  return <div className="rounded-lg border bg-muted/20 p-2.5"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-1 text-xs">{items.length ? items.map((item) => <code key={item} className="me-1 inline-block rounded bg-background px-1.5 py-0.5">{item}</code>) : "—"}</div></div>;
}

function ModelLink({ label, onClick }: { label: string; onClick: () => void }): React.ReactElement {
  return <button type="button" onClick={onClick} className="flex w-full items-center gap-2 rounded-lg border bg-muted/20 p-2.5 text-start font-mono text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Eye className="size-3.5 text-muted-foreground" aria-hidden />{label}</button>;
}

function SurfaceItem({ surface }: { surface: DeveloperSurface }): React.ReactElement {
  return <div className="rounded-lg border bg-muted/20 p-2.5"><div className="flex gap-1"><Badge variant="secondary" className="text-[10px]">{surface.kind}</Badge>{surface.visibility ? <Badge variant="outline" className="text-[10px]">{surface.visibility}</Badge> : null}</div><code className="mt-2 block break-words text-xs">{surface.name}</code></div>;
}

function RawDefinition({ label, value }: { label: string; value: unknown }): React.ReactElement {
  return <details className="border-t p-5"><summary className="cursor-pointer text-sm font-medium">{label}</summary><div className="mt-3"><CodeBlock value={JSON.stringify(value, null, 2)} /></div></details>;
}

function RawSection({ label, value }: { label: string; value: unknown }): React.ReactElement {
  return <section><h3 className="mb-2 text-sm font-medium">{label}</h3><CodeBlock value={JSON.stringify(value, null, 2)} /></section>;
}

function CodeBlock({ value }: { value: string }): React.ReactElement {
  return <pre className="max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-5"><code>{value}</code></pre>;
}

function Empty(): React.ReactElement {
  const { language } = usePreferences();
  return <p className="text-xs text-muted-foreground">{t(language, "model.none")}</p>;
}
