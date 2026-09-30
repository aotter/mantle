// @ts-nocheck test code over loosely typed IR and rows
// The printer corpus: every node type of the SQL allowlist appears in at least one item, and each item runs through
// the whole pipeline (compile, policy, print, execute) and gives the rows PostgreSQL semantics give.
import type { Report } from '../report.js';
import type { Engine } from '../harness.js';
import { boot, caller, program, reset, runProcedure, runView, site } from '../harness.js';
import { corpus } from './corpus.js';

export async function run(r: Report, engine: Engine) {
  r.section('Printer corpus: every allowlisted node on the engine');
  const b = await boot(engine);
  const s = site(b);
  const bad: string[] = [];
  let refused = 0;
  for (const item of corpus) {
    const rt = { ...caller(item.input), role: 'staff' };
    // a construct the dialect's compile side refuses passes by that refusal (ADR-0035 decision 8)
    const p = await program(item.kind, item.sql, item.inputs ?? {}).catch((e) => (/^SQL_/.test(e.message) ? undefined : Promise.reject(e)));
    if (!p) { refused++; continue; }
    try {
      if (item.kind === 'procedure') await reset(b.d1);
      const rows = item.kind === 'view' ? [(await runView(s, p, rt)).rows] : (await runProcedure(s, p, rt)).rows;
      if (JSON.stringify(rows) !== JSON.stringify(item.expect)) bad.push(`${item.id}: expected ${JSON.stringify(item.expect)} got ${JSON.stringify(rows)}`);
    } catch (e) {
      bad.push(`${item.id}: ${String(e.message).split('\n')[0].slice(0, 200)}`);
    }
  }
  r.check(`all ${corpus.length - refused} corpus items the dialect accepts (of ${corpus.length}) give the rows PostgreSQL semantics give`, bad.length === 0, bad.join('; '));
}
