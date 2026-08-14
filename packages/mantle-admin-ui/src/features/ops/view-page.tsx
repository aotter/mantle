import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { useAdminLocation } from "../../app/router";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { viewsManifestQueryOptions } from "../../lib/queries";
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
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { Button } from "@/components/ui/button";
import { SchemaFields } from "../content/entry-edit-view";
import { renderDataValue } from "../../lib/render-data-value";
import { cn } from "../../lib/utils";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { ListQueryToolbar } from "../../ui/list-query-toolbar";

const VIEW_PAGE_SIZE = 50;

interface ViewQueryResult {
  ok: true;
  data: {
    rows: Array<Record<string, unknown>>;
    page: number;
    show: number;
    hasMore: boolean;
  };
}

/** Fetch a staff View while preserving its declared query parameters. */
async function fetchView(
  name: string,
  params: Record<string, unknown>,
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
  });
  const body = (await res.json()) as ViewQueryResult | { ok: false; diagnostic: { message: string } };
  if (!res.ok || !body.ok) {
    const message = "diagnostic" in body ? body.diagnostic.message : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return body;
}

/** Render a read-only View with schema-driven parameters and formatting. */
export function ViewPage({ name }: { name: string }): React.ReactElement {
  const { language } = usePreferences();
  const location = useAdminLocation();
  const urlParams = React.useMemo(() => new URLSearchParams(location.search), [location.search]);
  const currentPage = positiveInt(urlParams.get("page")) ?? 1;
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
  const sourceSchema = collectionsQuery.data?.find((c) => c.name === view?.from)?.schema;

  const [params, setParams] = React.useState<Record<string, unknown>>({});
  React.useEffect(() => {
    setParams(readViewParams(view?.params, urlParams));
  }, [view?.name, view?.params, location.search]);
  const canQuery = hasRequiredViewParams(view?.params, urlParams);

  const query = useQuery<ViewQueryResult>({
    queryKey: ["view", name, location.search],
    queryFn: () =>
      fetchView(name, {
        ...Object.fromEntries(urlParams),
        page: currentPage,
        show: VIEW_PAGE_SIZE,
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

  const rows = query.data?.data.rows ?? [];
  const columns = viewColumns(view, rows);
  const viewTitle = resolveLocalizedText(view.title, language, canonical) ?? fieldLabel(view.name);
  const exportHref = viewExportHref(name, urlParams);

  return (
    <div className="space-y-6">
      <PageHeader
        title={viewTitle}
        description={t(language, "views.page.body", { schema: view.from ?? view.name })}
        actions={
          <Button
            type="button"
            variant="secondary"
            disabled={!canQuery}
            onClick={() => { window.location.href = exportHref; }}
          >
            <Download className="size-4" aria-hidden />
            {t(language, "collection.export")}
          </Button>
        }
      />

      {view.params ? (
        <SectionCard className="space-y-4">
          <h2 className="text-sm font-semibold">{t(language, "views.params.title")}</h2>
          <SchemaFields
            schema={view.params}
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
            onClick={() => { window.location.href = viewParamsHref(name, urlParams, view.params!, params); }}
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
          filters={view.list.filterFields.map((field) => ({
            name: field,
            label: fieldLabel(field),
            value: urlParams.get(`filter.${field}`) ?? "",
          }))}
          onSubmit={({ search, filters }) => {
            const next = new URLSearchParams(urlParams);
            setOrDelete(next, "search", search);
            for (const field of view.list.filterFields) {
              setOrDelete(next, `filter.${field}`, filters[field] ?? "");
            }
            next.delete("page");
            next.delete("show");
            window.location.href = viewHref(name, next);
          }}
        />
      ) : null}

      {query.isError ? <ErrorBox error={query.error} /> : null}
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
                  {propertyLabel(col, sourceSchema?.properties?.[col], language, canonical)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={index}>
                {columns.map((col) => (
                  <TableCell key={col} className="text-muted-foreground">
                    {renderDataValue(sourceSchema?.properties?.[col], row[col])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {query.data ? (
        <ViewPagination
          name={name}
          query={urlParams}
          page={query.data.data.page}
          hasMore={query.data.data.hasMore}
          language={language}
        />
      ) : null}
    </div>
  );
}

function ViewPagination({
  name,
  query,
  page,
  hasMore,
  language,
}: {
  name: string;
  query: URLSearchParams;
  page: number;
  hasMore: boolean;
  language: AdminLanguage;
}): React.ReactElement | null {
  if (page <= 1 && !hasMore) return null;
  const previousHref = page > 1 ? viewPageHref(name, query, page - 1) : undefined;
  const nextHref = hasMore ? viewPageHref(name, query, page + 1) : undefined;
  return (
    <Pagination className="mt-4 justify-end" aria-label={t(language, "collection.pagination")}>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href={previousHref}
            text={t(language, "collection.previousPage")}
            aria-label={t(language, "collection.previousPage")}
            aria-disabled={!previousHref || undefined}
            tabIndex={previousHref ? undefined : -1}
            className={cn(!previousHref && "pointer-events-none opacity-50")}
          />
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            href={nextHref}
            text={t(language, "collection.nextPage")}
            aria-label={t(language, "collection.nextPage")}
            aria-disabled={!nextHref || undefined}
            tabIndex={nextHref ? undefined : -1}
            className={cn(!nextHref && "pointer-events-none opacity-50")}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

function readViewParams(
  schema: JsonSchema | null | undefined,
  query: URLSearchParams,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    const raw = query.get(name);
    if (raw === null) continue;
    if (property.type === "integer" || property.type === "number") values[name] = Number(raw);
    else if (property.type === "boolean") values[name] = raw === "true";
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
  next.delete("page");
  next.delete("show");
  return viewHref(name, next);
}

function viewPageHref(name: string, query: URLSearchParams, page: number): string {
  const next = new URLSearchParams(query);
  if (page > 1) next.set("page", String(page));
  else next.delete("page");
  next.delete("show");
  return viewHref(name, next);
}

function viewExportHref(name: string, query: URLSearchParams): string {
  const next = new URLSearchParams(query);
  next.delete("page");
  next.delete("show");
  const suffix = next.toString();
  return `/admin/api/views/${encodeURIComponent(name)}/export${suffix ? `?${suffix}` : ""}`;
}

function viewHref(name: string, query: URLSearchParams): string {
  const suffix = query.toString();
  return `/admin/views/${encodeURIComponent(name)}${suffix ? `?${suffix}` : ""}`;
}

function setOrDelete(query: URLSearchParams, name: string, value: string): void {
  if (value) query.set(name, value);
  else query.delete(name);
}

function positiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Prefer explicit Admin columns, then the legacy View projection,
 *  then the first-seen row shape for old SQL Views. */
function viewColumns(view: ViewManifestInfo, rows: ReadonlyArray<Record<string, unknown>>): string[] {
  if (view.list.columns.length > 0) return [...view.list.columns];
  if (view.fields && view.fields.length > 0) return [...view.fields];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}
