import * as React from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api, downloadAdminFile } from "../../lib/api";
import { pagedQueryOptions, viewsManifestQueryOptions } from "../../lib/queries";
import { fieldLabel, propertyLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { Collection, JsonSchema, SiteInfo, ViewManifestInfo } from "../../lib/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aotter/mantle-ui/kit";
import { Skeleton } from "@aotter/mantle-ui/kit";
import { EmptyState, ErrorBox, LoadMore, PageHeader, SectionCard } from "../../ui/page";
import { Button } from "@aotter/mantle-ui/kit";
import { Badge } from "@aotter/mantle-ui/kit";
import { SchemaFields } from "../content/entry-edit-view";
import { withNativeSchema } from "../../lib/render-data-value";
import { DataCell } from "../../ui/data-cell";
import { enumOptions, optionLabel } from "../../lib/enum-options";
import { ListQueryToolbar } from "../../ui/list-query-toolbar";

const VIEW_PAGE_SIZE = 50;

/** One page of a View: its rows and the cursor to the next page, if there is one (ADR-0032 decision 5). */
interface ViewQueryResult {
  rows: Array<Record<string, unknown>>;
  nextCursor?: string;
}

/** Fetch an admin View while preserving its declared query parameters. */
export async function fetchView(
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ViewQueryResult> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  const suffix = qs.toString();
  const res = await fetch(`/admin/api/views/${encodeURIComponent(name)}${suffix ? `?${suffix}` : ""}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  const body = (await res.json().catch(() => null)) as ViewQueryResult | { error?: { message?: string } } | null;
  if (!res.ok || !body || !("rows" in body)) throw new Error(body && "error" in body && body.error?.message ? body.error.message : `${res.status} ${res.statusText}`);
  return body;
}

/** Render a read-only View with schema-driven parameters and formatting. */
export function ViewPage({ name }: { name: string }): React.ReactElement {
  const { language } = usePreferences();
  const { navigate } = useAdminRouter();
  const location = useAdminLocation();
  const exportFile = useMutation({ mutationFn: (path: string) => downloadAdminFile(path), meta: { invalidates: false } });
  const urlParams = React.useMemo(() => new URLSearchParams(location.search), [location.search]);
  const viewsQuery = useQuery<ViewManifestInfo[]>(viewsManifestQueryOptions());
  const collectionsQuery = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await api.get<{ collections: Collection[] }>("/collections");
      return res.collections;
    },
  });
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const canonical = site.data?.canonicalLocale ?? null;

  const view = viewsQuery.data?.find((v) => v.name === name);
  // an output that reads a Schema field unchanged is labelled and formatted as that field
  const columnSchema = (column: string) => {
    const source = view?.columns?.[column];
    return source ? withNativeSchema(source.field, collectionsQuery.data?.find((c) => c.name === source.schema)?.schema?.properties?.[source.field]) : undefined;
  };

  // a field's title names only an output under the field's own name: `sum(price) AS total` reads as Total, formatted as a price
  const labelSchema = (column: string) => {
    const schema = columnSchema(column);
    return schema && view?.columns?.[column]?.field !== column ? { ...schema, title: undefined } : schema;
  };

  const [params, setParams] = React.useState<Record<string, unknown>>({});
  React.useEffect(() => {
    setParams(readViewParams(view?.input, urlParams));
  }, [view?.name, view?.input, location.search]);
  const canQuery = hasRequiredViewParams(view?.input, urlParams);

  const query = useInfiniteQuery({
    ...pagedQueryOptions(["view", name, location.search], async (cursor, signal) => {
      const page = await fetchView(name, { ...Object.fromEntries(urlParams), cursor, limit: VIEW_PAGE_SIZE }, signal);
      return { rows: page.rows, next_cursor: page.nextCursor ?? null };
    }),
    enabled: !!view && canQuery,
  });

  if (viewsQuery.isLoading || collectionsQuery.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (viewsQuery.isError) return <ErrorBox error={viewsQuery.error} />;
  if (!view) {
    return (
      <div className="space-y-6">
        <PageHeader title={t(language, "views.notFound.title")} />
      </div>
    );
  }

  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  const columns = viewColumns(view, rows);
  const viewTitle = resolveLocalizedText(view.title, language, canonical) ?? fieldLabel(view.name);
  const exportHref = viewExportHref(name, urlParams);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<Badge variant="secondary">{t(language, "views.adminReport")}</Badge>}
        title={viewTitle}
        description={resolveLocalizedText(view.description, language, canonical) ?? t(language, "views.page.body", { schema: view.name })}
        actions={
          <Button
            type="button"
            variant="secondary"
            disabled={!canQuery || exportFile.isPending}
            onClick={() => exportFile.mutate(exportHref)}
          >
            <Download className="size-4" aria-hidden />
            {t(language, "collection.export")}
          </Button>
        }
      />

      {exportFile.isError ? <ErrorBox error={exportFile.error} /> : null}

      {view.input ? (
        <SectionCard className="space-y-4">
          <h2 className="text-sm font-semibold">{t(language, "views.params.title")}</h2>
          <SchemaFields
            schema={view.input}
            value={params}
            path={[]}
            onChange={setParams}
            language={language}
            canonical={canonical}
            collectionName={view.name}
            mediaPurposes={[]}
          />
          <Button
            type="button"
            onClick={() => { navigate(viewParamsHref(name, urlParams, view.input!, params)); }}
            disabled={query.isFetching}
          >
            <Search className="size-4" aria-hidden />
            {query.isFetching ? t(language, "views.running") : t(language, "views.run")}
          </Button>
        </SectionCard>
      ) : null}

      {(view.list.searchFields.length > 0 || view.list.filterFields.length > 0) ? (
        <ListQueryToolbar
          key={location.search}
          language={language}
          searchable={view.list.searchFields.length > 0}
          searchValue={urlParams.get("search") ?? ""}
          filters={view.list.filterFields.map((field) => {
            // a filter on an output with options is tabs, as on a collection list; its links start from the first page
            const options = enumOptions(columnSchema(field));
            const href = (value?: string) => {
              const next = new URLSearchParams(urlParams);
              next.delete("cursor");
              if (value) next.set(`filter.${field}`, value); else next.delete(`filter.${field}`);
              return viewHref(name, next);
            };
            return {
              name: field,
              label: propertyLabel(field, labelSchema(field), language, canonical),
              value: urlParams.get(`filter.${field}`) ?? "",
              ...(options ? { allHref: href(), options: options.map((o) => ({ value: o.value, label: optionLabel(columnSchema(field), o.value, language, canonical), href: href(o.value) })) } : {}),
            };
          })}
          onSubmit={({ search, filters }) => {
            // a new search starts from the first page: the cursors belong to the old one
            const next = new URLSearchParams(urlParams);
            next.delete("cursor");
            if (search) next.set("search", search); else next.delete("search");
            for (const field of view.list.filterFields) {
              const value = filters[field] ?? "";
              if (value) next.set(`filter.${field}`, value); else next.delete(`filter.${field}`);
            }
            navigate(viewHref(name, next));
          }}
        />
      ) : null}

      {query.isError && !query.data ? <ErrorBox error={query.error} /> : null}
      {query.isLoading ? <Skeleton className="h-48 w-full" /> : null}

      {query.data && rows.length === 0 ? (
        <EmptyState title={t(language, "views.empty.title")} description={t(language, "views.empty.body")} />
      ) : null}

      {rows.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead key={col}>
                  {propertyLabel(col, labelSchema(col), language, canonical)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={typeof row["id"] === "string" ? row["id"] : index}>
                {columns.map((col) => {
                  const schema = columnSchema(col);
                  const value = row[col];
                  return (
                    <TableCell key={col} className="text-muted-foreground">
                      <DataCell names={[...(view?.columns?.[col] ? [`cell:${view.columns[col].schema}.${view.columns[col].field}`] : []), `cell:view:${name}.${col}`]} field={col} value={value} row={row} property={schema} />
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <LoadMore query={query} count={rows.length} language={language} />
    </div>
  );
}

export function readViewParams(
  schema: JsonSchema | null | undefined,
  query: URLSearchParams,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    const raw = query.get(name);
    if (raw === null) continue;
    // `type: ["integer", "null"]` is an integer that may be left out
    const type = [property.type].flat().find((t) => t !== "null");
    if (type === "integer" || type === "number") values[name] = Number(raw);
    else if (type === "boolean") values[name] = raw === "true";
    else values[name] = raw;
  }
  return values;
}

function hasRequiredViewParams(
  schema: JsonSchema | null | undefined,
  query: URLSearchParams,
): boolean {
  return (schema?.required ?? []).every((name) => query.has(name));
}

function viewParamsHref(
  name: string,
  query: URLSearchParams,
  schema: JsonSchema,
  values: Record<string, unknown>,
): string {
  const next = new URLSearchParams(query);
  for (const field of Object.keys(schema.properties ?? {})) {
    next.delete(field);
    const value = values[field];
    if (value !== undefined && value !== null && value !== "") next.set(field, String(value));
  }
  // new input starts from the first page
  next.delete("cursor");
  return viewHref(name, next);
}

/** The export runs the View with the same input, from the first row. */
function viewExportHref(name: string, query: URLSearchParams): string {
  const next = new URLSearchParams(query);
  next.delete("cursor");
  const suffix = next.toString();
  return `/admin/api/views/${encodeURIComponent(name)}/export${suffix ? `?${suffix}` : ""}`;
}

function viewHref(name: string, query: URLSearchParams): string {
  const suffix = query.toString();
  return `/admin/views/${encodeURIComponent(name)}${suffix ? `?${suffix}` : ""}`;
}

/** The View's `uiSchema.list.columns` when it declares them, else the columns its rows carry, in order. */
function viewColumns(view: ViewManifestInfo, rows: ReadonlyArray<Record<string, unknown>>): string[] {
  if (view.list.columns.length > 0) return [...view.list.columns];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}
