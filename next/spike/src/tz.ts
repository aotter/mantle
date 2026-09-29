// `_mantle_tz`: the site time zone's UTC-offset transitions, generated with Intl.DateTimeFormat
// (whose tzdata ships with workerd and Node). No time zone library. ADR-0034 decision 5.
const US = 1_000_000;

function offsetSeconds(fmt: Intl.DateTimeFormat, epochSec: number): number {
  const p: Record<string, number> = {};
  for (const { type, value } of fmt.formatToParts(new Date(epochSec * 1000))) if (type !== 'literal') p[type] = +value;
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second) / 1000;
  return wall - epochSec;
}

/** rows `{ from_us, offset_us }`: from `from_us` on, local = UTC + offset_us. The first row starts at the beginning of time. */
export function transitions(timeZone: string, fromYear = 1970, toYear = 2100): { from_us: number; offset_us: number }[] {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const start = Date.UTC(fromYear, 0, 1) / 1000, end = Date.UTC(toYear, 0, 1) / 1000, step = 3 * 86400;
  let prevT = start, prevO = offsetSeconds(fmt, start);
  const rows = [{ from_us: -Number.MAX_SAFE_INTEGER, offset_us: prevO * US }];
  for (let t = start + step; t <= end; t += step) {
    const o = offsetSeconds(fmt, t);
    if (o !== prevO) {
      let lo = prevT, hi = t; // offset(lo) = prevO, offset(hi) = o: find the first second with the new offset
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetSeconds(fmt, mid) === prevO) lo = mid; else hi = mid;
      }
      rows.push({ from_us: hi * US, offset_us: o * US });
      prevO = o;
    }
    prevT = t;
  }
  return rows;
}

/** INSERTs for `_mantle_tz`, chunked so no statement nears D1's 100 KB limit (values are literals, not binds: D1 binds at most 100). */
export function tzStatements(rows: { from_us: number; offset_us: number }[], chunk = 200): string[] {
  const out = ['DELETE FROM _mantle_tz'];
  for (let i = 0; i < rows.length; i += chunk)
    out.push(`INSERT INTO _mantle_tz (from_us, offset_us) VALUES ${rows.slice(i, i + chunk).map((r) => `(${r.from_us}, ${r.offset_us})`).join(', ')}`);
  return out;
}
