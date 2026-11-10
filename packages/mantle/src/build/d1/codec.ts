// Type encodings (ADR-0034 decision 5) and the boundary codec.
//   timestamptz -> INTEGER microseconds since the epoch (exact to 2255: 2^53 us)
//   date        -> INTEGER days since 1970-01-01
//   numeric(p,s)-> INTEGER scaled by 10^s, p <= 15 (D1 rounds integers past 2^53)
import { SqlRefusal as Refused, parseNumeric } from '../spec/domain/index.js';
import * as scalars from '../../kernel/scalars.js';

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

/** The request-time scalar checks (ISO with an explicit offset -> microseconds or canonical text, a calendar day -> days or
 *  itself), refusing as the compiler does. */
const refused = <T>(check: (v: string) => T) => (v: string): T => {
  try { return check(v); } catch (e) { throw new Refused('SQL_TYPE', (e as Error).message); }
};
export const encodeTimestamptz = refused(scalars.encodeTimestamptz), encodeDate = refused(scalars.encodeDate);
export const isoTimestamptz = refused(scalars.isoTimestamptz), isoDate = refused(scalars.isoDate);
