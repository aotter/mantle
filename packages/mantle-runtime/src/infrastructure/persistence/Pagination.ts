import type { Entry } from "@aotter/mantle-spec";
import type { PublishedEntryPage, ReadPublishedPageArgs } from "../../domain/port/EntryReader.js";

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

export const PUBLISHED_PAGE_DATA_BUDGET = 1_048_576;

export function publishedPageLimit(limit?: number): number {
  return typeof limit === "number" && Number.isFinite(limit) && limit >= 1
    ? Math.min(2000, Math.floor(limit)) : 50;
}

/** In-memory adapters share the semantic cursor, projection and byte-budget rules. */
export function paginatePublishedEntries(entries: readonly Entry[], args: ReadPublishedPageArgs): PublishedEntryPage {
  const cursor = decodeEntryCursor(args.cursor);
  const eligible = entries.filter((entry) => !cursor || entry.updatedAt < cursor[0]
    || (entry.updatedAt === cursor[0] && entry.id < cursor[1]))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const rows: Entry[] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const entry of eligible.slice(0, publishedPageLimit(args.limit) + 1)) {
    const data = args.dataFields ? Object.fromEntries(args.dataFields.map((field) => [field, entry.data[field] ?? null])) : entry.data;
    const size = encoder.encode(JSON.stringify(data)).byteLength;
    if (rows.length && (rows.length >= publishedPageLimit(args.limit) || bytes + size > PUBLISHED_PAGE_DATA_BUDGET)) break;
    rows.push({ ...entry, data });
    bytes += size;
  }
  const last = rows.at(-1);
  return { rows, ...(last && eligible.length > rows.length ? { nextCursor: encodeEntryCursor(last.updatedAt, last.id) } : {}) };
}
