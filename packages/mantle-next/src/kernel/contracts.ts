/** Boundary primitives only. No plan, SQL interpreter or resource ownership. */
import type { ZodType } from "zod";
type StaffRole = "owner" | "editor" | "contributor";
export type CredentialKind = "session" | "oauth" | "api-key" | "personal-token";

export type Caller =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "user";
      /** Application subject key: opaque, stable, unique across issuers. Never an email. */
      readonly subject: string;
      /** Informational. */
      readonly issuer?: string;
      readonly role: StaffRole | null;
      readonly scopes: readonly string[];
      readonly credential: CredentialKind;
      /** Opaque record id or token JTI, never the raw credential. */
      readonly credentialId: string | null;
      readonly clientId: string | null;
    }
  | { readonly kind: "system"; readonly reason: string };


export class ContractError extends Error {
  constructor(readonly code: string, message: string, readonly path = "", options?: ErrorOptions) {
    super(message, options);
    this.name = "ContractError";
  }
}

/** Validate with a generated official Zod schema. Never import/compile JSON Schema here. */
export function validate<T>(schema: ZodType<T>, value: unknown, path: string, code = "INPUT_VALIDATION_FAILED"): T {
  try {
    assertJsonLimits(value, path);
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const pointer = issue?.path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
    throw new ContractError(code, code === "OUTPUT_VALIDATION_FAILED" ? "Procedure output does not match its declared schema." : issue?.message ?? "validation failed", path + (pointer ? "/" + pointer : ""));
  } catch (error) {
    if (error instanceof ContractError) throw new ContractError(code, error.message, error.path);
    throw new ContractError(code, "the schema cannot check this value", path);
  }
}

/** Same finite JSON boundary as 0.2; paths may share objects but may not cycle. */
function assertJsonLimits(value: unknown, path: string): void {
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }];
  const active = new WeakSet<object>();
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.value === null || typeof current.value !== "object") continue;
    if (current.exit) { active.delete(current.value); continue; }
    if (active.has(current.value) || current.depth > 100 || ++nodes > 10000)
      throw new ContractError("INPUT_VALIDATION_FAILED", "value exceeds JSON validation limits or contains cycles", path);
    active.add(current.value);
    stack.push({ ...current, exit: true });
    for (const child of Array.isArray(current.value) ? current.value : Object.values(current.value))
      stack.push({ value: child, depth: current.depth + 1 });
  }
}

/** Scalar representations reuse 0.2 codec rules; generated code chooses the scalar directly. */
class Refused extends ContractError {
  constructor(code: string, message: string) { super(code, message); }
}
export function encodeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new ContractError("SQL_TYPE", "value must be a safe integer");
  return value as number;
}
const US_PER_DAY = 86_400_000_000;
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

/** A json column's text as its value. Text that is not JSON (a bare string a SQL literal wrote) reads back as that string, never a throw. */
export function decodeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}


/** Native PG scalar wire decoding, reused from 0.2. No query or plan execution. */
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

/** Classify native failures without interpreting SQL or leaking engine messages. */
export function databaseError(error: unknown, operation: "read" | "write", path: string, dialect: "sqlite" | "postgres"): ContractError {
  if (error instanceof ContractError) return error;
  const value = (error ?? {}) as { code?: unknown; errno?: unknown; errcode?: unknown; name?: string; message?: string };
  const message = error instanceof Error ? error.message : String(error);
  let code = operation === "write" ? "OUTCOME_UNKNOWN" : "RESOURCE_UNAVAILABLE";
  if (dialect === "postgres") {
    const state = typeof value.code === "string" && /^[0-9A-Z]{5}$/.test(value.code) ? value.code : undefined;
    if (state === "23505" || state === "MX409") code = "CONFLICT";
    else if (state && /^(22|23|42)/.test(state)) code = "INPUT_VALIDATION_FAILED";
    else if (state && /^(08|28|53|57|58|XX)/.test(state)) code = operation === "write" ? "OUTCOME_UNKNOWN" : "RESOURCE_UNAVAILABLE";
    else if (state === "40001" || state === "40P01") code = "RESOURCE_UNAVAILABLE";
    else if (state) code = "INPUT_VALIDATION_FAILED";
  } else {
    const primary = typeof value.errcode === "number" ? value.errcode & 255 : value.name === "SQLiteError" && typeof value.errno === "number" ? value.errno & 255 : undefined;
    const text = message + " " + String(value.code ?? "");
    if (/CONFLICT op=\d+|UNIQUE constraint failed/.test(message)) code = "CONFLICT";
    else if (!/SQLITE_(BUSY|LOCKED|NOMEM|IOERR|FULL|INTERRUPT)/.test(text) && !(primary !== undefined && [5, 6, 7, 9, 10, 13].includes(primary)) && (/SQLITE_[A-Z_]+/.test(text) || primary !== undefined)) code = "INPUT_VALIDATION_FAILED";
  }
  return new ContractError(code, code === "CONFLICT" ? "The write conflicted with database state." : code === "OUTCOME_UNKNOWN" ? "The write outcome is unknown; reconcile before retrying." : "The database operation failed.", path, { cause: error });
}
