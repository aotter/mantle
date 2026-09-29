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
import { facts } from '../findings.ts';

const HOUR = 3_600_000_000;
const WHOLE_HOUR = new Set(['America/New_York', 'Europe/Berlin', 'Pacific/Apia', 'Asia/Taipei']);
const refuses = (f: () => unknown) => { try { f(); return false; } catch (e) { return e instanceof Refused; } };

export async function run(r: Report) {
  r.section('Case 6: types (integer division, numeric, microseconds, dates, CAST)');
  const b = await boot();
  const s = site(b);
  const view = async (sql: string, inputs: Record<string, string> = {}, input: Record<string, unknown> = {}) =>
    (await runView(s, await program('view', sql, inputs), caller(input))).rows;
  const insert = async (sql: string, inputs: Record<string, string>, input: Record<string, unknown>) => runProcedure(s, await program('procedure', sql, inputs), caller(input));
  const lowerErr = async (sql: string) => { const x = await tryLower(sql, { schemas, inputs: {}, kind: 'view' }); return x.ok ? '' : x.diagnostic.message; };

  // ---- A. every bind is CAST to its declared type ------------------------------------------------------------
  const sql = render(compileProgram(s, await program('view', "SELECT input.n / 2 AS h FROM items WHERE id = 'a'", { n: 'int8' }))[0]);
  r.equal('integer division: raw D1 binds 5 as a float (?1 / 2 = 2.5, the negative control); with the CAST to the declared type n / 2 is 2, -5 / 2 is -2 (toward zero), float8 keeps 2.5, text and bool survive',
    [(await b.d1.all('SELECT ?1 / 2 AS x', [5]))[0].x, /CAST\(\?\d AS integer\) \/ 2/.test(sql),
      await view("SELECT input.n / 2 AS h, input.n % 2 AS m FROM items WHERE id = 'a'", { n: 'int8' }, { n: 5 }),
      await view("SELECT input.n / 2 AS h, input.n % 2 AS m FROM items WHERE id = 'a'", { n: 'int8' }, { n: -5 }),
      await view("SELECT input.x / 2 AS h FROM items WHERE id = 'a'", { x: 'float8' }, { x: 5 }),
      await view("SELECT input.s AS s, input.b AS b FROM items WHERE id = 'a'", { s: 'text', b: 'bool' }, { s: '007', b: true })],
    [2.5, true, [{ h: 2, m: 1 }], [{ h: -2, m: -1 }], [{ h: 2.5 }], [{ s: '007', b: 1 }]]);
  r.check('an integer input past 2^53 and a non-integer for int8 are refused before they can be rounded', (() => { try { encodeInput('int8', 2 ** 53); return false; } catch (e) { return e instanceof Refused && e.message.startsWith('9007199254740992 is not a safe integer'); } })() && refuses(() => encodeInput('int8', 5.5)));

  // ---- B. numeric(12, 2) is an integer count of cents ---------------------------------------------------------
  for (const [t, a] of [['a', '0.10'], ['b', '0.20'], ['c', '0.10'], ['d', '-0.05']]) await insert('INSERT INTO events (title, amount) VALUES (input.t, input.a)', { t: 'text', a: 'numeric(12,2)' }, { t, a });
  const agg = (await view("SELECT sum(amount) AS s, min(amount) AS lo, max(amount) AS hi FROM events WHERE title IN ('a', 'b', 'c')"))[0];
  r.equal('numeric(12,2) is exact cents: stored 10, 20, -5; sum 0.10 + 0.20 + 0.10 is 40 and decodes to 0.40 (REAL gives 0.30000000000000004, the negative control); amount > 0.10, amount * 3 and round(amount * 1.5) are exact',
    [(await b.d1.all("SELECT amount FROM events WHERE title IN ('a','b','d') ORDER BY title")).map((x: any) => x.amount), agg, decodeNumeric(agg.s, 2), (await b.d1.all('SELECT 0.1 + 0.2 AS x'))[0].x,
      (await view('SELECT title FROM events WHERE amount > input.lim ORDER BY title', { lim: 'numeric(12,2)' }, { lim: '0.10' })).map((x: any) => x.title),
      (await view("SELECT amount * input.q AS x FROM events WHERE title = 'b'", { q: 'int8' }, { q: 3 }))[0].x,
      (await view("SELECT round(amount * input.rate) AS x FROM events WHERE title = 'b'", { rate: 'float8' }, { rate: 1.5 }))[0].x],
    [[10, 20, -5], { s: 40, lo: 10, hi: 20 }, '0.40', 0.30000000000000004, ['b'], 60, 30]);
  r.check("numeric input beyond its scale ('0.123'), beyond its precision, not a number, and numeric(16, 2) (10^16 is past 2^53) are refused; -5 decodes to '-0.05'",
    ['0.123', '12345678901.00', 'abc'].every((x) => { try { encodeInput('numeric(12,2)', x); return false; } catch (e) { return e instanceof Refused && e.code === 'SQL_TYPE'; } })
    && (await lowerErr("SELECT '1.00'::numeric(16, 2)")) !== '' && decodeNumeric(-5, 2) === '-0.05');

  // ---- C. timestamptz is microseconds -----------------------------------------------------------------------
  const iso = (us: number) => { const ms = Math.floor(us / 1000); return new Date(ms).toISOString().replace('Z', `${String(us - ms * 1000).padStart(3, '0')}Z`); };
  const at = (offset: number) => iso(NOW + offset);
  const events: [string, string][] = [['in', at(-35 * HOUR)], ['out', at(-37 * HOUR)], ['edge', at(-36 * HOUR)], ['edge+1us', at(-36 * HOUR + 1)], ['frac', '2026-09-27T12:00:00.123456Z']];
  for (const [t, a] of events) await insert('INSERT INTO events (title, at) VALUES (input.t, input.a)', { t: 'text', a: 'timestamptz' }, { t, a });
  const recent = async (op: string) => (await view(`SELECT title FROM events WHERE at ${op} now() - interval '36 hours' ORDER BY title`)).map((x: any) => x.title);
  const [gt, ge] = [await recent('>'), await recent('>=')];
  await b.d1.exec(["INSERT INTO events (id, owner, created_at, title, at) VALUES ('big', 'o1', 0, 'big', 9007199254740991)"]);
  r.equal("timestamptz in microseconds: now() binds without loss; at > now() - interval '36 hours' takes the row 1 us inside and not the edge (>= takes the edge); 6 fractional digits round-trip; ts - ts is 2 hours; interval arithmetic; 2^53 - 1 stores exactly",
    [(await view("SELECT now() AS n FROM items WHERE id = 'a'"))[0].n, gt, ge,
      decodeOutput('timestamptz', (await view("SELECT at FROM events WHERE title = 'frac'"))[0].at),
      (await view("SELECT a.at - o.at AS d FROM events a JOIN events o ON a.title = 'in' AND o.title = 'out'"))[0].d,
      (await view("SELECT now() - interval '90 minutes' + interval '30 minutes' AS t FROM items WHERE id = 'a'"))[0].t,
      (await b.d1.all("SELECT at FROM events WHERE id = 'big'"))[0].at],
    [NOW, ['edge+1us', 'frac', 'in'], ['edge', 'edge+1us', 'frac', 'in'], '2026-09-27T12:00:00.123456Z', 2 * HOUR, NOW - HOUR, 9007199254740991]);
  r.check("a timestamp input without an explicit offset is refused; interval '1 day' is refused and the diagnostic says to bind the boundary as an input",
    ['2026-09-27T12:00:00', '2026-09-27', 'not a time'].every((x) => refuses(() => encodeTimestamptz(x))) && /bind the boundary as an input/.test(await lowerErr("SELECT interval '1 day' FROM items")));

  // ---- D. date is a day count ---------------------------------------------------------------------------------
  for (const [t, d] of [['d1', '2026-03-08'], ['d2', '1969-12-31'], ['d3', '2026-03-09']]) await insert('INSERT INTO events (title, day) VALUES (input.t, input.d)', { t: 'text', d: 'date' }, { t, d });
  r.equal("date is a day count: 2026-03-08 is day 20520, 1969-12-31 is -1; the folded literal matches; day + 1 and day - day are integers; decode gives 2026-03-09; 2026-02-30 is refused",
    [(await b.d1.all("SELECT day FROM events WHERE title IN ('d1', 'd2') ORDER BY title")).map((x: any) => x.day), (await view("SELECT title FROM events WHERE day = date '2026-03-08'")).map((x: any) => x.title),
      (await view("SELECT day + 1 AS next FROM events WHERE day = date '2026-03-08'"))[0].next, (await view("SELECT a.day - b.day AS n FROM events a JOIN events b ON a.title = 'd3' AND b.title = 'd1'"))[0].n,
      decodeDate(20521), refuses(() => encodeDate('2026-02-30'))],
    [[20520, -1], ['d1'], 20521, 1, '2026-03-09', true]);

  // ---- E. CAST rules ------------------------------------------------------------------------------------------
  const c = (await b.d1.all("SELECT CAST(2.7 AS integer) a, CAST(-2.7 AS integer) b, round(2.7) d, round(-2.7) e"))[0];
  const bad = await tryLower('SELECT CAST(input.x AS int) AS v FROM items', { schemas, inputs: { x: 'float8' }, kind: 'view' });
  const good = await tryLower('SELECT CAST(7 AS int) AS v, CAST(input.x AS text) AS t FROM items', { schemas, inputs: { x: 'float8' }, kind: 'view' });
  r.check("CAST: SQLite truncates (2.7 gives 2) where PostgreSQL rounds, so a non-literal CAST to int is refused SQL_TYPE with a position and the advice round(x); an integer literal CAST and CAST to text pass; CAST('12.34' AS numeric(12, 2)) folds to 1234",
    JSON.stringify(c) === '{"a":2,"b":-2,"d":3,"e":-3}' && !bad.ok && bad.diagnostic.code === 'SQL_TYPE' && bad.diagnostic.line === 1 && /round\(x\)/.test(bad.diagnostic.message)
    && good.ok && (await view("SELECT '12.34'::numeric(12, 2) AS n FROM items WHERE id = 'a'"))[0].n === 1234);
  const rd = (await view("SELECT round(2.7) AS a, round(-2.7) AS b, round(2.2) AS c FROM items WHERE id = 'a'"))[0];
  r.check("round(x) gives PostgreSQL's rounding, not truncation: 2.7 gives 3, -2.7 gives -3, 2.2 gives 2 (exact halves differ: PostgreSQL float8 rounds half to even, SQLite half away from zero)", rd.a === 3 && rd.b === -3 && rd.c === 2);

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
  const KNOWN: [string, string, Unit, string][] = [
    ['America/New_York', '2026-03-08T15:00:00Z', 'day', '2026-03-08T05:00:00.000Z'], // the 23-hour day: EST midnight
    ['America/New_York', '2026-11-01T15:00:00Z', 'day', '2026-11-01T04:00:00.000Z'], // the 25-hour day starts in EDT
    ['America/New_York', '2026-03-08T15:00:00Z', 'week', '2026-03-02T05:00:00.000Z'], // Monday before the change: EST
    ['America/New_York', '2026-11-15T15:00:00Z', 'month', '2026-11-01T04:00:00.000Z'], // November 1 is still EDT
    ['Europe/Berlin', '2026-03-29T12:00:00Z', 'day', '2026-03-28T23:00:00.000Z'],
    ['Asia/Kolkata', '2026-06-01T12:00:00Z', 'day', '2026-05-31T18:30:00.000Z'], // +5:30
  ];
  const trunc = async (unit: Unit, iso: string) => {
    await b.d1.exec(["DELETE FROM events WHERE title = 'one'", `INSERT INTO events (id, owner, created_at, title, at) VALUES ('one', 'o1', 0, 'one', ${Date.parse(iso) * 1000})`]);
    return (await runView(s, await program('view', `SELECT date_trunc('${unit}', at) AS t FROM events WHERE title = 'one'`), caller())).rows[0].t as number;
  };
  const counts: number[] = [];
  let listNY: number[] = [];
  const known: string[] = [];
  for (const zone of zones) {
    const rows = transitions(zone);
    await b.d1.exec(tzStatements(rows));
    const inWindow = rows.filter((x) => x.from_us > 0 && x.from_us / 1e6 > Date.UTC(2025, 0, 1) / 1000 && x.from_us / 1e6 < Date.UTC(2028, 0, 1) / 1000);
    const instants = new Set<number>();
    for (const t of inWindow) for (let k = -12; k <= 12; k++) instants.add(t.from_us / 1e6 + k * 1800); // every half hour, +-6 h around each transition
    for (let i = 0; i < 20; i++) instants.add(Math.floor(Date.UTC(2020, 0, 1) / 1000 + rnd() * 10 * 365 * 86400));
    for (const [y, mo, d, h] of [[2026, 1, 1, 0], [2026, 12, 31, 23], [2026, 3, 1, 0], [2028, 2, 29, 12], [2026, 1, 1, 12]]) instants.add(Date.UTC(y, mo - 1, d, h) / 1000);
    if (zone === 'Pacific/Apia') for (const iso of ['2011-12-29T12:00:00Z', '2011-12-30T12:00:00Z', '2011-12-31T12:00:00Z', '2012-01-01T12:00:00Z']) instants.add(Date.parse(iso) / 1000);
    const list = [...instants].sort((x, y) => x - y);
    counts.push(list.length);
    if (zone === 'America/New_York') listNY = list;
    await b.d1.exec(["DELETE FROM events WHERE title = 'dst'"]);
    for (let i = 0; i < list.length; i += 100)
      await b.d1.exec([`INSERT INTO events (id, owner, created_at, title, at) VALUES ${list.slice(i, i + 100).map((sec, j) => `('t${String(i + j).padStart(5, '0')}', 'o1', 0, 'dst', ${sec * 1_000_000})`).join(', ')}`]);
    const out = (await runView(s, p, caller())).rows as any[];
    const bad: string[] = [];
    out.forEach((row, i) => {
      const sec = list[i];
      for (const [unit, col] of [['hour', 'h'], ['day', 'd'], ['week', 'w'], ['month', 'm'], ['year', 'y']] as [Unit, string][]) {
        // whole-hour zones: the hour starts on a UTC hour, even inside a repeated hour (each pass truncates to its own start)
        if (unit === 'hour' && (zone === 'Australia/Lord_Howe' || (!WHOLE_HOUR.has(zone) && ambiguous(zone, sec)))) continue; // a half-hour gap has no single answer
        const want = (unit === 'hour' && WHOLE_HOUR.has(zone) ? Math.floor(sec / 3600) * 3600 : oracleTrunc(zone, sec, unit)) * 1_000_000;
        if (row[col] !== want) bad.push(`${new Date(sec * 1000).toISOString()} ${unit}: got ${new Date(row[col] / 1000).toISOString()} want ${new Date(want / 1000).toISOString()}`);
      }
      const l = localParts(zone, sec);
      const dow = new Date(Date.UTC(l.y, l.mo - 1, l.d)).getUTCDay();
      if (row.yy !== l.y || row.mo !== l.mo || row.dd !== l.d || row.hr !== l.h || row.dow !== dow) bad.push(`${new Date(sec * 1000).toISOString()} extract: got ${JSON.stringify([row.yy, row.mo, row.dd, row.hr, row.dow])} want ${JSON.stringify([l.y, l.mo, l.d, l.h, dow])}`);
    });
    r.check(`${zone}: date_trunc (hour, day, week, month, year) and extract match the Intl oracle on ${list.length} instants (${inWindow.length} transitions in 2025-2027)`, bad.length === 0, `${bad.length} wrong, e.g. ${bad[0]}`);
    for (const [z, iso, unit, expect] of KNOWN) if (z === zone) known.push(new Date((await trunc(unit, iso)) / 1000).toISOString() === expect ? '' : `${z} ${unit} ${iso}`);
    if (zone === 'America/New_York') {
      const [mar8, mar9, nov1, nov2] = [await trunc('day', '2026-03-08T15:00:00Z'), await trunc('day', '2026-03-09T15:00:00Z'), await trunc('day', '2026-11-01T15:00:00Z'), await trunc('day', '2026-11-02T15:00:00Z')];
      const naive = Date.parse('2026-03-08T15:00:00Z') * 1000 - ((Date.parse('2026-03-08T15:00:00Z') * 1000) % (24 * HOUR));
      const ny = transitions('America/New_York');
      const spring = ny.find((x) => x.from_us === Date.parse('2026-03-08T07:00:00Z') * 1000);
      const fall = ny.find((x) => x.from_us === Date.parse('2026-11-01T06:00:00Z') * 1000);
      r.equal('New York: the day of the spring change is 23 hours long, the day of the fall change 25; UTC arithmetic would be wrong (why _mantle_tz exists); _mantle_tz has the two 2026 transitions',
        [[(mar9 - mar8) / HOUR, (nov2 - nov1) / HOUR], naive !== mar8, [spring?.offset_us, fall?.offset_us]], [[23, 25], true, [-4 * HOUR, -5 * HOUR]]);
      // negative control: the same instants with an empty _mantle_tz (a UTC site) must disagree with the New York oracle
      await b.d1.exec(['DELETE FROM _mantle_tz', "DELETE FROM events WHERE title = 'one'"]);
      const utc = (await runView(s, p, caller())).rows as any[];
      const wrong = utc.filter((row, i) => row.d !== oracleTrunc(zone, listNY[i], 'day') * 1_000_000).length;
      r.check(`negative control: with an empty _mantle_tz the oracle check finds ${wrong} of ${utc.length} day truncations wrong, so it can fail`, wrong > 10);
    }
  }
  r.check(`${KNOWN.length} known values (New York, Berlin, Kolkata day/week/month) are PostgreSQL's`, known.every((x) => x === ''), known.filter(Boolean));
  facts.dstMin = Math.min(...counts);
  facts.dstMax = Math.max(...counts);
  r.note('Not covered: hour truncation in Lord Howe (a half-hour gap has no single answer) and in a repeated half-hour zone; a zone whose day starts in a gap (midnight DST) is untested. In a repeated whole hour each pass truncates to its own start (05:30Z -> 05:00Z and 06:30Z -> 06:00Z in New York); whether PostgreSQL picks the same was not verified, there is no PostgreSQL here.');
}
