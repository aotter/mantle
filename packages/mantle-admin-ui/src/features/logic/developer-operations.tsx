import * as React from "react";
import { t } from "../../app/i18n";
import { usePreferences } from "../../app/preferences";
import type { DeveloperConsoleSnapshot } from "../../lib/types";
import { developerDetailHref } from "./developer-route";

export function DeveloperOperations({ operations }: { operations: DeveloperConsoleSnapshot["operations"] }): React.ReactElement | null {
  const { language } = usePreferences();
  if (!operations || (!operations.schedules.length && !operations.ttlPolicies.length)) return null;
  const observed = operations.observationAvailability === "available";
  const statusLabel = (status: "started" | "succeeded" | "failed") => status === "started"
    ? t(language, "developer.operations.completionUnobserved")
    : t(language, status === "succeeded" ? "developer.operations.succeeded" : "developer.operations.failed");
  return <section className="max-h-80 shrink-0 overflow-auto border-b px-6 py-4" aria-label={t(language, "developer.operations.title")}>
    <h2 className="mb-3 text-sm font-semibold">{t(language, "developer.operations.title")}</h2>
    <div className="grid gap-4 xl:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm font-medium">{t(language, "developer.operations.schedules")}</h3>
        {operations.schedules.length ? <ul className="space-y-2 text-sm">{operations.schedules.map((schedule) => {
          const latest = operations.latestRuns.find((run) => run.scheduleId === schedule.id);
          return <li key={schedule.id} className="rounded-md border p-3">
            <a className="font-medium underline" href={developerDetailHref(`Procedure:${schedule.procedure}`)}>{schedule.id}</a>
            <span className="ml-2 font-mono text-xs">{schedule.cron}</span>
            <p>{schedule.enabled ? t(language, "developer.operations.enabled") : t(language, "developer.operations.disabled")}
              {" · "}{t(language, "developer.operations.registration")}: {t(language, "developer.operations.notObserved")}</p>
            <p>{t(language, "developer.operations.lastRun")}: {observed
              ? latest ? `${statusLabel(latest.status)} · ${new Date(latest.startedAt).toLocaleString(language)}` : t(language, "developer.operations.noRun")
              : t(language, "developer.operations.unavailable")}</p>
          </li>;
        })}</ul> : <p className="text-sm text-muted-foreground">{t(language, "developer.operations.none")}</p>}
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium">{t(language, "developer.operations.ttl")}</h3>
        {operations.ttlPolicies.length ? <ul className="space-y-2 text-sm">{operations.ttlPolicies.map((policy) => <li key={policy.schema} className="rounded-md border p-3">
          <a className="font-medium underline" href={developerDetailHref(`Schema:${policy.schema}`)}>{policy.schema}</a>
          <p>{policy.field} + {policy.expireAfterSeconds}s</p>
          <p>{t(language, "developer.operations.sweeps")}: {t(language, "developer.operations.unavailable")}</p>
        </li>)}</ul> : <p className="text-sm text-muted-foreground">{t(language, "developer.operations.none")}</p>}
      </div>
    </div>
    {observed && operations.runs.length > 0 ? <div className="mt-4 overflow-x-auto">
      <h3 className="mb-2 text-sm font-medium">{t(language, "developer.operations.history")}</h3>
      <table className="w-full text-left text-xs"><thead><tr>
        <th scope="col" className="pr-3">{t(language, "developer.operations.schedules")}</th>
        <th scope="col" className="pr-3">{t(language, "developer.operations.attempt")}</th>
        <th scope="col" className="pr-3">{t(language, "developer.operations.scheduledAt")}</th>
        <th scope="col" className="pr-3">{t(language, "developer.operations.startedAt")}</th>
        <th scope="col" className="pr-3">{t(language, "developer.operations.finishedAt")}</th>
        <th scope="col">{t(language, "developer.operations.status")}</th>
      </tr></thead><tbody>{operations.runs.map((run) => <tr key={`${run.runId}:${run.attempt}`} className="border-t">
        <td className="pr-3">{run.scheduleId}</td><td className="pr-3">{run.attempt}</td>
        <td className="pr-3"><time dateTime={new Date(run.scheduledAt).toISOString()}>{new Date(run.scheduledAt).toLocaleString(language)}</time></td>
        <td className="pr-3"><time dateTime={new Date(run.startedAt).toISOString()}>{new Date(run.startedAt).toLocaleString(language)}</time></td>
        <td className="pr-3">{run.finishedAt === null ? "—" : <time dateTime={new Date(run.finishedAt).toISOString()}>{new Date(run.finishedAt).toLocaleString(language)}</time>}</td>
        <td>{statusLabel(run.status)}{run.durationMs === null ? "" : ` · ${run.durationMs}ms`}{run.errorSummary ? ` · ${run.errorSummary}` : ""}
          {run.counts ? ` · ${JSON.stringify(run.counts)}` : ""}</td>
      </tr>)}</tbody></table>
    </div> : null}
  </section>;
}
