import * as React from "react";
import { Check, Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { JsonSchema } from "../../lib/types";
import { t } from "../../app/i18n";
import type { AdminLanguage } from "../../app/preferences";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function LocaleBadge({ locale }: { locale: string | null }): React.ReactElement {
  if (!locale) return <span className="text-muted-foreground">-</span>;
  return (
    <Badge variant="outline" title={locale}>
      <Globe aria-hidden />
      {localeName(locale)}
      <span className="font-mono text-[0.625rem] text-muted-foreground">{locale}</span>
    </Badge>
  );
}

export function localeName(locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

export function LocaleStatusBadges({
  locales,
  available,
  language,
}: {
  locales: readonly string[];
  available: readonly string[];
  language: AdminLanguage;
}): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  if (locales.length === 0) return null;
  const present = new Set(available);
  const [visible, overflow] = splitLocaleChips(locales);
  const overflowComplete = overflow.every((locale) => present.has(locale));
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((locale) => (
        <LocaleStatusBadge
          key={locale}
          locale={locale}
          available={present.has(locale)}
          language={language}
          showTooltip={!open}
        />
      ))}
      {overflow.length > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Badge
              asChild
              variant={overflowComplete ? "secondary" : "outline"}
              className={overflowComplete ? undefined : "border-dashed text-muted-foreground opacity-60"}
            >
              <button type="button" aria-label={t(language, "collection.moreLanguages", { count: String(overflow.length) })}>
                {overflowComplete ? <Check className="text-[color:var(--success)]" aria-hidden /> : null}
                …{t(language, "collection.moreLanguages", { count: String(overflow.length) })}
              </button>
            </Badge>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 max-w-[calc(100vw-2rem)] p-1.5">
            <ul className="grid gap-0.5">
              {overflow.map((locale) => {
                const available = present.has(locale);
                const label = localeStatusLabel(locale, available, language);
                return (
                  <li
                    key={locale}
                    aria-label={label}
                    className={available
                      ? "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs"
                      : "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground opacity-60"}
                  >
                    {available
                      ? <Check className="size-3 text-[color:var(--success)]" aria-hidden />
                      : <span className="size-3" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate">{localeName(locale)}</span>
                    <span className="font-mono text-[0.625rem] text-muted-foreground">{locale}</span>
                  </li>
                );
              })}
            </ul>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

function LocaleStatusBadge({
  locale,
  available,
  language,
  showTooltip = true,
}: {
  locale: string;
  available: boolean;
  language: AdminLanguage;
  showTooltip?: boolean;
}): React.ReactElement {
  const label = localeStatusLabel(locale, available, language);
  const badge = (
    <Badge
      variant={available ? "secondary" : "outline"}
      className={available ? undefined : "border-dashed text-muted-foreground opacity-60"}
      aria-label={label}
    >
      {available ? <Check className="text-[color:var(--success)]" aria-hidden /> : null}
      {locale}
    </Badge>
  );
  return showTooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>
        {badge}
      </TooltipTrigger>
      <TooltipContent
        className="bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 [&>svg]:fill-popover!"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  ) : badge;
}

function localeStatusLabel(locale: string, available: boolean, language: AdminLanguage): string {
  return t(language, available ? "collection.availableLanguage" : "collection.missingLanguage", {
    language: localeName(locale),
    locale,
  });
}

export function splitLocaleChips(
  locales: readonly string[],
): [visible: string[], overflow: string[]] {
  return locales.length <= 3
    ? [[...locales], []]
    : [locales.slice(0, 2), locales.slice(2)];
}

export function contentLocales(
  schema: JsonSchema | undefined,
  siteLocales: readonly string[] | undefined,
  current = "",
): string[] {
  const declared = schema?.properties?.locale?.enum
    ?.filter((value): value is string => typeof value === "string") ?? [];
  return [...new Set([...(siteLocales ?? []), ...declared, ...(current ? [current] : [])])];
}
