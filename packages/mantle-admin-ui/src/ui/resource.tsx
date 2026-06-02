import * as React from "react";
import { ChevronLeft, ChevronRight, Search, type LucideIcon } from "lucide-react";
import { t } from "../app/i18n";
import { usePreferences } from "../app/preferences";
import { cn } from "../lib/utils";
import { Button } from "./button";

export const PAGE_SIZE_OPTIONS = [10, 30, 50, 100] as const;

export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export type SegmentedTabItem<TValue extends string> = {
  value: TValue;
  label: string;
  icon?: LucideIcon;
};

export function ResourceToolbar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("mb-5 flex flex-wrap items-center gap-3", className)}>
      {children}
    </div>
  );
}

export function ResourceSearchField({
  value,
  onChange,
  onSubmit,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder: string;
  className?: string;
}): React.ReactElement {
  return (
    <form
      className={cn("min-w-0 flex-1", className)}
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <label className="admin-search-field">
        <Search className="admin-search-icon" aria-hidden />
        <input
          className="admin-input admin-search-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
      </label>
    </form>
  );
}

export function SegmentedTabs<TValue extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: Array<SegmentedTabItem<TValue>>;
  value: TValue;
  onChange: (value: TValue) => void;
  label: string;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("segmented-control max-w-full overflow-x-auto", className)} role="tablist" aria-label={label}>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={value === item.value}
            data-active={value === item.value ? "true" : undefined}
            onClick={() => onChange(item.value)}
          >
            {Icon ? <Icon className="size-4" aria-hidden /> : null}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function ResourceFilterBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("mb-5 flex gap-2 overflow-x-auto pb-1", className)} data-tour="status-filter">
      {children}
    </div>
  );
}

export function ResourceFilterLink({
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
          ? "border-[var(--glass-border)] bg-secondary text-secondary-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </a>
  );
}

export function PaginationControls({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: PageSize;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: PageSize) => void;
}): React.ReactElement {
  const { language } = usePreferences();
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const end = Math.min(totalItems, currentPage * pageSize);

  React.useEffect(() => {
    if (page > totalPages) onPageChange(totalPages);
  }, [onPageChange, page, totalPages]);

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
      <div>
        {t(language, "resource.paginationRange", {
          start: String(start),
          end: String(end),
          total: String(totalItems),
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-2">
          <span>{t(language, "resource.rowsPerPage")}</span>
          <select
            className="admin-input h-9 w-24 py-1 text-sm"
            value={pageSize}
            onChange={(event) => onPageSizeChange(toPageSize(event.target.value))}
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <div className="inline-flex items-center gap-1">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="size-9"
            disabled={currentPage <= 1}
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            aria-label={t(language, "resource.previousPage")}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <span className="min-w-20 text-center font-semibold text-foreground">
            {currentPage} / {totalPages}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="size-9"
            disabled={currentPage >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
            aria-label={t(language, "resource.nextPage")}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ResourceListSkeleton({
  rows = 5,
}: {
  rows?: number;
}): React.ReactElement {
  return (
    <div className="glass-card overflow-hidden">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-4 border-b border-[var(--glass-border)] p-3 last:border-b-0"
        >
          <div className="h-3 w-16 animate-pulse rounded bg-muted" />
          <div className="h-3 flex-1 animate-pulse rounded bg-muted" />
          <div className="h-6 w-20 animate-pulse rounded-full bg-muted" />
        </div>
      ))}
    </div>
  );
}

export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function toPageSize(value: string): PageSize {
  const numeric = Number(value);
  return PAGE_SIZE_OPTIONS.includes(numeric as PageSize) ? (numeric as PageSize) : 10;
}
