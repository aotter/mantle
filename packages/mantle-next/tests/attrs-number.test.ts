/** ADR-0046 spike: number attributes (single and multi-valued) on bun:sqlite and Bun.SQL; string attributes are covered by attrs.test.ts. */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { generateOrThrow, loadGenerated } from "./apps/link.js";
import { sales } from "./attrs-scenarios.js";

const manifest = `auth:
  attributes:
    level: { type: number }
    ranks: { type: number, multiple: true }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: tasks}
spec:
  title: Tasks
  lifecycle: operational
  schema: {type: object, required: [rank, title], properties: {rank: {type: integer}, title: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: by-rank}
spec: {surface: internal, sql: "SELECT id, title FROM tasks WHERE rank IN (auth.attr('ranks')) ORDER BY title, id"}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: by-level}
spec: {surface: internal, sql: "SELECT id, title FROM tasks WHERE rank = auth.attr('level') ORDER BY title, id"}
`;
const run = async (target: "bun-sqlite" | "bun-postgres", db: any) => {
  const files = await generateOrThrow(target, [{ sourceId: "n.yaml", text: manifest }]);
  const app = await loadGenerated(files["generated.ts"]!);
  if (target === "bun-sqlite") db.exec(files["schema.sql"]); else await db.unsafe(files["schema.sql"], []);
  const st = app.store(db, { kind: "system", reason: "seed" });
  await st.batch([1, 2, 3, 4].map(rank => st.collection("tasks").insert({ rank, title: `t${rank}` })));
  const titles = async (view: string, attrs?: object) => (await app.views[view](db, sales("u", attrs as never), {})).map((r: any) => r.title);
  expect(await titles("by-rank", { ranks: [1, 3] })).toEqual(["t1", "t3"]);
  expect(await titles("by-rank", { ranks: 2 })).toEqual(["t2"]);
  expect(await titles("by-rank", { ranks: ["1", "2"] as never })).toEqual([]);   // strings are not numbers: dropped, nothing matches
  expect(await titles("by-rank", {})).toEqual([]);
  expect(await titles("by-level", { level: 4 })).toEqual(["t4"]);
  expect(await titles("by-level", { level: "4" as never })).toEqual([]);
  expect(await titles("by-level")).toEqual([]);
};
test("bun:sqlite", async () => { await run("bun-sqlite", new Database(":memory:")); });
const url = process.env.MANTLE_NEXT_BUN_PG_URL;
test.skipIf(!url)("Bun.SQL", async () => {
  const name = `attrs_num_${crypto.randomUUID().replaceAll("-", "")}`, admin = new SQL({ url: url!, max: 1 });
  await admin.unsafe(`CREATE SCHEMA "${name}"`, []);
  const sql = new SQL({ url: url!, max: 1, connection: { search_path: name } });
  try { await run("bun-postgres", sql); } finally { await sql.close(); await admin.unsafe(`DROP SCHEMA "${name}" CASCADE`, []); await admin.close(); }
});
