import { fixtureCaller } from "./apps/fixtures.js";
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
const directory = resolve(import.meta.dir, "apps/.generated", `publishing-${crypto.randomUUID()}`);
afterAll(() => rm(directory, { recursive: true, force: true }));
test("publishing is opt-in", async () => {
  const sources = await loadFixtureSources("publishing.yaml");
  const files = await generateOrThrow("bun-sqlite", sources.map(s => ({ ...s, text: s.text.split("---")[0]!.replace("  lifecycle: publishing\n", "") })));
  expect(files["schema.sql"]).not.toContain("status");
  expect(files["generated.ts"]).not.toContain("posts.publish");
});

test("SQLite public visibility composes through joins, LEFT JOINs, subqueries and CTEs", async () => {
  const files = await generateOrThrow("bun-sqlite", await loadFixtureSources("publishing.yaml", "publishing-visibility.yaml"));
  const path = resolve(directory, "visibility"); await writeGenerated(path, files);
  const app = await import(resolve(path, "generated.ts")), db = new Database(":memory:"); db.exec(files["schema.sql"]!);
  const admin = { kind: "system", reason: "test" }, anonymous = { kind: "anonymous" }, data = app.store(db, admin);
  try {
    const draft = await data.collection("posts").insert({ title: "Draft" }), published = await data.collection("posts").insert({ title: "Published" });
    await app.procedures["posts.publish"](db, admin, { id: published.id, expectedVersion: 1 });
    for (const p of [draft, published]) await data.collection("anchors").insert({ postid: p.id });
    for (const caller of [anonymous, admin]) {
      for (const name of ["posts-join", "posts-cte"]) {
        const [row] = await app.views[name](db, caller, {});
        expect(Number(row.count)).toBe(1);
        expect(Number(row.drafts)).toBe(0);
      }
      const [left] = await app.views["posts-left"](db, caller, {});
      expect(Number(left.anchors)).toBe(2);
      expect(Number(left.visible)).toBe(1);
      expect(Number(left.drafts)).toBe(0);
    }
    expect((await app.views["posts-subquery"](db, anonymous, {})).map((r: any) => r.id)).toEqual([published.id]);
    expect(Number((await app.views["posts-count"](db, anonymous, {}))[0].count)).toBe(1);
    expect((await app.views["posts-time"](db, anonymous, {}))[0].published_at).toMatch(/Z$/);
    for (const role of [null, "admin", "owner", "customRole"]) {
      const caller = fixtureCaller({ kind: "user", subject: "reader", role, admin: role === "admin", scopes: [], credential: "session", credentialId: null, clientId: null });
      const view = await app.views["posts-admin"](db, caller, {}), store = await app.store(db, caller).collection("posts").find();
      expect(view.map((r: any) => r.id)).toEqual(store.rows.map((r: any) => r.id));
      expect(view.length).toBe(role === "admin" ? 2 : 1);
    }
  } finally { db.close(); }
});

test("PostgreSQL publishing binds its native clock without an ISO-input text cast", async () => {
  const files = await generateOrThrow("bun-postgres", await loadFixtureSources("publishing.yaml"));
  const path = resolve(directory, "clock"); await writeGenerated(path, files);
  const app = await import(resolve(path, "generated.ts"));
  let statement = "", values: unknown[] = [];
  const db = { unsafe: async (sql: string, binds: unknown[]) => { statement = sql; values = binds; return Object.assign([{ id: "one" }], { count: 1 }); } };
  await app.procedures["posts.publish"](db, { kind: "system", reason: "clock" }, { id: "one", expectedVersion: 1 });
  expect(values[0]).toBeInstanceOf(Date);
  expect(values).toHaveLength(3);
  expect(statement).toContain("published_at = $1");
  expect(statement).not.toContain("CAST($1");
});

test("operational schemas cannot expose the publishing timestamp", async () => {
  const [source] = await loadFixtureSources("publishing.yaml");
  const text = source!.text.split("---")[0]!.replace("lifecycle: publishing", "lifecycle: operational") + `---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: invalid-clock}
spec:
  surface: internal
  sql: SELECT published_at FROM posts
`;
  await expect(generateOrThrow("bun-sqlite", [{ sourceId: "operational.yaml", text }])).rejects.toThrow(/SQL_COLUMN/);
});
