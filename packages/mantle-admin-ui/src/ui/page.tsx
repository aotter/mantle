import * as React from "react";
import { AlertCircle, Check, Copy, ExternalLink, type LucideIcon } from "lucide-react";
import { ApiError } from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "./button";
import { usePreferences } from "../app/preferences";
import { t } from "../app/i18n";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? <p className="label-eyebrow mb-1">{eyebrow}</p> : null}
        <h1 className="text-2xl">{title}</h1>
        {description ? (
          <div className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionCard({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section id={id} className={cn("glass-card p-5", className)}>
      {children}
    </section>
  );
}

export function EmptyState({
  icon: Icon = AlertCircle,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-dashed border-border p-8 text-center">
      <div className="mx-auto mb-3 inline-flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <Icon className="size-5" aria-hidden />
      </div>
      <h2 className="text-lg">{title}</h2>
      {description ? (
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }): React.ReactElement | null {
  const { language } = usePreferences();
  const is401 = error instanceof ApiError && error.status === 401;
  React.useEffect(() => {
    if (!is401 || typeof window === "undefined") return;
    const ret = window.location.pathname + window.location.search;
    window.location.href = `/admin/sign-in?return=${encodeURIComponent(ret)}`;
  }, [is401]);
  if (is401) return null;
  const message = error instanceof Error ? error.message : "Unknown error.";
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      {t(language, "common.failedToLoad")}: {message}
    </div>
  );
}

/** Operation-invoke failure (#444): `ErrorBox` prefixes every message
 *  with "Failed to load" (`common.failedToLoad`), which reads wrong for
 *  an operation that ran and was refused/threw rather than failing to
 *  load. This renders a generic, localized "execution failed" message
 *  instead, with the raw handler/server detail tucked behind a
 *  collapsed `<details>` so operators aren't handed an internal error
 *  string as the headline. 401s still redirect to sign-in exactly like
 *  `ErrorBox`, since an expired session surfacing here is the same
 *  case, not an operation failure. */
export function OperationErrorBox({ error }: { error: unknown }): React.ReactElement | null {
  const { language } = usePreferences();
  const is401 = error instanceof ApiError && error.status === 401;
  React.useEffect(() => {
    if (!is401 || typeof window === "undefined") return;
    const ret = window.location.pathname + window.location.search;
    window.location.href = `/admin/sign-in?return=${encodeURIComponent(ret)}`;
  }, [is401]);
  if (is401) return null;
  const detail = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      <p>{t(language, "ops.error.executionFailed")}</p>
      <details className="group mt-2">
        <summary className="inline-flex cursor-pointer list-none items-center rounded-md border border-destructive/30 bg-card/40 px-2.5 py-1 text-xs font-semibold text-destructive/80 transition hover:bg-destructive/10">
          {t(language, "ops.error.detailsLabel")}
        </summary>
        <p className="mt-2 max-w-3xl whitespace-pre-wrap break-words rounded-md border border-destructive/20 bg-card/30 p-3 font-mono text-xs leading-relaxed text-destructive/90">
          {detail}
        </p>
      </details>
    </div>
  );
}

/** Renders `description` plainly unless it looks like raw schema notes
 *  (long, or containing a backtick), in which case it collapses behind
 *  a `<details>` toggle showing `collapsedIntro` up front. Callers own
 *  i18n — `summaryLabel` and `collapsedIntro` arrive pre-translated so
 *  this component stays i18n-free. */
export function CollapsibleDescription({
  description,
  summaryLabel,
  collapsedIntro,
}: {
  description: string;
  summaryLabel: string;
  collapsedIntro: string;
}): React.ReactElement {
  if (!looksLikeSchemaNotes(description)) return <>{description}</>;

  return (
    <div className="space-y-2">
      <p>{collapsedIntro}</p>
      <details className="group">
        <summary className="inline-flex cursor-pointer list-none items-center rounded-md border border-border bg-card/70 px-2.5 py-1 text-xs font-semibold text-foreground/70 transition hover:bg-accent hover:text-accent-foreground">
          {summaryLabel}
        </summary>
        <p className="mt-2 max-w-3xl rounded-md border border-border bg-card/55 p-3 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </details>
    </div>
  );
}

function looksLikeSchemaNotes(description: string): boolean {
  return description.length > 180 || description.includes("`");
}

export function CopyField({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const [copied, setCopied] = React.useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="rounded-lg border border-border/70 bg-background/30 p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="label-eyebrow">{label}</span>
        <div className="flex items-center gap-1">
          {href ? (
            <Button asChild variant="ghost" size="icon" className="size-7">
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                aria-label={`${t(language, "common.open")} ${label}`}
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={copy}
            aria-label={`${t(language, "common.copy")} ${label}`}
          >
            {copied ? (
              <Check className="size-3.5 text-[color:var(--success)]" aria-hidden />
            ) : (
              <Copy className="size-3.5" aria-hidden />
            )}
          </Button>
        </div>
      </div>
      <code className="block truncate font-mono text-xs text-foreground">{value}</code>
    </div>
  );
}
