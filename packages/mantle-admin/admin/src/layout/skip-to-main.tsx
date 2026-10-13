import * as React from "react";
import { t } from "../app/i18n";
import { usePreferences } from "../app/preferences";
import { cn } from "../lib/utils";

export const MAIN_CONTENT_ID = "content";

export function SkipToMain({
  className,
}: {
  className?: string;
}): React.ReactElement {
  const { language } = usePreferences();
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className={cn(
        "fixed inset-inline-start-3 top-3 z-[999]",
        "-translate-y-52 rounded-md bg-primary px-3 py-2 text-sm font-medium",
        "text-primary-foreground shadow",
        "focus-visible:translate-y-0 transition-transform",
        "outline-2 outline-offset-2 outline-ring/40",
        className,
      )}
    >
      {t(language, "common.skipToMain")}
    </a>
  );
}
