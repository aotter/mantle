import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@aotter/mantle-ui/kit";
import { Skeleton } from "@aotter/mantle-ui/kit";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { fieldLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import { operationsQueryOptions } from "../../lib/queries";
import type { SiteInfo, StaffOperation } from "../../lib/types";
import { EmptyState, ErrorBox, PageHeader } from "../../ui/page";
import { OperationDialog } from "../content/row-operations";

export function globalOperations(operations: readonly StaffOperation[]): StaffOperation[] {
  return operations.filter(operation => (operation.interactions ?? []).length === 0 && !operation.uiSchema?.["collectionAction"]);
}

export function OperationsView(): React.ReactElement {
  const { language } = usePreferences();
  const query = useQuery(operationsQueryOptions());
  const site = useQuery({ queryKey: ["site"], queryFn: () => api.get<SiteInfo>("/site") });
  const [active, setActive] = React.useState<StaffOperation | null>(null);
  const canonical = site.data?.canonicalLocale ?? null;
  const operations = globalOperations(query.data ?? []);
  return <div className="space-y-6">
    <PageHeader title={t(language, "ops.title")} description={t(language, "ops.description")} />
    {query.isLoading ? <Skeleton className="h-24 w-full" /> : query.isError ? <ErrorBox error={query.error} /> :
      operations.length === 0 ? <EmptyState title={t(language, "ops.empty")} description={t(language, "ops.emptyBody")} /> :
      <ul className="divide-y rounded-md border">
        {operations.map(operation => <li key={operation.name} className="flex items-start justify-between gap-4 p-4">
          <div><h2 className="font-semibold">{resolveLocalizedText(operation.title, language, canonical) ?? fieldLabel(operation.name)}</h2>
            <p className="text-sm text-muted-foreground">{resolveLocalizedText(operation.description, language, canonical)}</p></div>
          <Button type="button" variant="secondary" onClick={() => setActive(operation)}>{t(language, "ops.run")}</Button>
        </li>)}
      </ul>}
    {active ? <OperationDialog key={active.name} operation={active} language={language} canonical={canonical}
      onClose={() => setActive(null)} onSuccess={() => {}} /> : null}
  </div>;
}
