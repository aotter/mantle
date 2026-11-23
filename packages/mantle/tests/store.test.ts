/** Runtime Store scenarios run on four real hosts in scripts/verify-native.ts. */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import postgres from "postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { generateOrThrow, loadFixtureSources, loadGenerated, writeGenerated } from "./apps/link.js";
import { d1Shim } from "./apps/d1-shim.js";
import { user } from "./apps/fixtures.js";
import { verifyDeclaredNames } from "./store-scenarios.js";

const generate = async () =>
  generateOrThrow(
    "bun-sqlite",
    await loadFixtureSources("purchase.yaml", "store-extra.yaml", "store-equivalence.yaml", "store-transactions.yaml"),
  );

test("generated types: a geo field's two columns are in the row, the scope column is nowhere, and orderBy is NOT NULL and indexed", async () => {
  const types = (await generate())["generated.ts"]!;
  const table = (name: string) => new RegExp(`${name}: \\{ row:.*?order: [^}]*\\}`).exec(types)![0];
  expect(table("catalog_items")).toContain("place_lat: number | null; place_lng: number | null");
  expect(table("catalog_items")).toContain('order: "id" | "name"');
  expect(table("session_notes")).not.toContain("owner:");
});

test("Store placeholders continue after scope and TTL binds in caller and trusted modes", async () => {
  const directory = await mkdtemp(resolve(import.meta.dir, "apps/.store-binds-"));
  try {
    await writeGenerated(directory, await generate());
    const app = await import(resolve(directory, "generated.ts"));
    let sql = "",
      values: unknown[] = [];
    const db = {
      query(text: string) {
        sql = text;
        return {
          all(...binds: unknown[]) {
            values = binds;
            return text.startsWith("SELECT COUNT(*)") ? [{ count: 0 }] : [];
          },
        };
      },
    };
    const caller = app.store(db, user("store-owner-a")),
      trusted = app.store(db, { kind: "system", reason: "store-binds" });
    for (const [store, base] of [
      [caller, ["store-owner-a"]],
      [trusted, []],
    ] as const) {
      const purchases = store.collection("purchase_requests"),
        offset = base.length;
      await purchases.find({ where: { title: "Item 1", amount: { gt: 1 } } });
      expect(values).toEqual([...base, "Item 1", 1]);
      expect(sql).toContain(`r."title" = ?${offset + 1}`);
      expect(sql).toContain(`r."amount" > ?${offset + 2}`);
      if (offset) await store.collection("session_notes").find({ where: { body: "x" } });
      else await store.collection("session_notes").count({ body: "x" });
      expect(values).toHaveLength(offset + 2);
      expect(sql).toContain(`r."body" = ?${offset + 2}`);
      await purchases.findById("x");
      expect(values).toEqual([...base, "x"]);
      expect(sql).toContain(`r."id" = ?${offset + 1}`);
    }
    await caller.collection("purchase_requests").find({
      orderBy: "title",
      limit: 5,
      cursor: encodeURIComponent(JSON.stringify(["Item 0", "id"])),
      where: { title: { like: "Item%" } },
    });
    expect(Math.max(...[...sql.matchAll(/\?(\d+)/g)].map(match => Number(match[1])))).toBe(values.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// #2119: the generated types name storage columns; a declared name given anyway is that column on each stack.
const urls = {
  "bun-sqlite": "sqlite",
  "cloudflare-d1": "sqlite",
  "bun-postgres": process.env.MANTLE_NEXT_BUN_PG_URL,
  "cloudflare-postgres": process.env.MANTLE_NEXT_WORKER_PG_URL,
} as const;
for (const [target, url] of Object.entries(urls) as [keyof typeof urls, string | undefined][])
  (url ? test : test.skip)(
    `${target}: a declared field name is its storage column in insert, update, where, orderBy and cursors`,
    async () => {
      const files = await generateOrThrow(target, await loadFixtureSources("purchase.yaml"));
      expect(files["generated.ts"]).toContain("set: { requestnumber: string;");
      const app = await loadGenerated(files["generated.ts"]!);
      const schema = "declared_" + crypto.randomUUID().replaceAll("-", "");
      let db: any;
      if (url === "sqlite") {
        const sqlite = new Database(":memory:");
        sqlite.exec(files["schema.sql"]!);
        db = target === "bun-sqlite" ? sqlite : d1Shim(sqlite);
      } else {
        db = target === "bun-postgres" ? new SQL(url!, { max: 1 }) : postgres(url!, { max: 1, onnotice: () => {} });
        await db.unsafe(`CREATE SCHEMA ${schema}`);
        await db.unsafe(`SET search_path TO ${schema}`);
        await db.unsafe(files["schema.sql"]!);
      }
      try {
        await verifyDeclaredNames(app.store(db, user("store-owner-a")).collection("purchase_requests"));
      } finally {
        if (url !== "sqlite") {
          await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
          await (target === "bun-postgres" ? db.close() : db.end());
        }
      }
    },
    30000,
  );
