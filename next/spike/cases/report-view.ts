// Conformance case 3: a report View with a join, GROUP BY/HAVING and a cursor, where scope and TTL are
// injected into every joined Schema.
import type { Report } from '../src/report.ts';
import { boot, caller, program, site } from '../src/fixtures.ts';
import { compileProgram, render, runView } from '../src/exec.ts';

const VIEW = `
  SELECT i.name, count(o.id) AS n, coalesce(sum(o.qty), 0) AS total
  FROM items i LEFT JOIN orders o ON o.item_id = i.id
  GROUP BY i.name HAVING count(o.id) >= input.min
  ORDER BY total DESC, i.name
  LIMIT 10`;

export async function run(r: Report) {
  r.section('Case 3: report View (join, GROUP BY/HAVING, cursor)');
  const b = await boot();
  const s = site(b);
  const p = await program('view', VIEW, { min: 'int8' });

  const all = (await runView(s, p, caller({ min: 0 }))).rows;
  r.equal("o1's report: apple has its two visible orders; the other owner's order for apple and the order on the expired item are not counted; the LEFT JOIN keeps unmatched items",
    all, [{ name: 'apple', n: 2, total: 4 }, { name: 'berry', n: 0, total: 0 }, { name: 'cherry', n: 0, total: 0 }, { name: 'date', n: 0, total: 0 }]);
  r.equal("HAVING binds an input (min = 1 keeps only apple); o2's report sees only o2's rows",
    [(await runView(s, p, caller({ min: 1 }))).rows, (await runView(s, p, caller({ min: 0 }, 'o2'))).rows.map((x: any) => x.name).sort()], [[{ name: 'apple', n: 2, total: 4 }], ['LEAK-zeta', 'LEAK-zulu']]);

  // policy is injected into EVERY Schema the View touches
  const sql = render(compileProgram(s, p)[0]);
  r.check('items is wrapped with scope and TTL, orders with scope; the caller and now() bind once each however many references are wrapped',
    /FROM items WHERE items\.owner = \?1 AND \(items\.expires_at IS NULL OR items\.expires_at > \?2\)/.test(sql) && /FROM orders WHERE orders\.owner = \?1/.test(sql) && !/\?4/.test(sql), sql.slice(0, 300));

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

  // the scope index still serves the wrapped read: SQLite flattens the wrapper (ADR-0034 decision 8)
  const plan = await b.d1.try(`EXPLAIN QUERY PLAN ${sql}`, ['o1', 0, 0]);
  if ('rows' in plan) {
    const detail = plan.rows.map((x: any) => x.detail).join(' | ');
    r.check('EXPLAIN QUERY PLAN uses the scope index on both wrapped Schemas', /_mantle_scope_items/.test(detail) && /_mantle_scope_orders/.test(detail), detail);
  } else r.note(`EXPLAIN QUERY PLAN is refused on local D1 (${plan.error.split(':')[1]?.trim()}); flattening checked by the plan text only`);
  await b.d1.dispose();
}
