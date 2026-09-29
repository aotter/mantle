// Conformance case 6: types. `? / 2` with an integer input, `sum` over numeric(12, 2), a microsecond
// timestamp against `now() - interval '36 hours'`, and `date_trunc('day', ts)` on a daylight-saving day
// in the site time zone give PostgreSQL's results on D1; `interval '1 day'` is refused.
import type { Report } from '../src/report.ts';
import { NOW, boot, caller, program, site } from '../src/fixtures.ts';
import { compileProgram, render, runProcedure, runView } from '../src/exec.ts';
import { decodeDate, decodeNumeric, decodeOutput, encodeDate, encodeInput, encodeTimestamptz } from '../src/codec.ts';
import { localParts, transitions, tzStatements } from '../src/tz.ts';
import { tryLower } from '../src/lower.ts';
import { schemas } from '../src/fixtures.ts';
import { Refused } from '../src/types.ts';

const HOUR = 3_600_000_000;
const WHOLE_HOUR = new Set(['America/New_York', 'Europe/Berlin', 'Pacific/Apia', 'Asia/Taipei']);

export async function run(r: Report) {
  r.section('Case 6: types (integer division, numeric, microseconds, dates, CAST)');
  const b = await boot();
  const s = site(b);
  const view = async (sql: string, inputs: Record<string, string> = {}, input: Record<string, unknown> = {}) =>
    (await runView(s, await program('view', sql, inputs), caller(input))).rows;
  const insert = async (sql: string, inputs: Record<string, string>, input: Record<string, unknown>) => runProcedure(s, await program('procedure', sql, inputs), caller(input));

  // ---- A. every bind is CAST to its declared type ------------------------------------------------------------
  r.note('D1 binds a JavaScript number as a floating-point value:');
  r.equal('  raw D1: ?1 / 2 with 5 is 2.5 (not PostgreSQL\'s 2)', (await b.d1.all('SELECT ?1 / 2 AS x', [5]))[0].x, 2.5);
  r.equal('  raw D1: CAST(?1 AS integer) / 2 with 5 is 2', (await b.d1.all('SELECT CAST(?1 AS integer) / 2 AS x', [5]))[0].x, 2);
  const arith = await view("SELECT input.n / 2 AS h, input.n % 2 AS m, input.n * 3 AS t FROM items WHERE id = 'a'", { n: 'int8' }, { n: 5 });
  r.equal('input.n / 2 with n = 5 (int8) is 2, like PostgreSQL integer division', arith, [{ h: 2, m: 1, t: 15 }]);
  r.equal('and truncates toward zero for a negative input, like PostgreSQL', await view("SELECT input.n / 2 AS h, input.n % 2 AS m FROM items WHERE id = 'a'", { n: 'int8' }, { n: -5 }), [{ h: -2, m: -1 }]);
  r.equal('a float8 input keeps its fraction: 5 / 2 = 2.5', await view("SELECT input.x / 2 AS h FROM items WHERE id = 'a'", { x: 'float8' }, { x: 5 }), [{ h: 2.5 }]);
  r.equal('a text input stays text through the CAST (leading zeros kept)', await view("SELECT input.s AS s FROM items WHERE id = 'a'", { s: 'text' }, { s: '007' }), [{ s: '007' }]);
  r.equal('a bool input binds as 1', await view("SELECT input.b AS b FROM items WHERE id = 'a'", { b: 'bool' }, { b: true }), [{ b: 1 }]);
  const sql = render(compileProgram(s, await program('view', "SELECT input.n / 2 AS h FROM items WHERE id = 'a'", { n: 'int8' }))[0]);
  r.check('the printed SQL carries CAST(?n AS integer)', /CAST\(\?\d AS integer\) \/ 2/.test(sql), sql.slice(0, 60));
  const big = (() => { try { encodeInput('int8', 2 ** 53); return 'accepted'; } catch (e) { return e instanceof Refused ? e.message : String(e); } })();
  r.check('an integer input past 2^53 is refused before it can be rounded', big.startsWith('9007199254740992 is not a safe integer'), big);
  r.check('a non-integer for an int8 input is refused', (() => { try { encodeInput('int8', 5.5); return false; } catch { return true; } })());
  r.equal('D1 itself rounds integers past 2^53 without an error', (await b.d1.all('SELECT 9007199254740993 AS x'))[0].x, 9007199254740992);

  // ---- B. numeric(12, 2) is an integer count of cents ---------------------------------------------------------
  const ins = 'INSERT INTO events (title, amount) VALUES (input.t, input.a)';
  for (const [t, a] of [['a', '0.10'], ['b', '0.20'], ['c', '0.10'], ['d', '-0.05']]) await insert(ins, { t: 'text', a: 'numeric(12,2)' }, { t, a });
  const stored = (await b.d1.all("SELECT title, amount FROM events WHERE title IN ('a','b','d') ORDER BY title")).map((x: any) => x.amount);
  r.equal('stored as integers: 0.10, 0.20, -0.05 are 10, 20, -5', stored, [10, 20, -5]);
  const agg = (await view('SELECT sum(amount) AS s, min(amount) AS lo, max(amount) AS hi FROM events WHERE title IN (\'a\', \'b\', \'c\')'))[0];
  r.equal('sum(amount) of 0.10 + 0.20 + 0.10 is exactly 40 cents', agg, { s: 40, lo: 10, hi: 20 });
  r.equal('decoded at the boundary: 0.40, 0.10, 0.20', [decodeNumeric(agg.s, 2), decodeNumeric(agg.lo, 2), decodeNumeric(agg.hi, 2)], ['0.40', '0.10', '0.20']);
  r.equal('the same sum in REAL is not exact: 0.1 + 0.2 on D1', (await b.d1.all('SELECT 0.1 + 0.2 AS x'))[0].x, 0.30000000000000004);
  r.equal('a comparison against an input is exact: amount > 0.10', (await view('SELECT title FROM events WHERE amount > input.lim ORDER BY title', { lim: 'numeric(12,2)' }, { lim: '0.10' })).map((x: any) => x.title), ['b']);
  r.equal('integer arithmetic on the smallest unit is exact: amount * 3', (await view("SELECT amount * input.q AS x FROM events WHERE title = 'b'", { q: 'int8' }, { q: 3 }))[0].x, 60);
  r.equal("the author writes the rounding for a fraction: round(amount * 1.5)", (await view("SELECT round(amount * input.rate) AS x FROM events WHERE title = 'b'", { rate: 'float8' }, { rate: 1.5 }))[0].x, 30);
  for (const [bad, why] of [['0.123', 'more fractional digits than the scale'], ['12345678901.00', 'more digits than the precision'], ['abc', 'not a number']]) {
    const e = (() => { try { encodeInput('numeric(12,2)', bad); return undefined; } catch (x) { return x as Refused; } })();
    r.check(`numeric input '${bad}' is refused (${why})`, e instanceof Refused && e.code === 'SQL_TYPE', e?.message);
  }
  r.equal('numeric round trip: -0.05 -> -5 -> "-0.05"', decodeNumeric(-5, 2), '-0.05');
  r.check('numeric(16, 2) is refused: 10^16 is past 2^53', (await tryLower("SELECT '1.00'::numeric(16, 2)", { schemas, inputs: {}, kind: 'view' })).ok === false);

  // ---- C. timestamptz is microseconds -----------------------------------------------------------------------
  const iso = (us: number) => { const ms = Math.floor(us / 1000); return new Date(ms).toISOString().replace('Z', `${String(us - ms * 1000).padStart(3, '0')}Z`); };
  const at = (offset: number) => iso(NOW + offset);
  const events: [string, string][] = [['in', at(-35 * HOUR)], ['out', at(-37 * HOUR)], ['edge', at(-36 * HOUR)], ['edge+1us', at(-36 * HOUR + 1)], ['frac', '2026-09-27T12:00:00.123456Z']];
  for (const [t, a] of events) await insert('INSERT INTO events (title, at) VALUES (input.t, input.a)', { t: 'text', a: 'timestamptz' }, { t, a });
  r.equal('now() is the invocation time in microseconds, bound without loss', (await view("SELECT now() AS n FROM items WHERE id = 'a'"))[0].n, NOW);
  const recent = (op: string) => view(`SELECT title FROM events WHERE at ${op} now() - interval '36 hours' ORDER BY title`);
  r.equal("at > now() - interval '36 hours': the row 1 microsecond inside the window is in, the row exactly on the edge is out", (await recent('>')).map((x: any) => x.title), ['edge+1us', 'frac', 'in']);
  r.equal('at >= now() - interval \'36 hours\' includes the edge', (await recent('>=')).map((x: any) => x.title), ['edge', 'edge+1us', 'frac', 'in']);
  const back = (await view("SELECT at FROM events WHERE title = 'frac'"))[0].at;
  r.equal('a timestamp with 6 fractional digits round-trips exactly', decodeOutput('timestamptz', back), '2026-09-27T12:00:00.123456Z');
  r.equal("ts - ts is microseconds: 'in' minus 'out' is 2 hours", (await view("SELECT a.at - o.at AS d FROM events a JOIN events o ON a.title = 'in' AND o.title = 'out'"))[0].d, 2 * HOUR);
  r.equal('interval arithmetic: now() - interval \'90 minutes\' + interval \'30 minutes\'', (await view("SELECT now() - interval '90 minutes' + interval '30 minutes' AS t FROM items WHERE id = 'a'"))[0].t, NOW - HOUR);
  r.equal('2^53 - 1 microseconds (year 2255) is stored and read back exactly', (await b.d1.exec(["INSERT INTO events (id, owner, created_at, title, at) VALUES ('big', 'o1', 0, 'big', 9007199254740991)"]), (await b.d1.all("SELECT at FROM events WHERE id = 'big'"))[0].at), 9007199254740991);
  r.equal('  that instant is', new Date(Math.floor(9007199254740991 / 1000)).toISOString().slice(0, 10), '2255-06-05');
  for (const bad of ["2026-09-27T12:00:00", '2026-09-27', 'not a time']) {
    const e = (() => { try { encodeTimestamptz(bad); return undefined; } catch (x) { return x as Refused; } })();
    r.check(`a timestamp input without an explicit offset is refused: ${bad}`, e instanceof Refused, e?.message);
  }
  const cal = await tryLower("SELECT interval '1 day' FROM items", { schemas, inputs: {}, kind: 'view' });
  r.check("interval '1 day' is refused, and the diagnostic says to bind the boundary as an input", !cal.ok && /bind the boundary as an input/.test(cal.diagnostic.message), cal.ok ? '' : cal.diagnostic.message);

  // ---- D. date is a day count ---------------------------------------------------------------------------------
  for (const [t, d] of [['d1', '2026-03-08'], ['d2', '1969-12-31'], ['d3', '2026-03-09']]) await insert('INSERT INTO events (title, day) VALUES (input.t, input.d)', { t: 'text', d: 'date' }, { t, d });
  r.equal("2026-03-08 is stored as day 20520, 1969-12-31 as -1", (await b.d1.all("SELECT title, day FROM events WHERE title IN ('d1', 'd2') ORDER BY title")).map((x: any) => x.day), [20520, -1]);
  r.equal("day = date '2026-03-08' matches by the folded literal", (await view("SELECT title FROM events WHERE day = date '2026-03-08'")).map((x: any) => x.title), ['d1']);
  r.equal('day + 1 is integer day arithmetic', (await view("SELECT title, day + 1 AS next FROM events WHERE day = date '2026-03-08'"))[0].next, 20521);
  r.equal('day - day is a day count', (await view("SELECT a.day - b.day AS n FROM events a JOIN events b ON a.title = 'd3' AND b.title = 'd1'"))[0].n, 1);
  r.equal('decode(day) = 2026-03-09', decodeDate(20521), '2026-03-09');
  r.check("'2026-02-30' is refused", (() => { try { encodeDate('2026-02-30'); return false; } catch { return true; } })());

  // ---- E. CAST rules ------------------------------------------------------------------------------------------
  const c = (await b.d1.all("SELECT CAST(2.7 AS integer) a, CAST(-2.7 AS integer) b, CAST('12.5' AS integer) c, round(2.7) d, CAST(5 AS text) e, CAST(2.5 AS text) f"))[0];
  r.equal('SQLite: CAST(2.7 AS integer)=2, CAST(-2.7 ...)=-2, CAST(\'12.5\' ...)=12; PostgreSQL gives 3, -3 and an error. round(2.7) is 3.0', c, { a: 2, b: -2, c: 12, d: 3, e: '5', f: '2.5' });
  const warn = await tryLower('SELECT CAST(input.x AS int) AS v FROM items', { schemas, inputs: { x: 'float8' }, kind: 'view' });
  r.check('CAST to int warns SQL_CAST_TRUNC with a position and the advice to round first', warn.ok && warn.ir.warnings.length === 1 && warn.ir.warnings[0].code === 'SQL_CAST_TRUNC' && warn.ir.warnings[0].line === 1 && /round\(x\)/.test(warn.ir.warnings[0].message), warn.ok ? warn.ir.warnings : warn.diagnostic);
  const noWarn = await tryLower("SELECT CAST(7 AS int) AS v, CAST(input.x AS text) AS t FROM items", { schemas, inputs: { x: 'float8' }, kind: 'view' });
  r.check('an integer literal or a CAST to text does not warn', noWarn.ok && noWarn.ir.warnings.length === 0);
  r.equal("CAST('12.34' AS numeric(12, 2)) folds to 1234 at compile time", (await view("SELECT '12.34'::numeric(12, 2) AS n FROM items WHERE id = 'a'"))[0].n, 1234);

  // ---- F. date_trunc and extract across daylight saving, in the site time zone -----------------------------------
  await dst(r, b, s);
  await b.d1.dispose();
}

// ---- DST -----------------------------------------------------------------------------------------------------------
type Unit = 'hour' | 'day' | 'week' | 'month' | 'year';
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const localDate = (l: { y: number; mo: number; d: number }) => `${pad(l.y, 4)}-${pad(l.mo)}-${pad(l.d)}`;
function key(zone: string, sec: number, unit: Unit): string {
  const l = localParts(zone, sec);
  switch (unit) {
    case 'hour': return `${localDate(l)} ${pad(l.h)}`;
    case 'day': return localDate(l);
    case 'week': { const dow = new Date(Date.UTC(l.y, l.mo - 1, l.d)).getUTCDay(), back = (dow + 6) % 7; return new Date(Date.UTC(l.y, l.mo - 1, l.d - back)).toISOString().slice(0, 10); }
    case 'month': return `${pad(l.y, 4)}-${pad(l.mo)}`;
    case 'year': return pad(l.y, 4);
  }
}
/** the oracle: the first instant (in whole seconds) of the local calendar period that contains `sec` */
function oracleTrunc(zone: string, sec: number, unit: Unit): number {
  const want = key(zone, sec, unit);
  let lo = sec - 400 * 86400, hi = sec; // key(lo) < want <= key(hi)
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (key(zone, mid, unit) >= want) hi = mid; else lo = mid; }
  return hi;
}
/** a local time that is repeated by a fall-back cannot be truncated to one instant: PostgreSQL and this compiler may pick either */
function ambiguous(zone: string, sec: number): boolean {
  const l = localParts(zone, sec), wall = sec + l.off;
  const offs = new Set([localParts(zone, sec - 86400).off, localParts(zone, sec + 86400).off, l.off]);
  return [...offs].filter((o) => localParts(zone, wall - o).off === o).length > 1;
}
function seeded(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function dst(r: Report, b: Awaited<ReturnType<typeof boot>>, s: ReturnType<typeof site>) {
  r.note('--- date_trunc / extract in the site time zone (offsets from Intl.DateTimeFormat into _mantle_tz) ---');
  const zones = ['America/New_York', 'Europe/Berlin', 'Australia/Lord_Howe', 'Asia/Kolkata', 'Pacific/Apia', 'Asia/Taipei'];
  const p = await program('view', `SELECT id, date_trunc('hour', at) AS h, date_trunc('day', at) AS d, date_trunc('week', at) AS w, date_trunc('month', at) AS m, date_trunc('year', at) AS y,
      extract(year FROM at) AS yy, extract(month FROM at) AS mo, extract(day FROM at) AS dd, extract(hour FROM at) AS hr, extract(dow FROM at) AS dow FROM events WHERE title = 'dst' ORDER BY id`);
  const rnd = seeded(20260929);
  const known = (zone: string, iso: string, unit: Unit, expect: string) => ({ zone, iso, unit, expect });
  const KNOWN = [
    known('America/New_York', '2026-03-08T15:00:00Z', 'day', '2026-03-08T05:00:00.000Z'), // the 23-hour day: EST midnight
    known('America/New_York', '2026-03-09T15:00:00Z', 'day', '2026-03-09T04:00:00.000Z'), // the next midnight is EDT
    known('America/New_York', '2026-11-01T15:00:00Z', 'day', '2026-11-01T04:00:00.000Z'), // the 25-hour day starts in EDT
    known('America/New_York', '2026-11-02T15:00:00Z', 'day', '2026-11-02T05:00:00.000Z'),
    known('America/New_York', '2026-03-08T15:00:00Z', 'week', '2026-03-02T05:00:00.000Z'), // Monday before the change: EST
    known('America/New_York', '2026-03-11T15:00:00Z', 'week', '2026-03-09T04:00:00.000Z'),
    known('America/New_York', '2026-03-15T15:00:00Z', 'month', '2026-03-01T05:00:00.000Z'),
    known('America/New_York', '2026-11-15T15:00:00Z', 'month', '2026-11-01T04:00:00.000Z'), // November 1 is still EDT
    known('America/New_York', '2026-07-01T15:00:00Z', 'year', '2026-01-01T05:00:00.000Z'),
    known('Europe/Berlin', '2026-03-29T12:00:00Z', 'day', '2026-03-28T23:00:00.000Z'),
    known('Europe/Berlin', '2026-10-25T12:00:00Z', 'day', '2026-10-24T22:00:00.000Z'),
    known('Asia/Kolkata', '2026-06-01T12:00:00Z', 'day', '2026-05-31T18:30:00.000Z'), // +5:30
  ];
  for (const zone of zones) {
    const rows = transitions(zone);
    await b.d1.exec(tzStatements(rows));
    const inWindow = rows.filter((x) => x.from_us > 0 && x.from_us / 1e6 > Date.UTC(2025, 0, 1) / 1000 && x.from_us / 1e6 < Date.UTC(2028, 0, 1) / 1000);
    const instants = new Set<number>();
    for (const t of inWindow) for (let k = -60; k <= 60; k++) instants.add(t.from_us / 1e6 + k * 1800); // every half hour, +-30 h around each transition
    for (let i = 0; i < 150; i++) instants.add(Math.floor(Date.UTC(2020, 0, 1) / 1000 + rnd() * 10 * 365 * 86400));
    for (const [y, mo, d, h] of [[2026, 1, 1, 0], [2026, 12, 31, 23], [2026, 3, 1, 0], [2028, 2, 29, 12], [2026, 1, 1, 12]]) instants.add(Date.UTC(y, mo - 1, d, h) / 1000);
    if (zone === 'Pacific/Apia') for (const iso of ['2011-12-29T12:00:00Z', '2011-12-30T12:00:00Z', '2011-12-31T12:00:00Z', '2012-01-01T12:00:00Z']) instants.add(Date.parse(iso) / 1000);
    const list = [...instants].sort((x, y) => x - y);
    await b.d1.exec(['DELETE FROM events WHERE title = \'dst\'']);
    for (let i = 0; i < list.length; i += 100)
      await b.d1.exec([`INSERT INTO events (id, owner, created_at, title, at) VALUES ${list.slice(i, i + 100).map((sec, j) => `('t${String(i + j).padStart(5, '0')}', 'o1', 0, 'dst', ${sec * 1_000_000})`).join(', ')}`]);
    const out = (await runView(s, p, caller())).rows as any[];
    const bad: Record<string, string[]> = { hour: [], day: [], week: [], month: [], year: [], extract: [] };
    let hourChecked = 0;
    out.forEach((row, i) => {
      const sec = list[i];
      const units: [Unit, string][] = [['hour', 'h'], ['day', 'd'], ['week', 'w'], ['month', 'm'], ['year', 'y']];
      for (const [unit, col] of units) {
        // whole-hour zones: the hour starts on a UTC hour, even inside a repeated hour (each pass truncates to its own start)
        if (unit === 'hour' && (zone === 'Australia/Lord_Howe' || (!WHOLE_HOUR.has(zone) && ambiguous(zone, sec)))) continue; // a half-hour gap has no single answer
        if (unit === 'hour') hourChecked++;
        const want = (unit === 'hour' && WHOLE_HOUR.has(zone) ? Math.floor(sec / 3600) * 3600 : oracleTrunc(zone, sec, unit)) * 1_000_000;
        if (row[col] !== want) bad[unit].push(`${new Date(sec * 1000).toISOString()} ${unit}: got ${new Date(row[col] / 1000).toISOString()} want ${new Date(want / 1000).toISOString()}`);
      }
      const l = localParts(zone, sec);
      const dow = new Date(Date.UTC(l.y, l.mo - 1, l.d)).getUTCDay();
      if (row.yy !== l.y || row.mo !== l.mo || row.dd !== l.d || row.hr !== l.h || row.dow !== dow) bad.extract.push(`${new Date(sec * 1000).toISOString()}: got ${JSON.stringify([row.yy, row.mo, row.dd, row.hr, row.dow])} want ${JSON.stringify([l.y, l.mo, l.d, l.h, dow])}`);
    });
    for (const unit of ['hour', 'day', 'week', 'month', 'year', 'extract']) {
      if (unit === 'hour' && zone === 'Australia/Lord_Howe') continue;
      r.check(`${zone}: date_trunc(${unit === 'extract' ? 'extract' : `'${unit}'`}) matches the Intl oracle on ${unit === 'hour' ? hourChecked : out.length} instants (${inWindow.length} transitions in 2025-2027)`, bad[unit].length === 0, `${bad[unit].length} wrong, e.g. ${bad[unit][0]}`);
    }
    for (const k of KNOWN.filter((x) => x.zone === zone)) {
      const sec = Date.parse(k.iso) / 1000;
      await b.d1.exec(["DELETE FROM events WHERE title = 'one'", `INSERT INTO events (id, owner, created_at, title, at) VALUES ('one', 'o1', 0, 'one', ${sec * 1_000_000})`]);
      const q = await program('view', `SELECT date_trunc('${k.unit}', at) AS t FROM events WHERE title = 'one'`);
      const got = new Date((await runView(s, q, caller())).rows[0].t / 1000).toISOString();
      r.check(`${zone}: date_trunc('${k.unit}', ${k.iso}) = ${k.expect} (PostgreSQL's value)`, got === k.expect, got);
    }
    if (zone === 'America/New_York') {
      const day = async (iso: string) => (await b.d1.exec(["DELETE FROM events WHERE title = 'one'", `INSERT INTO events (id, owner, created_at, title, at) VALUES ('one', 'o1', 0, 'one', ${Date.parse(iso) * 1000})`]), (await runView(s, await program('view', "SELECT date_trunc('day', at) AS t FROM events WHERE title = 'one'"), caller())).rows[0].t as number);
      const [mar8, mar9, nov1, nov2] = [await day('2026-03-08T15:00:00Z'), await day('2026-03-09T15:00:00Z'), await day('2026-11-01T15:00:00Z'), await day('2026-11-02T15:00:00Z')];
      r.equal('New York: the day of the spring change is 23 hours long, the day of the fall change 25', [(mar9 - mar8) / HOUR, (nov2 - nov1) / HOUR], [23, 25]);
      const naive = (Date.parse('2026-03-08T15:00:00Z') * 1000) - ((Date.parse('2026-03-08T15:00:00Z') * 1000) % (24 * HOUR));
      r.check('truncating on UTC arithmetic instead would be wrong here (that is why _mantle_tz exists)', naive !== mar8, `UTC day start ${new Date(naive / 1000).toISOString()} vs local ${new Date(mar8 / 1000).toISOString()}`);
      const ny = transitions('America/New_York');
      const spring = ny.find((x) => x.from_us === Date.parse('2026-03-08T07:00:00Z') * 1000);
      const fall = ny.find((x) => x.from_us === Date.parse('2026-11-01T06:00:00Z') * 1000);
      r.equal('_mantle_tz for New York: 2026-03-08T07:00Z goes -5h to -4h, 2026-11-01T06:00Z goes back', [spring?.offset_us, fall?.offset_us], [-4 * HOUR, -5 * HOUR]);
      r.note(`  _mantle_tz rows for New York 1970-2100: ${ny.length}; Berlin ${transitions('Europe/Berlin').length}; Lord Howe ${transitions('Australia/Lord_Howe').length}`);
      // negative control: the same instants with an empty _mantle_tz (a UTC site) must disagree with the New York oracle
      await b.d1.exec(['DELETE FROM _mantle_tz']);
      await b.d1.exec(["DELETE FROM events WHERE title = 'one'"]);
      const utc = (await runView(s, p, caller())).rows as any[];
      const wrong = utc.filter((row, i) => row.d !== oracleTrunc(zone, list[i], 'day') * 1_000_000).length;
      r.check(`negative control: with an empty _mantle_tz the oracle check finds ${wrong} of ${utc.length} day truncations wrong, so it can fail`, wrong > 100);
    }
  }
  r.note('Not covered: hour truncation in Lord Howe (a half-hour gap has no single answer) and in a repeated half-hour zone; a zone whose day starts in a gap (midnight DST) is untested. In a repeated whole hour each pass truncates to its own start (05:30Z -> 05:00Z and 06:30Z -> 06:00Z in New York); whether PostgreSQL picks the same was not verified, there is no PostgreSQL here.');
}
void encodeDate;
