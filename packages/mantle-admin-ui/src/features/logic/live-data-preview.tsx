import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { t } from "../../app/i18n";
import { usePreferences } from "../../app/preferences";
import { api } from "../../lib/api";
import { entryLandingPath, isPrimaryNavCollection } from "../../lib/collection-nav";
import { renderTitleText } from "../../lib/entry-title";
import { entriesQueryArgsFromSearch, entriesQueryOptions } from "../../lib/queries";
import { renderDataValue } from "../../lib/render-data-value";
import type { Collection, DeveloperSchemaModel, DeveloperViewModel } from "../../lib/types";
import { EmptyState, ErrorBox } from "../../ui/page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SchemaFields } from "../content/entry-edit-view";
import { formatTimestampMs } from "../content/field-render";
import { fetchView } from "../ops/view-page";

const PREVIEW_SIZE = 20;

function ObservedAt({ time }: { time: number }): React.ReactElement {
  const { language } = usePreferences();
  return <p className="text-xs text-muted-foreground">{t(language, "model.liveDataAt", { time: formatTimestampMs(time) ?? "-" })}</p>;
}

export function SchemaDataPreview({ model }: { model: DeveloperSchemaModel }): React.ReactElement {
  const { language } = usePreferences();
  const [cursor, setCursor] = React.useState<string>();
  const [direction, setDirection] = React.useState<"forward" | "backward">("forward");
  const collections = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => (await api.get<{ collections: Collection[] }>("/collections")).collections,
  });
  const collection = collections.data?.find((item) => item.name === model.name && isPrimaryNavCollection(item));
  const entries = useQuery({
    ...entriesQueryOptions({
      ...entriesQueryArgsFromSearch(model.name, ""),
      cursor,
      cursorDirection: direction,
    }),
    enabled: !!collection,
    staleTime: 0,
  });
  if (collections.isLoading) return <Skeleton className="m-5 h-24 w-auto" />;
  if (collections.isError) return <div className="p-5"><ErrorBox error={collections.error} /></div>;
  if (!collection) return <p className="p-5 text-sm text-muted-foreground">{t(language, "model.liveDataUnavailable")}</p>;

  const rows = entries.data?.items ?? [];
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row.data_preview ?? {})))];
  const base = `/admin/c/${encodeURIComponent(model.name)}`;
  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {entries.dataUpdatedAt ? <ObservedAt time={entries.dataUpdatedAt} /> : null}
        <a className="ms-auto text-sm font-medium text-primary underline-offset-4 hover:underline" href={base}>{t(language, "model.openFullPage")}</a>
      </div>
      {entries.isError ? <ErrorBox error={entries.error} /> : null}
      {entries.isLoading ? <Skeleton className="h-28 w-full" /> : null}
      {entries.data && rows.length === 0 ? <EmptyState title={t(language, "collection.empty.title")} description={t(language, "collection.empty.all", { collection: model.name })} /> : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              {([
                t(language, "collection.table.id"),
                t(language, "collection.table.status"),
                t(language, "collection.table.version"),
                t(language, "collection.table.updated"),
                ...(collection.lifecycle !== "operational" ? [t(language, "collection.table.title")] : []),
                ...fields,
              ]).map((field) => <TableHead key={field}>{field}</TableHead>)}
            </TableRow></TableHeader>
            <TableBody>{rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell><a className="font-mono text-xs text-primary hover:underline" href={entryLandingPath(row.collection, row.id)}>{row.id}</a></TableCell>
                <TableCell>{row.status}</TableCell>
                <TableCell>{row.version}</TableCell>
                <TableCell>{formatTimestampMs(row.updated_at) ?? "-"}</TableCell>
                {collection.lifecycle !== "operational" ? <TableCell>{renderTitleText(row.title, language)}</TableCell> : null}
                {fields.map((field) => <TableCell key={field}>{renderDataValue(collection.schema?.properties?.[field], row.data_preview?.[field])}</TableCell>)}
              </TableRow>
            ))}</TableBody>
          </Table>
        </div>
      ) : null}
      {entries.data && (entries.data.previous_cursor || entries.data.next_cursor) ? (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={!entries.data.previous_cursor} onClick={() => { setCursor(entries.data!.previous_cursor!); setDirection("backward"); }}>{t(language, "collection.previousPage")}</Button>
          <Button type="button" variant="outline" disabled={!entries.data.next_cursor} onClick={() => { setCursor(entries.data!.next_cursor!); setDirection("forward"); }}>{t(language, "collection.nextPage")}</Button>
        </div>
      ) : null}
    </div>
  );
}

export function ViewDataPreview({ model }: { model: DeveloperViewModel }): React.ReactElement {
  const { language } = usePreferences();
  const schema = model.query.params;
  const [params, setParams] = React.useState<Record<string, unknown>>({});
  const [submitted, setSubmitted] = React.useState<Record<string, unknown> | null>(schema?.required?.length ? null : {});
  const [run, setRun] = React.useState(0);
  const canRun = (schema?.required ?? []).every((name) => params[name] !== undefined && params[name] !== null && params[name] !== "");
  const query = useQuery({
    queryKey: ["developer-view-preview", model.name, submitted, run],
    queryFn: () => fetchView(model.name, { ...submitted, page: 1, show: PREVIEW_SIZE }),
    enabled: submitted !== null,
    retry: false,
    staleTime: 0,
  });
  const rows = query.data?.data.rows ?? [];
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    <div className="space-y-4 p-5">
      {schema ? (
        <div className="space-y-3">
          <SchemaFields schema={schema} value={params} path={[]} onChange={setParams} language={language} canonical={null} collectionName={model.name} mediaPurposes={[]} />
          <Button type="button" disabled={!canRun || query.isFetching} onClick={() => { setSubmitted({ ...params }); setRun((value) => value + 1); }}>{t(language, "views.run")}</Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {query.dataUpdatedAt ? <ObservedAt time={query.dataUpdatedAt} /> : null}
        <a className="ms-auto text-sm font-medium text-primary underline-offset-4 hover:underline" href={`/admin/views/${encodeURIComponent(model.name)}`}>{t(language, "model.openFullPage")}</a>
      </div>
      {submitted !== null ? <p className="text-xs text-muted-foreground">{t(language, "model.params")}: <code>{JSON.stringify(submitted)}</code></p> : null}
      {query.isError ? <ErrorBox error={query.error} /> : null}
      {query.isLoading ? <Skeleton className="h-28 w-full" /> : null}
      {query.data && rows.length === 0 ? <EmptyState title={t(language, "views.empty.title")} description={t(language, "views.empty.body")} /> : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto"><Table>
          <TableHeader><TableRow>{fields.map((field) => <TableHead key={field}>{field}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{rows.map((row, index) => <TableRow key={index}>{fields.map((field) => <TableCell key={field}>{renderDataValue(undefined, row[field])}</TableCell>)}</TableRow>)}</TableBody>
        </Table></div>
      ) : null}
    </div>
  );
}
