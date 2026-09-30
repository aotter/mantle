/**
 * Type rules the SQL allowlist needs (ADR-0034 decisions 2 and 5): `numeric(p, s)`
 * bounds and `interval` literals. Pure; a refusal is a `SqlRefusal`.
 */
import { SqlRefusal } from "./SqlRefusal.js";

export const MAX_NUMERIC_P = 15;

export function parseNumeric(type: string): { p: number; s: number } | undefined {
  const m = /^numeric\((\d+),\s*(\d+)\)$/.exec(type);
  if (!m) return undefined;
  const p = +m[1]!, s = +m[2]!;
  if (p > MAX_NUMERIC_P || s > p) throw new SqlRefusal('SQL_TYPE', `numeric(${p}, ${s}) is refused: precision is at most ${MAX_NUMERIC_P}, scale at most precision`);
  return { p, s };
}

/** PostgreSQL `interval` literal -> microseconds. Only second, minute and hour: day and longer are calendar units. */
const UNIT_US: Record<string, number> = Object.fromEntries(
  (['second seconds sec secs s', 'minute minutes min mins m', 'hour hours hr hrs h'] as const).flatMap((names, i) => names.split(' ').map((u) => [u, [1e6, 6e7, 3.6e9][i]!])),
);
const TYPMOD_UNIT: Record<number, string> = { 1024: 'hour', 2048: 'minute', 4096: 'second' };
export function intervalMicros(text: string, typmod?: number): number {
  let m = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(text);
  if (!m && typmod !== undefined && TYPMOD_UNIT[typmod] && /^\s*-?\d+(\.\d+)?\s*$/.test(text)) m = [text, text.trim(), TYPMOD_UNIT[typmod]] as any;
  if (!m) throw new SqlRefusal('SQL_TYPE', `interval '${text}' is not supported: write a number and second, minute or hour`);
  const unit = UNIT_US[m[2]!.toLowerCase()];
  if (!unit && /^(days?|weeks?|months?|mons?|years?|y)$/i.test(m[2]!)) throw new SqlRefusal('SQL_TYPE', `interval unit '${m[2]}' is a calendar unit (a day is 23 or 25 hours across daylight saving): bind the boundary as an input instead`);
  if (!unit) throw new SqlRefusal('SQL_TYPE', `interval '${text}' is not supported: write a number and second, minute or hour`);
  return Math.round(Number(m[1]) * unit);
}
