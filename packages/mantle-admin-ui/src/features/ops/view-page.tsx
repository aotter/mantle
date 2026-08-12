import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { viewsManifestQueryOptions } from "../../lib/queries";
import { fieldLabel, propertyLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { Collection, SiteInfo, ViewManifestInfo } from "../../lib/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { Button } from "@/components/ui/button";
import { SchemaFields } from "../content/entry-edit-view";
import { renderDataValue } from "../../lib/render-data-value";

/** Mirrors `VIEW_PARAMS_RESERVED` in `@aotter/mantle-spec`'s manifest
 *  grammar (`page`, `show`, plus `cursor` which the admin UI doesn't
 *  surface a control for). `mantle-admin-ui` has no dependency on
 *  `mantle-spec` — it only talks JSON over HTTP — so the two names the
 *  UI needs are inlined here rather than adding that dependency. */
const VIEW_RESERVED_PARAM_NAMES = ["page", "show"] as const;

interface ViewQueryResult {
  ok: true;
  data: {
    rows: Array<Record<string, unknown>>;
    page: number;
    show: number;
    hasMore: boolean;
  };
}

/** Fetches `GET /admin/api/views/<name>` — the staff-gated View REST
 *  surface (#433). Since `/admin/api/views-manifest` now returns ONLY
 *  `surface: staff` Views, every View reachable from the 報表 sidebar
 *  (which drives this page) is a staff View mounted behind the admin
 *  gate; the public `/api/views/<name>` path no longer serves them.
 *  We fetch directly rather than through `lib/api.ts`'s `api` helper so
 *  we can pass the caller's page/show/param query string verbatim.
 *  Reuses the admin session cookie via `credentials: same-origin` same
 *  as `lib/api.ts`. */
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

/** #426 — read-only View page. Fetches the View's row set from the
 *  staff-gated `/admin/api/views/<name>` REST surface (#433 — the 報表
 *  sidebar only lists staff Views now), renders a
 *  SchemaFields-driven parameter form when the View declares
 *  `params`, and a plain table for the rows. Column formatting
 *  (money-minor / timestamp-ms) is resolved against the source
 *  Schema's properties when that Schema is present in the
 *  client-side collections list (already fetched by
 *  `AuthenticatedLayout`); falls back to raw values when the View's
 *  `from` is a translation-child Schema not exposed on
 *  `/admin/api/collections`. */
export function ViewPage({ name }: { name: string }): React.ReactElement {
  const { language } = usePreferences();
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
  const [page, setPage] = React.useState<string>("");
  const [show, setShow] = React.useState<string>("");

  const query = useQuery<ViewQueryResult>({
    queryKey: ["view", name, params, page, show],
    queryFn: () =>
      fetchView(name, {
        ...params,
        ...(page ? { page } : {}),
        ...(show ? { show } : {}),
      }),
    enabled: !!view,
  });

  if (viewsQuery.isLoading || collectionsQuery.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (viewsQuery.isError) return <ErrorBox error={viewsQuery.error} />;
  if (!view) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="AotterMantle" title={t(language, "views.notFound.title")} />
      </div>
    );
  }

  const rows = query.data?.data.rows ?? [];
  const columns = viewColumns(view, rows);
  const viewTitle = resolveLocalizedText(view.title, language, canonical) ?? fieldLabel(view.name);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AotterMantle"
        title={viewTitle}
        description={t(language, "views.page.body", { schema: view.from })}
      />

      <SectionCard className="space-y-4">
        {view.params ? (
          <>
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
          </>
        ) : null}
        <ReservedParamInputs page={page} show={show} onPage={setPage} onShow={setShow} />
        <Button type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
          <Search className="size-4" aria-hidden />
          {query.isFetching ? t(language, "views.running") : t(language, "views.run")}
        </Button>
      </SectionCard>

      {query.isError ? <ErrorBox error={query.error} /> : null}

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
    </div>
  );
}

function ReservedParamInputs({
  page,
  show,
  onPage,
  onShow,
}: {
  page: string;
  show: string;
  onPage: (v: string) => void;
  onShow: (v: string) => void;
}): React.ReactElement {
  const [pageParam, showParam] = VIEW_RESERVED_PARAM_NAMES;
  return (
    <div className="flex flex-wrap gap-3">
      <label className="grid gap-1.5 text-sm font-medium">
        <span>{fieldLabel(pageParam)}</span>
        <Input
          className="w-28"
          type="number"
          min={1}
          value={page}
          onChange={(event) => onPage(event.target.value)}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        <span>{fieldLabel(showParam)}</span>
        <Input
          className="w-28"
          type="number"
          min={1}
          value={show}
          onChange={(event) => onShow(event.target.value)}
        />
      </label>
    </div>
  );
}

/** Columns = the View's declared `fields` projection when present,
 *  else every key seen across the returned rows (union, first-seen
 *  order) — a View with no `fields` projects every source column and
 *  the row shape is the only signal the client has. */
function viewColumns(view: ViewManifestInfo, rows: ReadonlyArray<Record<string, unknown>>): string[] {
  if (view.fields && view.fields.length > 0) return [...view.fields];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}
