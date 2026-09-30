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
  const refused: string[] = [];
  for (const item of corpus) {
    const rt = { ...caller(item.input), role: 'staff' };
    // a construct the dialect's compile side refuses as unsupported passes by that refusal (ADR-0035 decision 8); any other
    // refusal (syntax, a column, a relation) is the corpus item failing
    const p = await program(item.kind, item.sql, item.inputs ?? {}).catch((e) => (/^SQL_(UNSUPPORTED|FUNCTION|TYPE):/.test(e.message) ? undefined : Promise.reject(e)));
    if (!p) { refused.push(item.id); continue; }
    try {
      if (item.kind === 'procedure') await reset(b);
      const rows = item.kind === 'view' ? [(await runView(s, p, rt)).rows] : (await runProcedure(s, p, rt)).rows;
      if (JSON.stringify(rows) !== JSON.stringify(item.expect)) bad.push(`${item.id}: expected ${JSON.stringify(item.expect)} got ${JSON.stringify(rows)}`);
    } catch (e) {
      bad.push(`${item.id}: ${String(e.message).split('\n')[0].slice(0, 200)}`);
    }
  }
  r.check(`all ${corpus.length - refused.length} corpus items the dialect accepts (of ${corpus.length}) give the rows PostgreSQL semantics give; refused as unsupported: ${refused.join(', ') || 'none'}`, bad.length === 0, bad.join('; '));
}
