/**
 * Declared date-time and date inputs are ISO on every target (the handbook's wire form). A timestamp needs an explicit
 * Z or offset; a day that does not exist (2026-02-30) is refused rather than rolled over. SQLite stores microseconds
 * and days; PostgreSQL receives the canonical text, so it keeps every microsecond.
 */
import { ContractError } from "./contracts.js";

export function encodeTimestamptz(v: string | Date): number {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new ContractError("SQL_TYPE", "Invalid Date is not a timestamp");
    return v.getTime() * 1000;
  }
  // hours 00-23: Date.parse would roll T24:00 over to the next day
  const m = /^(\d{4}-\d\d-\d\d)[T ]((?:[01]\d|2[0-3]):\d\d(?::\d\d)?)(?:\.(\d{1,6}))?(Z|[+-]\d\d(?::?\d\d)?)$/.exec(String(v).trim());
  if (!m) throw new ContractError("SQL_TYPE", `'${v}' is not a timestamp with an explicit offset`);
  const [, day, time, fraction, offset] = m as unknown as string[];
  const zone = offset === "Z" ? "Z" : offset!.length === 3 ? `${offset}:00` : offset!.includes(":") ? offset! : `${offset!.slice(0, 3)}:${offset!.slice(3)}`;
  const secs = Date.parse(`${day}T${time!.length === 5 ? time + ":00" : time}${zone}`);
  encodeDate(day!);
  const micros = secs * 1000 + Number((fraction ?? "").padEnd(6, "0"));
  if (Number.isNaN(secs) || !Number.isSafeInteger(micros)) throw new ContractError("SQL_TYPE", `'${v}' is not a valid timestamp`);
  return micros;
}
/** A date is the string a calendar shows; a Date instant has no single calendar day, so it is not accepted. */
export function encodeDate(v: string): number {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(String(v));
  if (!m) throw new ContractError("SQL_TYPE", `'${v}' is not a date`);
  const [, y, mo, d] = m as unknown as string[];
  const dt = new Date(0);
  dt.setUTCFullYear(+y!, +mo! - 1, +d!); // Date.UTC would read years 0 to 99 as 1900 to 1999
  if (dt.getUTCDate() !== +d! || dt.getUTCMonth() !== +mo! - 1) throw new ContractError("SQL_TYPE", `'${v}' is not a valid date`);
  return dt.getTime() / 86_400_000;
}
export function isoTimestamptz(v: string | Date): string {
  const us = encodeTimestamptz(v), ms = Math.floor(us / 1000);
  return new Date(ms).toISOString().replace("Z", String(us - ms * 1000).padStart(3, "0") + "Z");
}
export const isoDate = (v: string): string => new Date(encodeDate(v) * 86_400_000).toISOString().slice(0, 10);
