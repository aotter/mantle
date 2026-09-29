// Type encodings (ADR-0034 decision 5) and the boundary codec.
//   timestamptz -> INTEGER microseconds since the epoch (exact to 2255: 2^53 us)
//   date        -> INTEGER days since 1970-01-01
//   numeric(p,s)-> INTEGER scaled by 10^s, p <= 15 (D1 rounds integers past 2^53)
import { Refused } from './types.ts';

export const MAX_NUMERIC_P = 15;
const US_PER_DAY = 86_400_000_000;

export function parseNumeric(type: string): { p: number; s: number } | undefined {
  const m = /^numeric\((\d+),\s*(\d+)\)$/.exec(type);
  if (!m) return undefined;
  const p = +m[1], s = +m[2];
  if (p > MAX_NUMERIC_P || s > p) throw new Refused('SQL_TYPE', `numeric(${p}, ${s}) is refused: precision is at most ${MAX_NUMERIC_P}, scale at most precision`);
  return { p, s };
}

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
  if (typeof v === 'number') return v;
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d(?::\d\d)?)(?:\.(\d{1,6}))?(Z|[+-]\d\d(?::?\d\d)?)$/.exec(v.trim());
  if (!m) throw new Refused('SQL_TYPE', `'${v}' is not a timestamp with an explicit offset`);
  const frac = (m[3] ?? '').padEnd(6, '0');
  const zone = m[4] === 'Z' ? 'Z' : m[4].length === 3 ? `${m[4]}:00` : m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
  const secs = Date.parse(`${m[1]}T${m[2].length === 5 ? m[2] + ':00' : m[2]}${zone}`);
  if (Number.isNaN(secs)) throw new Refused('SQL_TYPE', `'${v}' is not a valid timestamp`);
  return secs * 1000 + Number(frac);
}
export function decodeTimestamptz(us: number): string {
  const ms = Math.floor(us / 1000), rest = us - ms * 1000;
  return new Date(ms).toISOString().replace('Z', String(rest).padStart(3, '0') + 'Z');
}
export function encodeDate(v: string | Date): number {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(typeof v === 'string' ? v : v.toISOString().slice(0, 10));
  if (!m) throw new Refused('SQL_TYPE', `'${v}' is not a date`);
  const days = Date.UTC(+m[1], +m[2] - 1, +m[3]) / (US_PER_DAY / 1000);
  if (new Date(days * 86_400_000).getUTCDate() !== +m[3]) throw new Refused('SQL_TYPE', `'${v}' is not a valid date`);
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

/** PostgreSQL `interval` literal -> microseconds. Only second, minute and hour: day and longer are calendar units. */
const UNIT_US: Record<string, number> = { second: 1e6, sec: 1e6, s: 1e6, minute: 6e7, min: 6e7, m: 6e7, hour: 3.6e9, hr: 3.6e9, h: 3.6e9 };
const TYPMOD_UNIT: Record<number, string> = { 1024: 'hour', 2048: 'minute', 4096: 'second' };
export function intervalMicros(text: string, typmod?: number): number {
  let m = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+?)s?\s*$/i.exec(text);
  if (!m && typmod !== undefined && TYPMOD_UNIT[typmod] && /^\s*-?\d+(\.\d+)?\s*$/.test(text)) m = [text, text.trim(), TYPMOD_UNIT[typmod]] as any;
  if (!m) throw new Refused('SQL_TYPE', `interval '${text}' is not supported: write a number and second, minute or hour`);
  const unit = UNIT_US[m[2].toLowerCase()];
  if (!unit) throw new Refused('SQL_TYPE', `interval unit '${m[2]}' is a calendar unit (a day is 23 or 25 hours across daylight saving): bind the boundary as an input instead`);
  return Math.round(Number(m[1]) * unit);
}
