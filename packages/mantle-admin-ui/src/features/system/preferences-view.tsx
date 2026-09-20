import * as React from "react";
import {
  Check,
  ChevronsUpDown,
  Languages,
  Monitor,
  Moon,
  Pilcrow,
  Search,
  Sun,
  type LucideIcon,
} from "lucide-react";
import {
  ADMIN_LANGUAGES,
  directionForLanguage,
  usePreferences,
  type AdminLanguage,
  type AdminTheme,
} from "../../app/preferences";
import { t } from "../../app/i18n";
import { PageHeader, SectionCard } from "../../ui/page";
import { cn } from "../../lib/utils";

export function PreferencesView(): React.ReactElement {
  const {
    language,
    direction,
    theme,
    setLanguage,
    setTheme,
  } = usePreferences();

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        eyebrow={t(language, "preferences.heading")}
        title={t(language, "preferences.page.title")}
        description={t(language, "preferences.page.body")}
      />

      <div className="grid gap-4">
        <SectionCard>
          <PreferenceSectionHeader
            icon={Languages}
            title={t(language, "preferences.language")}
            body={t(language, "preferences.page.languageBody")}
          />
          <LanguageSearchSelect
            language={language}
            onChange={setLanguage}
          />
        </SectionCard>

        <div className="grid gap-4 md:grid-cols-2">
          <SectionCard>
            <PreferenceSectionHeader
              icon={Monitor}
              title={t(language, "preferences.appearance")}
              body={t(language, "preferences.page.appearanceBody")}
            />
            <div className="mt-4 grid gap-2">
              {themeOptions(language).map((item) => (
                <PreferenceOptionButton
                  key={item.value}
                  selected={item.value === theme}
                  onClick={() => setTheme(item.value)}
                  icon={item.icon}
                >
                  {item.label}
                </PreferenceOptionButton>
              ))}
            </div>
          </SectionCard>

          <SectionCard>
            <PreferenceSectionHeader
              icon={Pilcrow}
              title={t(language, "preferences.direction")}
              body={t(language, "preferences.direction.auto")}
            />
            <div className="mt-4 rounded-lg border border-border/70 bg-background/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {direction === "rtl"
                  ? t(language, "preferences.rtl")
                  : t(language, "preferences.ltr")}
              </span>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function LanguageSearchSelect({
  language,
  onChange,
}: {
  language: AdminLanguage;
  onChange: (language: AdminLanguage) => void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const current =
    ADMIN_LANGUAGES.find((item) => item.value === language) ?? ADMIN_LANGUAGES[0];
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? ADMIN_LANGUAGES.filter((item) =>
        [
          item.nativeLabel,
          item.label,
          item.value,
          item.htmlLang,
          item.direction,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : ADMIN_LANGUAGES;

  return (
    <div className="relative mt-4">
      <button
        type="button"
        onClick={() => setOpen((next) => !next)}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/30 px-3 py-2 text-start text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        aria-expanded={open}
      >
        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground">
            {current.nativeLabel}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {current.label} · {current.value} · {directionForLanguage(current.value).toUpperCase()}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {open ? (
        <div className="absolute z-30 mt-2 w-full overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
              placeholder={t(language, "preferences.language.search")}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t(language, "preferences.language.noResults")}
              </div>
            ) : (
              filtered.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => {
                    onChange(item.value);
                    setQuery("");
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-start text-sm transition-colors",
                    item.value === language
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {item.nativeLabel}
                    </span>
                    <span className="block truncate text-xs opacity-75">
                      {item.label} · {item.value} · {item.direction.toUpperCase()}
                    </span>
                  </span>
                  <Check
                    className={cn(
                      "size-4 shrink-0 text-primary",
                      item.value === language ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden
                  />
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PreferenceSectionHeader({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}): React.ReactElement {
  return (
    <div className="flex items-start gap-3">
      <div className="rounded-xl bg-primary/15 p-2 text-primary">
        <Icon className="size-5" aria-hidden />
      </div>
      <div>
        <h2 className="text-lg">{title}</h2>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function PreferenceOptionButton({
  selected,
  onClick,
  icon: Icon,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  icon?: LucideIcon;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-10 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-start text-sm transition-colors",
        selected
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border/70 bg-background/30 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
        <span className="truncate">{children}</span>
      </span>
      <Check
        className={cn("size-4 shrink-0 text-primary", selected ? "opacity-100" : "opacity-0")}
        aria-hidden
      />
    </button>
  );
}

function themeOptions(language: AdminLanguage): ReadonlyArray<{
  value: AdminTheme;
  label: string;
  icon: LucideIcon;
}> {
  return [
    { value: "light", label: t(language, "preferences.light"), icon: Sun },
    { value: "dark", label: t(language, "preferences.dark"), icon: Moon },
    { value: "system", label: t(language, "preferences.system"), icon: Monitor },
  ];
}
