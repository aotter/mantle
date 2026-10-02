// The PostgreSQL dialect's wire values (ADR-0034 decision 5, ADR-0035 decision 3). Columns have native types, so a value is
// sent as PostgreSQL reads it and read back by the type PostgreSQL reports for its column (`decodeField`), computed or not.
// The D1 encoders still check a value first, so both dialects refuse the same values with the same messages.
import { SqlRefusal as Refused, parseNumeric } from "../spec/domain/index.js";
import { decodeDate, decodeNumeric, decodeTimestamptz, encodeDate, encodeNumeric, encodeTimestamptz } from "../d1/codec.js";

/** A Mantle type as a PostgreSQL type name, for a column and for a cast. */
export function pgType(type: string): string {
  const num = parseNumeric(type);
  if (num) return `numeric(${num.p}, ${num.s})`;
  switch (type) {
    case "text": case "geo": return "text";
    case "json": return "jsonb";
    case "int4": return "int4";
    case "int8": case "integer": return "int8";
    case "float8": case "real": return "float8";
    case "bool": return "bool";
    case "timestamptz": return "timestamptz";
    case "date": return "date";
  }
  throw new Refused("SQL_TYPE", `unknown type ${type}`);
}

/** JS value -> the parameter sent for an input of this declared type. */
export function encodeInput(type: string, v: any): unknown {
  if (v === null || v === undefined) return null;
  const num = parseNumeric(type);
  if (num) return decodeNumeric(encodeNumeric(v, num.p, num.s), num.s);
  switch (type) {
    case "int4": case "int8": case "integer":
      if (!Number.isSafeInteger(v)) throw new Refused("SQL_TYPE", `${v} is not a safe integer`);
      return v;
    case "float8": case "real": return v;
    case "bool": return !!v;
    case "text": case "geo": return String(v);
    case "json": return JSON.stringify(v);
    case "timestamptz": return decodeTimestamptz(encodeTimestamptz(v));
    case "date": return decodeDate(encodeDate(v));
  }
  throw new Refused("SQL_TYPE", `cannot encode ${type}`);
}

/** A declared column's value, already decoded by its PostgreSQL type, as the Store's wire value of its Mantle type. */
export function decodeOutput(type: string, v: any): unknown {
  if (v === null || v === undefined) return null;
  const num = parseNumeric(type);
  if (num) return typeof v === "number" ? decodeNumeric(Math.round(v * 10 ** num.s), num.s) : String(v);
  switch (type) {
    case "bool": return typeof v === "boolean" ? v : v === 1;
    case "timestamptz": return typeof v === "number" ? decodeTimestamptz(v) : v;
    case "json": if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } } return v;
  }
  return v;
}

/** `2026-10-01 12:00:00.5+08` (PostgreSQL's text output, any session zone) -> `2026-10-01T04:00:00.500000Z`. */
function isoInstant(text: string): string {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?([+-]\d\d)(?::?(\d\d))?(?::?(\d\d))?$/.exec(text);
  if (!m) return text; // infinity, BC dates: as PostgreSQL wrote them
  const [, day, time, frac = "", h, mi = "00", sec = "00"] = m;
  const ms = Date.parse(`${day}T${time}${h}:${mi}`) - Number(`${h![0]}1`) * Number(sec) * 1000;
  return `${new Date(ms).toISOString().slice(0, 19)}.${frac.padEnd(6, "0")}Z`;
}

/** `1 day 12:00:00` -> microseconds, as D1 returns an interval; an interval with months has no fixed length and stays text. */
function intervalValue(text: string): number | string {
  const m = /^(?:(-?\d+) days? ?)?(?:([+-])?(\d+):(\d\d):(\d\d)(?:\.(\d{1,6}))?)?$/.exec(text);
  if (!m || text === "") return text;
  const [, days = "0", sign, hh = "0", mm = "0", ss = "0", frac = ""] = m;
  const clock = ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1_000_000 + Number(frac.padEnd(6, "0"));
  return Number(days) * 86_400_000_000 + (sign === "-" ? -clock : clock);
}

/**
 * Every value arrives as PostgreSQL's text; its column's type OID says what it is. Unknown types stay text. A numeric with a
 * declared scale (`numeric(12, 2)`, typmod set) is exact decimal text, as the Store returns a numeric field; an unconstrained
 * one (`avg`, `sum` of integers) is a number, as D1 returns it.
 */
export function decodeField(oid: number, text: string | null, typmod = -1): unknown {
  if (text === null) return null;
  switch (oid) {
    case 16: return text === "t";
    case 20: case 21: case 23: case 26: { const n = Number(text); return Number.isSafeInteger(n) ? n : text; }
    case 1700: return typmod >= 0 ? text : Number(text);
    case 700: case 701: return Number(text);
    case 114: case 3802: return JSON.parse(text);
    case 1184: return isoInstant(text);
    case 1186: return intervalValue(text);
  }
  return text;
}
