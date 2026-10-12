import { expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { initialStorageSql, type StorageSchema } from "../../src/d1/storage.js";
import { initialStorageSql as postgresSql } from "../../src/postgres/storage.js";
import { notNullColumns } from "../../src/spec/domain/index.js";

const schema = (extra: object = {}): StorageSchema => ({
  fields: { title: "text", note: "text", maybe: "text", spot: "geo" },
  names: { title: "title", note: "note", maybe: "maybe", spot: "spot" },
  schema: { required: ["title", "maybe", "spot"], properties: { title: { type: "string" }, note: { type: "string" }, maybe: { type: ["string", "null"] }, spot: { type: "object" } } },
  ...extra,
});

it("an operational Schema's required, non-null fields are NOT NULL in the initial SQL of both dialects", async () => {
  expect([...notNullColumns(schema())].sort()).toEqual(["spot_lat", "spot_lng", "title"]);
  const d1 = await LocalD1.create();
  try {
    for (const sql of initialStorageSql({ items: schema() })) await d1.exec(sql);
    const insert = (cols: string, vals: string) => d1.exec(`INSERT INTO items (id, created_at, ${cols}) VALUES ('a', 0, ${vals})`);
    await expect(insert("note, maybe, spot_lat, spot_lng", "'n', NULL, 1, 2")).rejects.toThrow(/NOT NULL constraint failed: items.title/);
    await expect(insert("title, spot_lat, spot_lng", "'t', NULL, 2")).rejects.toThrow(/NOT NULL constraint failed: items.spot_lat/);
    await insert("title, spot_lat, spot_lng", "'t', 1, 2"); // a non-required and a nullable field may stay NULL
  } finally { await d1.dispose(); }
  const pg = postgresSql({ items: schema() }).join("\n");
  expect(pg).toContain('"title" text COLLATE "C" NOT NULL');
  expect(pg).toContain('"spot_lat" float8 NOT NULL');
  expect(pg).toMatch(/"note" text COLLATE "C"[,)]/);
  expect(pg).toMatch(/"maybe" text COLLATE "C"[,)]/);
});

it("a publishing Schema keeps its drafts incomplete", () => {
  expect(notNullColumns(schema({ publishing: true })).size).toBe(0);
  const create = initialStorageSql({ items: schema({ publishing: true }) }).find((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS "items"`));
  expect(create).toMatch(/"title" TEXT[,)]/);
  expect(postgresSql({ items: schema({ publishing: true }) }).join("\n")).not.toContain('"title" text COLLATE "C" NOT NULL');
});
