// Type encodings (ADR-0034 decision 5) and the boundary codec.
//   timestamptz -> INTEGER microseconds since the epoch (exact to 2255: 2^53 us)
//   date        -> INTEGER days since 1970-01-01
//   numeric(p,s)-> INTEGER scaled by 10^s, p <= 15 (D1 rounds integers past 2^53)
import { SqlRefusal as Refused, parseNumeric } from '../../spec/index.js';

const US_PER_DAY = 86_400_000_000;

/** SQLite storage class a Mantle type is bound and CAST as. Every bind goes through `CAST(?n AS <this>)`. */
export function sqliteType(type: string): 'text' | 'integer' | 'real' {
  if (parseNumeric(type)) return 'integer';
  switch (type) {
    case 'text': case 'json': case 'geo': return 'text';
    case 'int4': case 'int8': case 'integer': case 'bool': case 'timestamptz': case 'date': return 'integer';
    case 'float8': case 'real': return 'real';
  }
  throw new Refused('SQL_TYPE', `unknown type ${type}`);
}

/** '12.34' (or a number) -> 1234n at scale 2. Refuses digits beyond the scale rather than rounding silently. */
export function encodeNumeric(v: string | number, p: number, s: number): number {
  const str = typeof v === 'number' ? v.toString() : v.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(str);
  if (!m) throw new Refused('SQL_TYPE', `${str} is not a decimal number`);
  const frac = m[3] ?? '';
  if (frac.length > s) throw new Refused('SQL_TYPE', `${str} has more than ${s} fractional digits`);
  const digits = m[2] + frac.padEnd(s, '0');
  if (digits.replace(/^0+/, '').length > p) throw new Refused('SQL_TYPE', `${str} does not fit numeric(${p}, ${s})`);
  const n = Number(digits);
  return m[1] ? -n : n;
}
export function decodeNumeric(n: number, s: number): string {
  const neg = n < 0;
  const d = Math.abs(n).toString().padStart(s + 1, '0');
  const out = s ? `${d.slice(0, -s)}.${d.slice(-s)}` : d;
  return neg ? `-${out}` : out;
}

/** ISO-8601 with an explicit offset (or Z) -> microseconds. Refuses a zone-less timestamp. */
export function encodeTimestamptz(v: string | Date | number): number {
  if (v instanceof Date) return v.getTime() * 1000;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Refused('SQL_TYPE', `${v} is not a whole number of microseconds within 2^53`);
    return v;
  }
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d(?::\d\d)?)(?:\.(\d{1,6}))?(Z|[+-]\d\d(?::?\d\d)?)$/.exec(v.trim());
  if (!m) throw new Refused('SQL_TYPE', `'${v}' is not a timestamp with an explicit offset`);
  const [, day, time, fraction, offset] = m as unknown as string[];
  const frac = (fraction ?? '').padEnd(6, '0');
  const zone = offset === 'Z' ? 'Z' : offset!.length === 3 ? `${offset}:00` : offset!.includes(':') ? offset! : `${offset!.slice(0, 3)}:${offset!.slice(3)}`;
  const secs = Date.parse(`${day}T${time!.length === 5 ? time + ':00' : time}${zone}`);
  encodeDate(day!); // Date.parse rolls 2026-02-30 over to March; a day that does not exist is refused
  const micros = secs * 1000 + Number(frac);
  if (Number.isNaN(secs) || !Number.isSafeInteger(micros)) throw new Refused('SQL_TYPE', `'${v}' is not a valid timestamp`);
  return micros;
}
export function decodeTimestamptz(us: number): string {
  const ms = Math.floor(us / 1000), rest = us - ms * 1000;
  return new Date(ms).toISOString().replace('Z', String(rest).padStart(3, '0') + 'Z');
}
export function encodeDate(v: string | Date): number {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(typeof v === 'string' ? v : v.toISOString().slice(0, 10));
  if (!m) throw new Refused('SQL_TYPE', `'${v}' is not a date`);
  const [, y, mo, d] = m as unknown as string[];
  const dt = new Date(0);
  dt.setUTCFullYear(+y!, +mo! - 1, +d!); // Date.UTC would read years 0 to 99 as 1900 to 1999
  const days = dt.getTime() / (US_PER_DAY / 1000);
  if (dt.getUTCDate() !== +d!) throw new Refused('SQL_TYPE', `'${v}' is not a valid date`);
  return days;
}
export const decodeDate = (days: number) => new Date(days * 86_400_000).toISOString().slice(0, 10);

/** JS value -> the value bound for an input of this declared type. */
export function encodeInput(type: string, v: any): unknown {
  if (v === null || v === undefined) return null;
  const num = parseNumeric(type);
  if (num) return encodeNumeric(v, num.p, num.s);
  switch (type) {
    case 'int4': case 'int8': case 'integer':
      if (!Number.isSafeInteger(v)) throw new Refused('SQL_TYPE', `${v} is not a safe integer: D1 rounds integers past 2^53`);
      return v;
    case 'float8': case 'real': return v;
    case 'bool': return v ? 1 : 0;
    case 'text': return String(v);
    case 'json': return typeof v === 'string' ? v : JSON.stringify(v);
    case 'timestamptz': return encodeTimestamptz(v);
    case 'date': return encodeDate(v);
  }
  throw new Refused('SQL_TYPE', `cannot encode ${type}`);
}
export function decodeOutput(type: string, v: any): unknown {
  if (v === null || v === undefined) return null;
  const num = parseNumeric(type);
  if (num) return decodeNumeric(v, num.s);
  switch (type) {
    case 'bool': return v === 1;
    case 'timestamptz': return decodeTimestamptz(v);
    case 'date': return decodeDate(v);
    case 'json': return JSON.parse(v);
  }
  return v;
}
