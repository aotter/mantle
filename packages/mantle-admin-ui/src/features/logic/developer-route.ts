export function developerSelectionHref(
  pathname: `/admin/dev${string}`,
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
  const pathname = selectedId.startsWith("Schema:") ? "/admin/dev/model/schemas"
    : selectedId.startsWith("View:") ? "/admin/dev/model/views"
    : selectedId.startsWith("Trigger:") ? "/admin/dev/logic/triggers"
    : "/admin/dev/logic/procedures";
  return developerSelectionHref(pathname, selectedId, extra);
}
