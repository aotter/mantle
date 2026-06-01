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
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return <section className={cn("glass-card p-5", className)}>{children}</section>;
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
