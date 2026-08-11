const CURSOR_PREFIX = "o:";
const MAX_CURSOR_OFFSET = 1_000_000;
const ENTRY_CURSOR_PREFIX = "e:";

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

export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
