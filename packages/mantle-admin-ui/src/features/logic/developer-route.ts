export function developerSelectionHref(
  pathname: "/admin/dev" | "/admin/dev/model",
  selectedId: string | null,
  extra: Record<string, string | null> = {},
): string {
  const search = new URLSearchParams();
  if (selectedId) search.set("selected", selectedId);
  for (const [key, value] of Object.entries(extra)) if (value) search.set(key, value);
  return `${pathname}${search.size ? `?${search}` : ""}`;
}
