// One entry for the whole spike: `npm run spike` (or `node --experimental-strip-types run.ts [case ...]`).
// Runs every case on local D1 in workerd, prints the report and writes it to REPORT.txt.
import { writeFileSync } from 'node:fs';
import { Report } from './src/report.ts';

process.env.WRANGLER_SEND_METRICS ??= 'false';

const cases: Record<string, () => Promise<{ run: (r: Report) => Promise<unknown> }>> = {
  deparser: () => import('./cases/deparser.ts'),
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
const text = [
  'ADR-0034 spike report',
  `node ${process.version}, ${new Date().toISOString().slice(0, 10)}`,
  ...report.lines,
  '',
  '== Summary ==',
  report.summary(false),
  `${report.checks.length - report.failed.length}/${report.checks.length} checks pass in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
].join('\n');
console.log(text);
if (!only.length) writeFileSync(new URL('./REPORT.txt', import.meta.url), text + '\n');
process.exit(report.failed.length ? 1 : 0);
