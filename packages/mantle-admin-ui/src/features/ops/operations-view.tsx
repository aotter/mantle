import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Play, Wrench } from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { asRenderable } from "../../lib/errors";
import { fieldLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import { operationsQueryOptions } from "../../lib/queries";
import type { SiteInfo, StaffOperation } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorBox, OperationErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { toast } from "sonner";
import { SchemaFields } from "../content/entry-edit-view";

/** Render staff-operable Procedures as schema-driven forms. */
export function OperationsView(): React.ReactElement {
  const { language } = usePreferences();
  const operations = useQuery(operationsQueryOptions());
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const canonical = site.data?.canonicalLocale ?? null;

  if (operations.isLoading) return <Skeleton className="h-64 w-full" />;
  if (operations.isError) return <ErrorBox error={operations.error} />;
  const list = operations.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t(language, "ops.page.title")}
        description={t(language, "ops.page.body")}
      />
      {list.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title={t(language, "ops.empty.title")}
          description={t(language, "ops.empty.body")}
        />
      ) : (
        <div className="space-y-4">
          {list.map((op) => (
            <OperationCard key={op.name} operation={op} language={language} canonical={canonical} />
          ))}
        </div>
      )}
    </div>
  );
}

function OperationCard({
  operation,
  language,
  canonical,
}: {
  operation: StaffOperation;
  language: AdminLanguage;
  canonical: string | null;
}): React.ReactElement {
  const [input, setInput] = React.useState<Record<string, unknown>>({});
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash === `#${operation.name}`) {
      ref.current?.scrollIntoView({ block: "start" });
    }
  }, [operation.name]);

  const title = resolveLocalizedText(operation.title, language, canonical) ?? fieldLabel(operation.name);
  const description = resolveLocalizedText(operation.description, language, canonical);

  const invoke = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ ok: true; output: unknown }>(`/operations/${encodeURIComponent(operation.name)}`, body),
    onSuccess: () => toast.success(t(language, "ops.success", { name: title })),
  });

  return (
    <SectionCard className="space-y-4 scroll-mt-20" id={operation.name}>
      <div ref={ref} className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Wrench className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          {operation.triggers.map((kind) => (
            <Badge key={kind} variant="secondary">
              {t(language, kind === "mcp" ? "ops.triggers.mcp" : "ops.triggers.http")}
            </Badge>
          ))}
        </div>
      </div>

      <SchemaFields
        schema={operation.input}
        value={input}
        path={[]}
        onChange={setInput}
        language={language}
        canonical={canonical}
        collectionName={operation.name}
        mediaPurposes={[]}
      />

      <div className="flex items-center gap-2">
        <Button type="button" onClick={() => invoke.mutate(input)} disabled={invoke.isPending}>
          <Play className="size-4" aria-hidden />
          {invoke.isPending ? t(language, "ops.running") : t(language, "ops.run")}
        </Button>
      </div>

      {invoke.isError ? <OperationErrorBox error={asRenderable(invoke.error)} /> : null}

      {invoke.isSuccess ? (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t(language, "ops.result.title")}
          </h3>
          <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/30 p-3 text-xs">
            {JSON.stringify(invoke.data.output, null, 2)}
          </pre>
        </div>
      ) : null}
    </SectionCard>
  );
}
