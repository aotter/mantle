import type { ContentStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { usePreferences } from "../app/preferences";
import { t, type I18nKey } from "../app/i18n";

const STATUS_CLASS: Record<ContentStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  review: "bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-[color:var(--warning)]",
  approved: "bg-[color-mix(in_srgb,var(--success)_18%,transparent)] text-[color:var(--success)]",
  scheduled: "bg-[color-mix(in_srgb,var(--info)_18%,transparent)] text-[color:var(--info)]",
  published: "bg-[color-mix(in_srgb,var(--success)_18%,transparent)] text-[color:var(--success)]",
  archived: "bg-secondary text-muted-foreground",
};

// Localized labels for the shipped (simple-lifecycle) statuses; approved
// and scheduled are editorial-only (v0.1.x) and fall back to the raw
// value until that runtime + its i18n keys land.
const STATUS_LABEL_KEY: Partial<Record<string, I18nKey>> = {
  draft: "status.draft",
  review: "status.review",
  published: "status.published",
  archived: "status.archived",
};

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const known = isContentStatus(status);
  const labelKey = STATUS_LABEL_KEY[status];
  return (
    <span
      className={cn(
        "badge-status",
        known ? STATUS_CLASS[status] : "bg-accent text-accent-foreground",
        className,
      )}
    >
      {labelKey ? t(language, labelKey) : status}
    </span>
  );
}

function isContentStatus(status: string): status is ContentStatus {
  return status in STATUS_CLASS;
}
