/** RFC 4180 cells; neutralize spreadsheet formulas in text only. */
export function csvCell(value: unknown, quote = false): string {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const safe = typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]|^[\t\r]/u.test(text) ? "'" + text : text;
  return quote || /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
