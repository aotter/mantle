// @ts-nocheck test code over loosely typed IR and rows
// Conformance case 3: a report View with a join, GROUP BY/HAVING and a cursor, where scope and TTL are
// injected into every joined Schema.
import type { Report } from '../report.js';
import type { Engine } from '../harness.js';
import { boot, caller, program, site } from '../harness.js';
import { runView } from '../harness.js';

export const VIEW = `
  SELECT i.name, count(o.id) AS n, coalesce(sum(o.qty), 0) AS total
  FROM items i LEFT JOIN orders o ON o.item_id = i.id
  GROUP BY i.name HAVING count(o.id) >= input.min
  ORDER BY total DESC, i.name
  LIMIT 10`;

export async function run(r: Report, engine: Engine) {
  r.section('Case 3: report View (join, GROUP BY/HAVING, cursor)');
  const b = await boot(engine);
  const s = site(b);
  const p = await program('view', VIEW, { min: 'int8' });

  const all = (await runView(s, p, caller({ min: 0 }))).rows;
  r.equal("o1's report: apple has its two visible orders; the other owner's order for apple and the order on the expired item are not counted; the LEFT JOIN keeps unmatched items",
    all, [{ name: 'apple', n: 2, total: 4 }, { name: 'berry', n: 0, total: 0 }, { name: 'cherry', n: 0, total: 0 }, { name: 'date', n: 0, total: 0 }]);
  r.equal("HAVING binds an input (min = 1 keeps only apple); o2's report sees only o2's rows",
    [(await runView(s, p, caller({ min: 1 }))).rows, (await runView(s, p, caller({ min: 0 }, 'o2'))).rows.map((x: any) => x.name).sort()], [[{ name: 'apple', n: 2, total: 4 }], ['LEAK-zeta', 'LEAK-zulu']]);

  // cursor: keyset pagination over (total DESC, name, and the appended group key)
  const pages: any[][] = [];
  let cursor: unknown[] | undefined;
  for (let i = 0; i < 6; i++) {
    const page = await runView(s, p, caller({ min: 0 }), { cursor, pageSize: 2 });
    pages.push(page.rows);
    if (!page.next) break;
    cursor = page.next;
  }
  r.equal('cursor: pages of 2 cover the report in order, without repeats or gaps, and the last page has no next cursor', pages, [all.slice(0, 2), all.slice(2, 4)]);
  // a forged cursor cannot reveal another owner's row (the keys only filter the caller's own result); ties on the first key are broken by the group key
  const forged = await runView(s, p, caller({ min: 0 }), { cursor: [0, 'LEAK-zeta', 'LEAK-zeta'], pageSize: 5 });
  const inTie = await runView(s, p, caller({ min: 0 }), { cursor: [0, 'berry', 'berry'], pageSize: 5 });
  r.check("a forged cursor value only filters the caller's own rows; a cursor inside a run of equal totals continues after the given name", !JSON.stringify(forged.rows).includes('LEAK') && JSON.stringify(inTie.rows.map((x: any) => x.name)) === '["cherry","date"]', [forged.rows, inTie.rows]);

}
