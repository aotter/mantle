import type { ContentStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { usePreferences } from "../app/preferences";
import { t, type I18nKey } from "../app/i18n";
import { Badge } from "@/components/ui/badge";

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
  status: string;
  className?: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const known = isContentStatus(status);
  const labelKey = STATUS_LABEL_KEY[status];
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
  return status in STATUS_CLASS;
}
