// @ts-nocheck test code over loosely typed IR
/** ADR-0037 decision 1: D1 runs the base profile, and refuses each reference-profile construct as needing PostgreSQL. */
import { expect, it } from "vitest";
import { program } from "../../src/testing/harness.js";

const POSTGRES_ONLY = [
  "WITH s AS (SELECT id FROM items) SELECT id FROM s ORDER BY id",
  "SELECT u.id FROM (SELECT id FROM items UNION ALL SELECT id FROM requisitions) u ORDER BY u.id",
  "SELECT i.id, x.first FROM items i JOIN LATERAL (SELECT o.id AS first FROM orders o WHERE o.item_id = i.id ORDER BY o.id LIMIT 1) x ON true ORDER BY i.id",
  "SELECT id, max(stock) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS m FROM items ORDER BY id",
  "SELECT id, lag(id) OVER (ORDER BY id) AS prev FROM items ORDER BY id",
  "SELECT count(*) FILTER (WHERE cat = 'x') AS xs FROM items",
  "SELECT t.id FROM (SELECT DISTINCT ON (cat) cat, id FROM items ORDER BY cat, stock DESC) t ORDER BY t.id",
  "SELECT id FROM items WHERE tags @> '[\"red\"]'::jsonb ORDER BY id",
  "SELECT id FROM items WHERE name ILIKE 'a%' ORDER BY id",
  "SELECT id, greatest(stock, 6) AS g FROM items ORDER BY id",
  "SELECT id, CAST(stock AS int8) AS s FROM items ORDER BY id",
];

it("D1 refuses every reference-profile construct as needing the PostgreSQL dialect", async () => {
  for (const sql of POSTGRES_ONLY) await expect(program("view", sql), sql).rejects.toThrow(/needs the PostgreSQL dialect/);
  // what neither profile accepts is an ordinary refusal
  await expect(program("view", "SELECT g.id FROM generate_series(1, 3) g")).rejects.toThrow(/^(?!.*PostgreSQL dialect).*only json_each/);
});
