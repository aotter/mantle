export function initialsFor(value: string | null): string {
  const parts = value?.trim().split(/[\s._-]+/).filter(Boolean) ?? [];
  const initials = parts.length > 1
    ? `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`
    : (parts[0] ?? "?").slice(0, 2);
  return initials.toUpperCase();
}
