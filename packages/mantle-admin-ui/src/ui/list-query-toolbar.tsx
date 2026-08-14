import * as React from "react";
import { Search } from "lucide-react";
import { t } from "../app/i18n";
import type { AdminLanguage } from "../app/preferences";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ListQueryFilter {
  name: string;
  label: string;
  value?: string;
  allHref?: string;
  options?: ReadonlyArray<{ value: string; label: string; href: string }>;
}

export function ListQueryToolbar({
  language,
  searchable = true,
  searchValue = "",
  filters = [],
  onSubmit,
}: {
  language: AdminLanguage;
  searchable?: boolean;
  searchValue?: string;
  filters?: readonly ListQueryFilter[];
  onSubmit: (query: { search: string; filters: Record<string, string> }) => void;
}): React.ReactElement {
  const optionFilters = filters.filter((filter) => filter.options);
  const fieldFilters = filters.filter((filter) => !filter.options);
  return (
    <form
      className={cn("space-y-3", optionFilters.length > 0 ? "mb-5" : "mb-3")}
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        onSubmit({
          search: String(form.get("search") ?? "").trim(),
          filters: Object.fromEntries(
            filters.map(({ name }) => [name, String(form.get(`filter.${name}`) ?? "").trim()]),
          ),
        });
      }}
    >
      {searchable ? (
        <div className="flex max-w-xl gap-2">
          <label className="relative block flex-1" aria-label={t(language, "collection.searchPlaceholder")}>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              name="search"
              className="h-9 ps-9"
              defaultValue={searchValue}
              placeholder={t(language, "collection.searchPlaceholder")}
            />
          </label>
          <SubmitButton language={language} />
        </div>
      ) : null}
      {fieldFilters.length > 0 ? (
        <div className="flex flex-wrap items-end gap-3">
          {fieldFilters.map((filter) => (
            <label key={filter.name} className="grid gap-1.5 text-sm font-medium">
              <span>{filter.label}</span>
              <Input
                name={`filter.${filter.name}`}
                className="h-9 w-48"
                defaultValue={filter.value ?? ""}
              />
            </label>
          ))}
          {!searchable ? <SubmitButton language={language} /> : null}
        </div>
      ) : null}
      {optionFilters.map((filter) => (
        <div key={filter.name} className="flex gap-2 overflow-x-auto pb-1" aria-label={filter.label}>
          <input type="hidden" name={`filter.${filter.name}`} value={filter.value ?? ""} />
          <FilterTab href={filter.allHref ?? "#"} active={!filter.value}>
            {t(language, "collection.filter.all")}
          </FilterTab>
          {filter.options?.map((option) => (
            <FilterTab key={option.value} href={option.href} active={filter.value === option.value}>
              {option.label}
            </FilterTab>
          ))}
        </div>
      ))}
    </form>
  );
}

function FilterTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-8 shrink-0 items-center justify-center rounded-lg border px-3 text-xs font-medium",
        "transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active
          ? "border-border bg-secondary text-secondary-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </a>
  );
}

function SubmitButton({ language }: { language: AdminLanguage }): React.ReactElement {
  return (
    <Button type="submit" variant="secondary" size="sm" className="h-9">
      <Search className="size-4" aria-hidden />
      {t(language, "collection.search")}
    </Button>
  );
}
