// One entry for the whole spike:
//   cd next/spike && npm ci && npm run spike           (all cases, writes REPORT.txt)
//   node --experimental-strip-types --no-warnings run.ts deparser types   (some cases, prints only)
// Every case runs on local D1 in workerd (wrangler's unstable_startWorker); nothing touches Cloudflare.
import { writeFileSync } from 'node:fs';
import { Report } from './src/report.ts';
import { FINDINGS, NOT_COVERED } from './findings.ts';

process.env.WRANGLER_SEND_METRICS ??= 'false';

const cases: Record<string, () => Promise<{ run: (r: Report) => Promise<unknown> }>> = {
  d1: () => import('./cases/d1.ts'),
  deparser: () => import('./cases/deparser.ts'),
  requisition: () => import('./cases/requisition.ts'),
  stock: () => import('./cases/stock.ts'),
  'report-view': () => import('./cases/report-view.ts'),
  'before-hook': () => import('./cases/before-hook.ts'),
  dialect: () => import('./cases/dialect.ts'),
  types: () => import('./cases/types.ts'),
  policy: () => import('./cases/policy.ts'),
  'search-places': () => import('./cases/search-places.ts'),
  typecheck: () => import('./cases/typecheck.ts'),
};

const only = process.argv.slice(2);
const report = new Report();
const t0 = Date.now();
for (const [name, load] of Object.entries(cases)) {
  if (only.length && !only.includes(name)) continue;
  try {
    await (await load()).run(report);
  } catch (e: any) {
    report.section(`${name} (crashed)`);
    report.check('case ran to the end', false, e?.stack ?? String(e));
  }
}

const verdict = (prefix: string) => {
  const cs = report.checks.filter((c) => c.case.startsWith(prefix));
  return cs.length ? `${cs.every((c) => c.ok) ? 'PASS' : 'FAIL'}  ${prefix}  (${cs.filter((c) => c.ok).length}/${cs.length} checks)` : `----  ${prefix}  (not run)`;
};
const summary = [
  'Spike task 1: deparser overrides',
  ...['1. Deparser', '1c.', '1d.', '1e.', '1f.', '1g.'].map(verdict).map((l) => `  ${l}`),
  '',
  'Spike task 2 and 3: the 8 conformance cases (ADR-0034 "Conformance cases")',
  ...['Case 1:', 'Case 2:', 'Case 3:', 'Case 4:', 'Case 5:', 'Case 6:', 'Case 7:', 'Case 8:'].map(verdict).map((l) => `  ${l}`),
  '',
  'Also',
  `  ${verdict('Typecheck:')}`,
  `  ${verdict('Local D1 facts')}`,
];
const text = [
  'ADR-0034 spike report (Store authored as SQL): local D1 in workerd',
  `node ${process.version}, ${new Date().toISOString().slice(0, 10)}. Re-run: cd next/spike && npm ci && npm run spike`,
  '',
  '== Summary ==',
  ...summary,
  `${report.checks.length - report.failed.length}/${report.checks.length} checks pass${report.failed.length ? `, ${report.failed.length} FAIL` : ''} in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  '',
  '== Findings against ADR-0034 (commentary; each names the check that shows it) ==',
  ...FINDINGS,
  '',
  '== Not covered by this spike ==',
  ...NOT_COVERED,
  '',
  '== Evidence: every check that ran ==',
  ...report.lines,
].join('\n');
console.log(text);
if (!only.length) writeFileSync(new URL('./REPORT.txt', import.meta.url), text + '\n');
process.exit(report.failed.length ? 1 : 0);
