/**
 * `_mantle_tz`: the site time zone's UTC-offset transitions, generated with Intl.DateTimeFormat (whose tzdata
 * ships with workerd and Node), so no time zone library is bundled (ADR-0034 decision 5).
 */
const US = 1_000_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function offsetSeconds(timeZone: string, epochSec: number): number {
  let f = formatters.get(timeZone);
  if (!f) formatters.set(timeZone, (f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })));
  const p: Record<string, number> = {};
  for (const { type, value } of f.formatToParts(new Date(epochSec * 1000))) if (type !== "literal") p[type] = +value;
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour === 24 ? 0 : p.hour!, p.minute!, p.second!) / 1000 - epochSec;
}

export interface TzRow {
  readonly from_us: number;
  readonly offset_us: number;
}

/** Rows `{ from_us, offset_us }`: from `from_us` on, local = UTC + offset_us. The first row starts at the beginning of time. */
export function transitions(timeZone: string, fromYear = 1970, toYear = 2100): TzRow[] {
  const start = Date.UTC(fromYear, 0, 1) / 1000;
  const end = Date.UTC(toYear, 0, 1) / 1000;
  const step = 3 * 86400;
  let prevT = start;
  let prevO = offsetSeconds(timeZone, start);
  const rows: TzRow[] = [{ from_us: -Number.MAX_SAFE_INTEGER, offset_us: prevO * US }];
  for (let t = start + step; t <= end; t += step) {
    const o = offsetSeconds(timeZone, t);
    if (o !== prevO) {
      let lo = prevT;
      let hi = t; // offset(lo) = prevO, offset(hi) = o: find the first second with the new offset
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetSeconds(timeZone, mid) === prevO) lo = mid;
        else hi = mid;
      }
      rows.push({ from_us: hi * US, offset_us: o * US });
      prevO = o;
    }
    prevT = t;
  }
  return rows;
}

/** Statements that replace `_mantle_tz`, chunked below D1's 100 KB limit (values are literals: D1 binds at most 100). */
export function tzStatements(rows: readonly TzRow[], chunk = 200): string[] {
  const out = ["DELETE FROM _mantle_tz"];
  for (let i = 0; i < rows.length; i += chunk)
    out.push(`INSERT INTO _mantle_tz (from_us, offset_us) VALUES ${rows.slice(i, i + chunk).map((r) => `(${r.from_us}, ${r.offset_us})`).join(", ")}`);
  return out;
}
