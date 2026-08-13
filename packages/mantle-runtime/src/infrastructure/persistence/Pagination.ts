const CURSOR_PREFIX = "o:";
const MAX_CURSOR_OFFSET = 1_000_000;
const ENTRY_CURSOR_PREFIX = "e:";
const SORT_CURSOR_PREFIX = "s:";

export type EntryCursorValue = string | number;

export function encodeCursor(offset: number): string {
  return `${CURSOR_PREFIX}${offset}`;
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor?.startsWith(CURSOR_PREFIX)) return 0;
  const offset = Number(cursor.slice(CURSOR_PREFIX.length));
  return Number.isInteger(offset) && offset >= 0 && offset <= MAX_CURSOR_OFFSET ? offset : 0;
}

export function encodeEntryCursor(updatedAt: number, id: string): string {
  return `${ENTRY_CURSOR_PREFIX}${updatedAt}:${encodeURIComponent(id)}`;
}

export function decodeEntryCursor(
  cursor: string | undefined,
): readonly [updatedAt: number, id: string] | null {
  if (!cursor?.startsWith(ENTRY_CURSOR_PREFIX)) return null;
  const separator = cursor.indexOf(":", ENTRY_CURSOR_PREFIX.length);
  if (separator < 0) return null;
  const updatedAt = Number(cursor.slice(ENTRY_CURSOR_PREFIX.length, separator));
  try {
    const id = decodeURIComponent(cursor.slice(separator + 1));
    return Number.isSafeInteger(updatedAt) && updatedAt >= 0 && id
      ? [updatedAt, id]
      : null;
  } catch {
    return null;
  }
}

export function encodeEntrySortCursor(
  field: string,
  direction: "asc" | "desc",
  value: EntryCursorValue,
  id: string,
): string {
  if (field === "updatedAt" && direction === "desc" && typeof value === "number") {
    return encodeEntryCursor(value, id);
  }
  return `${SORT_CURSOR_PREFIX}${encodeURIComponent(JSON.stringify([field, direction, value, id]))}`;
}

export function decodeEntrySortCursor(
  cursor: string | undefined,
  field: string,
  direction: "asc" | "desc",
): readonly [value: EntryCursorValue, id: string] | null {
  if (field === "updatedAt" && direction === "desc") return decodeEntryCursor(cursor);
  if (!cursor?.startsWith(SORT_CURSOR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(cursor.slice(SORT_CURSOR_PREFIX.length))) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [cursorField, cursorDirection, value, id] = parsed;
    return cursorField === field &&
        cursorDirection === direction &&
        (typeof value === "string" || typeof value === "number") &&
        typeof id === "string" && id
      ? [value, id]
      : null;
  } catch {
    return null;
  }
}

export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
