import type { ContentStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { usePreferences } from "../app/preferences";
import { t, type I18nKey } from "../app/i18n";
import { Badge } from "@aotter/mantle-ui/kit";

const STATUS_CLASS: Record<ContentStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  published: "bg-[color-mix(in_srgb,var(--success)_18%,transparent)] text-[color:var(--success)]",
  archived: "bg-secondary text-muted-foreground",
};

const STATUS_LABEL_KEY: Partial<Record<string, I18nKey>> = {
  draft: "status.draft",
  published: "status.published",
  archived: "status.archived",
};

export function StatusBadge({
  status,
  className,
}: {
  status: string | null;
  className?: string;
}): React.ReactElement | null {
  const { language } = usePreferences();
  if (status === null) return null;
  const known = isContentStatus(status);
  const labelKey = known ? STATUS_LABEL_KEY[status] : undefined;
  return (
    <Badge
      variant="secondary"
      className={cn(
        known ? STATUS_CLASS[status] : "bg-accent text-accent-foreground",
        className,
      )}
    >
      {labelKey ? t(language, labelKey) : status}
    </Badge>
  );
}

function isContentStatus(status: string): status is ContentStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_CLASS, status);
}
