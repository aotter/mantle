import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Play, Wrench } from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api, ApiError } from "../../lib/api";
import type { StaffOperation } from "../../lib/types";
import { Button } from "../../ui/button";
import { EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { SchemaFields } from "../content/entry-edit-view";

/** #426 — staff operations surface. Lists every staff-operable
 *  Procedure (derived server-side from Trigger + auth-predicate
 *  manifests, see `discoverStaffOperations` in
 *  `mountServerEndpoints.ts`) and lets a signed-in staff member
 *  invoke one directly through a schema-driven form. The URL hash
 *  (`/admin/ops#<name>`) expands and scrolls to that operation, so
 *  the sidebar's per-procedure links land on the right card. */
export function OperationsView(): React.ReactElement {
  const { language } = usePreferences();
  const operations = useQuery<{ operations: StaffOperation[] }>({
    queryKey: ["operations"],
    queryFn: () => api.get<{ operations: StaffOperation[] }>("/operations"),
  });

  if (operations.isLoading) return <div className="glass-card h-64 animate-pulse" />;
  if (operations.isError) return <ErrorBox error={operations.error} />;
  const list = operations.data?.operations ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AotterMantle"
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
            <OperationCard key={op.name} operation={op} language={language} />
          ))}
        </div>
      )}
    </div>
  );
}

function OperationCard({
  operation,
  language,
}: {
  operation: StaffOperation;
  language: AdminLanguage;
}): React.ReactElement {
  const [input, setInput] = React.useState<Record<string, unknown>>({});
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash === `#${operation.name}`) {
      ref.current?.scrollIntoView({ block: "start" });
    }
  }, [operation.name]);

  const invoke = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ ok: true; output: unknown }>(`/operations/${encodeURIComponent(operation.name)}`, body),
  });

  return (
    <SectionCard className="space-y-4 scroll-mt-20" id={operation.name}>
      <div ref={ref} className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Wrench className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {operation.name}
          </h2>
          {operation.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{operation.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          {operation.triggers.map((kind) => (
            <span key={kind} className="badge-status bg-accent text-accent-foreground">
              {t(language, kind === "mcp" ? "ops.triggers.mcp" : "ops.triggers.http")}
            </span>
          ))}
        </div>
      </div>

      <SchemaFields
        schema={operation.input}
        value={input}
        path={[]}
        onChange={setInput}
        language={language}
        collectionName={operation.name}
        mediaPurposes={[]}
      />

      <div className="flex items-center gap-2">
        <Button type="button" onClick={() => invoke.mutate(input)} disabled={invoke.isPending}>
          <Play className="size-4" aria-hidden />
          {invoke.isPending ? t(language, "ops.running") : t(language, "ops.run")}
        </Button>
      </div>

      {invoke.isError ? (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-destructive">
            {t(language, "ops.error.title")}
          </h3>
          <ErrorBox error={asRenderable(invoke.error)} />
        </div>
      ) : null}

      {invoke.isSuccess ? (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t(language, "ops.result.title")}
          </h3>
          <pre className="max-h-96 overflow-auto rounded-lg border border-[var(--glass-border)] bg-background/40 p-3 text-xs">
            {JSON.stringify(invoke.data.output, null, 2)}
          </pre>
        </div>
      ) : null}
    </SectionCard>
  );
}

/** The server returns structured diagnostics; surface their `message`
 *  instead of the generic HTTP statusText — mirrors `staff-view.tsx`. */
function asRenderable(error: unknown): unknown {
  if (error instanceof ApiError) {
    const body = error.body as { diagnostic?: { message?: string } } | null;
    const message = body?.diagnostic?.message;
    if (message) return new Error(message);
  }
  return error;
}
