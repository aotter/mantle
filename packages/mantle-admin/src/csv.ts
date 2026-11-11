/** RFC 4180 cells; neutralize spreadsheet formulas in text only. */
export function csvCell(value: unknown, quote = false): string {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const safe = typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]|^[\t\r]/u.test(text) ? "'" + text : text;
  return quote || /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A CSV file as Admin exports a View: a BOM, the header, then one CRLF line per row. */
export function csvText(columns: readonly string[], rows: readonly Readonly<Record<string, unknown>>[]): string {
  const line = (values: readonly unknown[]) => values.map(value => csvCell(value)).join(",") + "\r\n";
  return "﻿" + line(columns) + rows.map(row => line(columns.map(column => row[column]))).join("");
}
