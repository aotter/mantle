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
  // The handbook's derived-table example authors the complete row identity. A parent's id alone repeats after this join.
  for (const projection of ['s.id, s.name, s.order_id', 's.id, s.name']) {
    const joined = await program('view', `SELECT ${projection} FROM (
      SELECT i.id, i.name, o.id AS order_id FROM items i JOIN orders o ON o.item_id = i.id
    ) s ORDER BY s.id, s.order_id`);
    const expected = projection.includes('s.order_id')
      ? [{ id: 'a', name: 'apple', order_id: 'oa' }, { id: 'a', name: 'apple', order_id: 'ob' }]
      : [{ id: 'a', name: 'apple' }, { id: 'a', name: 'apple' }];
    r.equal(`authored join identity: unpaged ${projection}`, (await runView(s, joined, caller())).rows, expected);
    for (const pageSize of [1, 2, 3]) {
      const rows: any[] = [];
      let after: unknown[] | undefined;
      for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
        const page = await runView(s, joined, caller(), { cursor: after, pageSize });
        rows.push(...page.rows);
        if (!page.next) break;
        after = page.next;
      }
      r.equal(`authored join identity: page size ${pageSize} preserves ${projection}, including repeated projected rows`, rows, expected);
    }
  }
  // a forged cursor cannot reveal another owner's row (the keys only filter the caller's own result); ties on the first key are broken by the group key
  const forged = await runView(s, p, caller({ min: 0 }), { cursor: [0, 'LEAK-zeta', 'LEAK-zeta'], pageSize: 5 });
  const inTie = await runView(s, p, caller({ min: 0 }), { cursor: [0, 'berry', 'berry'], pageSize: 5 });
  r.check("a forged cursor value only filters the caller's own rows; a cursor inside a run of equal totals continues after the given name", !JSON.stringify(forged.rows).includes('LEAK') && JSON.stringify(inTie.rows.map((x: any) => x.name)) === '["cherry","date"]', [forged.rows, inTie.rows]);
  // NULL order is the dialect's own (ADR-0039): SQLite puts NULL first ascending and last descending with an ascending id tiebreak;
  // a native-order dialect (PostgreSQL) puts it last ascending and first descending, and the tiebreak follows the last key. A cursor pages across the NULLs either way.
  const nativeOrder = !!b.dialect.nativeOrder;
  const paged = async (sql: string) => {
    const q = await program('view', sql);
    const ids: string[] = [];
    let after: unknown[] | undefined;
    for (let i = 0; i < 6; i++) {
      const page = await runView(s, q, caller(), { cursor: after, pageSize: 1 });
      ids.push(...page.rows.map((x: any) => x.id));
      if (!page.next) break;
      after = page.next;
    }
    return ids;
  };
  r.equal(`NULL order, ascending, paged one row at a time (${nativeOrder ? 'native: NULL last' : 'SQLite: NULL first'})`,
    await paged('SELECT id, note FROM items ORDER BY note'), nativeOrder ? ['c', 'd', 'a', 'b'] : ['a', 'b', 'c', 'd']);
  r.equal(`NULL order, descending, paged one row at a time (${nativeOrder ? 'native: NULL first, id descending' : 'SQLite: NULL last, id ascending'})`,
    await paged('SELECT id, note FROM items ORDER BY note DESC'), nativeOrder ? ['b', 'a', 'd', 'c'] : ['d', 'c', 'a', 'b']);
  // Compare with each engine's own whole query, including null-extended native NOT NULL keys and authored LIMIT.
  for (const sql of [
    ...['ASC', 'DESC'].flatMap((dir) => ['FIRST', 'LAST'].map((nulls) => `SELECT id, note FROM items ORDER BY note ${dir} NULLS ${nulls}, id DESC`)),
    'SELECT id FROM items ORDER BY updated_at DESC, id ASC',
    'SELECT id FROM items ORDER BY updated_at ASC, id DESC LIMIT 3',
    'SELECT i.id, o.id AS order_id FROM items i LEFT JOIN orders o ON o.item_id = i.id ORDER BY o.updated_at DESC NULLS LAST, i.id, o.id',
    'SELECT s.id, s.order_id FROM (SELECT i.id, o.id AS order_id, o.updated_at AS at FROM items i LEFT JOIN orders o ON o.item_id = i.id) s ORDER BY s.at DESC NULLS FIRST, s.id, s.order_id',
  ]) {
    const q = await program('view', sql);
    const whole = (await runView(s, q, caller())).rows;
    const walked: any[] = [];
    let after: unknown[] | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await runView(s, q, caller(), { cursor: after, pageSize: 1 });
      walked.push(...page.rows);
      if (!page.next) break;
      after = page.next;
    }
    r.equal(`native cursor parity: ${sql}`, walked, whole);
  }

}
