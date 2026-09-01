export function developerSelectionHref(
  pathname: "/admin/dev" | "/admin/dev/model" | "/admin/dev/logic",
  selectedId: string | null,
  extra: Record<string, string | null> = {},
): string {
  const search = new URLSearchParams();
  if (selectedId) search.set("selected", selectedId);
  for (const [key, value] of Object.entries(extra)) if (value) search.set(key, value);
  return `${pathname}${search.size ? `?${search}` : ""}`;
}

export function developerDetailHref(
  selectedId: string,
  extra: Record<string, string | null> = {},
): string {
  const pathname = selectedId.startsWith("Schema:") || selectedId.startsWith("View:")
    ? "/admin/dev/model"
    : "/admin/dev/logic";
  return developerSelectionHref(pathname, selectedId, extra);
}
