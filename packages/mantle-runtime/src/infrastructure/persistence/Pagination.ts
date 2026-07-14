const CURSOR_PREFIX = "o:";
const MAX_CURSOR_OFFSET = 1_000_000;

export function encodeCursor(offset: number): string {
  return `${CURSOR_PREFIX}${offset}`;
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor?.startsWith(CURSOR_PREFIX)) return 0;
  const offset = Number(cursor.slice(CURSOR_PREFIX.length));
  return Number.isInteger(offset) && offset >= 0 && offset <= MAX_CURSOR_OFFSET ? offset : 0;
}

export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
