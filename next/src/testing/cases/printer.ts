// @ts-nocheck test code over loosely typed IR and rows
// The printer corpus: every node type of the SQL allowlist appears in at least one item, and each item runs through
// the whole pipeline (compile, policy, print, execute) and gives the rows PostgreSQL semantics give.
import type { Report } from '../report.js';
import type { DatabaseDriver } from '../../core/driver.js';
import { boot, caller, program, reset, runProcedure, runView, site } from '../harness.js';
import { corpus } from './corpus.js';

export async function run(r: Report, driver: DatabaseDriver) {
  r.section('Printer corpus: every allowlisted node on the engine');
  const b = await boot(driver);
  const s = site(b);
  const bad: string[] = [];
  for (const item of corpus) {
    const rt = { ...caller(item.input), role: 'staff' };
    try {
      const p = await program(item.kind, item.sql, item.inputs ?? {});
      if (item.kind === 'procedure') await reset(b.d1);
      const rows = item.kind === 'view' ? [(await runView(s, p, rt)).rows] : (await runProcedure(s, p, rt)).rows;
      if (JSON.stringify(rows) !== JSON.stringify(item.expect)) bad.push(`${item.id}: expected ${JSON.stringify(item.expect)} got ${JSON.stringify(rows)}`);
    } catch (e) {
      bad.push(`${item.id}: ${String(e.message).split('\n')[0].slice(0, 200)}`);
    }
  }
  r.check(`all ${corpus.length} corpus items give the rows PostgreSQL semantics give`, bad.length === 0, bad.join('; '));
}
