import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ExternalLink, Save, ShieldCheck, TerminalSquare } from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { CoverageItem, CoverageReport, DeveloperLogItem } from "../../lib/types";
import { Button } from "../../ui/button";
import { EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { PaginationControls, type PageSize, paginate, SegmentedTabs } from "../../ui/resource";

const TIMESTAMP_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

type DeveloperLogsTab = "logs" | "coverage";

type LogForm = {
  source: string;
  level: string;
  message: string;
  details: string;
};

export function DeveloperLogsView(): React.ReactElement {
  const { language } = usePreferences();
  const queryClient = useQueryClient();
  const logs = useQuery<{ items: DeveloperLogItem[] }>({
    queryKey: ["developer-logs"],
    queryFn: () => api.get<{ items: DeveloperLogItem[] }>("/developer-logs"),
  });
  const coverage = useQuery<CoverageReport>({
    queryKey: ["system-coverage"],
    queryFn: () => api.get<CoverageReport>("/system/coverage"),
  });
  const [form, setForm] = React.useState<LogForm>({
    source: "manual",
    level: "info",
    message: "",
    details: "",
  });
  const [activeTab, setActiveTab] = React.useState<DeveloperLogsTab>("logs");
  const [logPage, setLogPage] = React.useState(1);
  const [logPageSize, setLogPageSize] = React.useState<PageSize>(10);
  const [coveragePage, setCoveragePage] = React.useState(1);
  const [coveragePageSize, setCoveragePageSize] = React.useState<PageSize>(10);
  const createLog = useMutation({
    mutationFn: (next: LogForm) => api.post<DeveloperLogItem>("/developer-logs", next),
    onSuccess: () => {
      setForm((current) => ({ ...current, message: "", details: "" }));
      void queryClient.invalidateQueries({ queryKey: ["developer-logs"] });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AotterMantle"
        title={t(language, "developerLogs.title")}
        description={t(language, "developerLogs.body")}
      />

      <SegmentedTabs
        className="w-fit"
        label={t(language, "developerLogs.tabsLabel")}
        value={activeTab}
        onChange={setActiveTab}
        items={[
          { value: "logs", label: t(language, "developerLogs.tab.logs"), icon: Activity },
          { value: "coverage", label: t(language, "developerLogs.tab.coverage"), icon: ShieldCheck },
        ]}
      />

      {activeTab === "logs" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]" role="tabpanel">
          <SectionCard>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{t(language, "developerLogs.formTitle")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t(language, "developerLogs.formBody")}</p>
              </div>
              <TerminalSquare className="size-5 text-primary" aria-hidden />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t(language, "developerLogs.source")}>
                <select
                  className="admin-input"
                  value={form.source}
                  onChange={(event) => setForm((current) => ({ ...current, source: event.target.value }))}
                >
                  <option value="manual">{t(language, "developerLogs.source.manual")}</option>
                  <option value="llm">{t(language, "developerLogs.source.llm")}</option>
                  <option value="tui">{t(language, "developerLogs.source.tui")}</option>
                  <option value="agent">{t(language, "developerLogs.source.agent")}</option>
                  <option value="system">{t(language, "developerLogs.source.system")}</option>
                </select>
              </Field>
              <Field label={t(language, "developerLogs.level")}>
                <select
                  className="admin-input"
                  value={form.level}
                  onChange={(event) => setForm((current) => ({ ...current, level: event.target.value }))}
                >
                  <option value="info">{t(language, "developerLogs.level.info")}</option>
                  <option value="success">{t(language, "developerLogs.level.success")}</option>
                  <option value="warning">{t(language, "developerLogs.level.warning")}</option>
                  <option value="error">{t(language, "developerLogs.level.error")}</option>
                </select>
              </Field>
            </div>
            <div className="mt-3 grid gap-3">
              <Field label={t(language, "developerLogs.message")}>
                <input
                  className="admin-input"
                  value={form.message}
                  onChange={(event) => setForm((current) => ({ ...current, message: event.target.value }))}
                  placeholder={t(language, "developerLogs.messagePlaceholder")}
                />
              </Field>
              <Field label={t(language, "developerLogs.details")}>
                <textarea
                  className="admin-textarea min-h-28"
                  value={form.details}
                  onChange={(event) => setForm((current) => ({ ...current, details: event.target.value }))}
                  placeholder={t(language, "developerLogs.detailsPlaceholder")}
                />
              </Field>
              {createLog.isError ? <ErrorBox error={createLog.error} /> : null}
              <div className="flex justify-end">
                <Button
                  type="button"
                  disabled={createLog.isPending || !form.message.trim()}
                  onClick={() => createLog.mutate(form)}
                >
                  <Save className="size-4" aria-hidden />
                  {createLog.isPending ? t(language, "crud.saving") : t(language, "developerLogs.add")}
                </Button>
              </div>
            </div>
          </SectionCard>

          <SectionCard>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{t(language, "developerLogs.recent")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t(language, "developerLogs.recentBody")}</p>
              </div>
              <Activity className="size-5 text-primary" aria-hidden />
            </div>
            {logs.isLoading ? <div className="h-40 animate-pulse rounded-lg bg-muted/50" /> : null}
            {logs.isError ? <ErrorBox error={logs.error} /> : null}
            {logs.data && logs.data.items.length === 0 ? (
              <EmptyState
                icon={TerminalSquare}
                title={t(language, "developerLogs.emptyTitle")}
                description={t(language, "developerLogs.emptyBody")}
              />
            ) : null}
            {logs.data && logs.data.items.length > 0 ? (
              <>
                <div className="divide-y divide-[var(--glass-border)] overflow-hidden rounded-lg border border-[var(--glass-border)] bg-background/25">
                  {paginate(logs.data.items, logPage, logPageSize).map((item) => <LogRow key={item.id} item={item} />)}
                </div>
                <PaginationControls
                  page={logPage}
                  pageSize={logPageSize}
                  totalItems={logs.data.items.length}
                  onPageChange={setLogPage}
                  onPageSizeChange={(nextPageSize) => {
                    setLogPageSize(nextPageSize);
                    setLogPage(1);
                  }}
                />
              </>
            ) : null}
          </SectionCard>
        </div>
      ) : null}

      {activeTab === "coverage" ? (
        <div role="tabpanel">
          <SectionCard>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{t(language, "developerLogs.coverageTitle")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t(language, "developerLogs.coverageBody")}</p>
            </div>
            {coverage.data ? <CoverageSummary report={coverage.data} /> : null}
          </div>
          {coverage.isLoading ? <div className="h-48 animate-pulse rounded-lg bg-muted/50" /> : null}
          {coverage.isError ? <ErrorBox error={coverage.error} /> : null}
          {coverage.data ? (
            <>
              <CoverageTable items={paginate(coverage.data.items, coveragePage, coveragePageSize)} />
              <PaginationControls
                page={coveragePage}
                pageSize={coveragePageSize}
                totalItems={coverage.data.items.length}
                onPageChange={setCoveragePage}
                onPageSizeChange={(nextPageSize) => {
                  setCoveragePageSize(nextPageSize);
                  setCoveragePage(1);
                }}
              />
            </>
          ) : null}
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="grid gap-1.5 text-sm font-semibold">
      <span>{label}</span>
      {children}
    </label>
  );
}

function LogRow({ item }: { item: DeveloperLogItem }): React.ReactElement {
  return (
    <article className="grid gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={item.level} />
        <span className="badge-status bg-accent text-accent-foreground">{item.source}</span>
        <span className="text-xs text-muted-foreground">{formatTimestamp(item.created_at)}</span>
        {item.actor ? <span className="text-xs text-muted-foreground">{item.actor}</span> : null}
      </div>
      <p className="text-sm font-semibold">{item.message}</p>
      {item.details ? <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{item.details}</p> : null}
    </article>
  );
}

function CoverageSummary({ report }: { report: CoverageReport }): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-2">
      <Metric label="covered" value={report.summary.covered} />
      <Metric label="folded" value={report.summary.folded} />
      <Metric label="api-only" value={report.summary.apiOnly} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <span className="badge-status bg-secondary text-secondary-foreground">
      {label}: {value}
    </span>
  );
}

function CoverageTable({ items }: { items: CoverageItem[] }): React.ReactElement {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--glass-border)] bg-background/25">
      <table className="w-full min-w-[48rem] text-sm">
        <thead>
          <tr className="border-b border-[var(--glass-border)] text-left">
            <th className="label-eyebrow px-3 py-2">Kind</th>
            <th className="label-eyebrow px-3 py-2">Name</th>
            <th className="label-eyebrow px-3 py-2">Status</th>
            <th className="label-eyebrow px-3 py-2">Path</th>
            <th className="label-eyebrow px-3 py-2">Note</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.kind}:${item.name}:${item.path ?? ""}`} className="border-b border-[var(--glass-border)] last:border-b-0">
              <td className="px-3 py-3 font-semibold">{item.kind}</td>
              <td className="px-3 py-3">{item.name}</td>
              <td className="px-3 py-3"><StatusPill status={item.status} /></td>
              <td className="px-3 py-3">
                {item.href ? (
                  <a href={item.href} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                    {item.method ? `${item.method} ` : ""}{item.path ?? item.href}
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </td>
              <td className="px-3 py-3 text-muted-foreground">{item.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: string }): React.ReactElement {
  const tone =
    status === "covered" || status === "success"
      ? "bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-[color:var(--success)]"
      : status === "api-only" || status === "warning"
        ? "bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-[color:var(--warning)]"
        : status === "error"
          ? "bg-destructive/10 text-destructive"
          : "bg-secondary text-secondary-foreground";
  return <span className={`badge-status ${tone}`}>{status}</span>;
}

function formatTimestamp(value: number): string {
  if (!value) return "-";
  return TIMESTAMP_FMT.format(new Date(value));
}
