import * as React from "react";
import { Search } from "lucide-react";
import { t } from "../app/i18n";
import type { AdminLanguage } from "../app/preferences";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ListQueryFilter {
  name: string;
  label: string;
  value?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
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
  return (
    <form
      className="mb-3 space-y-3"
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
      {filters.length > 0 ? (
        <div className="flex flex-wrap items-end gap-3">
          {filters.map((filter) => (
            <label key={filter.name} className="grid gap-1.5 text-sm font-medium">
              <span>{filter.label}</span>
              {filter.options ? (
                <select
                  name={`filter.${filter.name}`}
                  className="h-9 w-48 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                  defaultValue={filter.value ?? ""}
                >
                  <option value="">{t(language, "collection.filter.all")}</option>
                  {filter.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  name={`filter.${filter.name}`}
                  className="h-9 w-48"
                  defaultValue={filter.value ?? ""}
                />
              )}
            </label>
          ))}
          {!searchable ? <SubmitButton language={language} /> : null}
        </div>
      ) : null}
    </form>
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
