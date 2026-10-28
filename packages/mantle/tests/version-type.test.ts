import { fixtureCaller } from "./apps/fixtures.js";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
await mkdir(resolve(import.meta.dir, "apps/.generated"), { recursive: true });

// #1826: PostgreSQL's int8 `version` arrives as text; the Store, a ref handler and REST/MCP give a number on every engine.
const text = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
 title: Notes
 lifecycle: operational
 scope: 'owner = auth.uid()'
 indexes: [[owner, id]]
 schema: {type: object, required: [owner, title], properties: {owner: {type: string}, title: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: notes}
spec:
 surface: public
 requires: {auth: {all: [ctx.user]}}
 sql: SELECT id, version FROM notes ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: revise}
spec:
 requires: {auth: {all: [ctx.user]}}
 input: {type: object, required: [title], properties: {title: {type: string}}, additionalProperties: false}
 output: {type: object, required: [id, version], properties: {id: {type: string}, version: {type: integer}}, additionalProperties: false}
 handler: {ref: app.revise}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: touch}
spec:
 input: {type: object, required: [id], properties: {id: {type: string}}, additionalProperties: false}
 output: {type: object}
 handler: {sql: 'UPDATE notes SET title = title WHERE id = input.id RETURNING version'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: revise-http}
spec: {source: {kind: http, method: POST, path: /api/revise}, target: {procedure: revise}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: revise-mcp}
spec: {source: {kind: mcp, surface: public}, target: {procedure: revise}}
`;
const caller: any = fixtureCaller({ kind: "user", subject: "a", role: null, credential: "api-key", credentialId: null, clientId: null, scopes: ["mcp"] });
const rpc = async (handle: (r: Request, env: unknown) => Promise<Response | undefined>, name: string, args: object) => {
  const response = (await handle(new Request("https://app.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), {}))!;
  const body = await response.text(), data = JSON.parse(body.startsWith("event:") ? body.split("data: ")[1]!.split("\n")[0]! : body);
  expect(data.result.isError).toBeUndefined();
  return data.result.structuredContent;
};

for (const pg of [false, true]) (pg && !process.env.MANTLE_NEXT_BUN_PG_URL ? test.skip : test)(`version is a number from the Store, a ref handler and REST/MCP (${pg ? "PostgreSQL" : "SQLite"})`, async () => {
  const files = await generateOrThrow(pg ? "bun-postgres" : "bun-sqlite", [{ sourceId: "version-type.yaml", text }]);
  expect(files["generated.ts"]).toMatch(/notes: \{ row: \{ id: string; version: number;/);
  const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/version-type-")), namespace = "version_type_" + crypto.randomUUID().replaceAll("-", "");
  const db: any = pg ? new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }) : new Database(":memory:");
  try {
    await writeGenerated(dir, files);
    const app = await import(resolve(dir, "generated.ts"));
    if (pg) { await db.unsafe(`CREATE SCHEMA ${namespace}`); await db.unsafe(`SET search_path TO ${namespace}`); await db.unsafe(files["schema.sql"]!); } else db.exec(files["schema.sql"]!);
    const handlers = { revise: async (ctx: any, input: { title: string }) => {
      const notes = ctx.store.collection("notes"), row = await notes.insert({ title: input.title });
      const { id, version } = await notes.update(row.id, { title: input.title + "!" }, { lock: row.version });
      return { id, version };
    } };
    const notes = app.store(db, caller, { handlers }).collection("notes");
    const inserted = await notes.insert({ title: "one" });
    expect(inserted.version).toBe(1);
    const updated = await notes.update(inserted.id, { title: "two" }, { lock: "1" }); // an exact int8 string still locks
    expect(updated.version).toBe(2);
    expect((await notes.findById(inserted.id))!.version).toBe(2);
    expect((await notes.find({ where: { version: 2 } })).rows.map((r: any) => r.version)).toEqual([2]);
    expect(await app.store(db, caller, { handlers }).procedures.revise({ title: "ref" })).toMatchObject({ version: 2 });
    // a Procedure's RETURNING stays driver-native (reference/procedure.md)
    expect((await app.procedures.touch(db, { kind: "system", reason: "test" }, { id: inserted.id })).results[0][0].version).toBe(pg ? "3" : 3);

    const { rest } = await import(resolve(dir, "rest.ts")), serve = rest({ db: () => db, caller: async () => caller, handlers });
    const revised = await (await serve(new Request("https://app.test/api/revise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "rest" }) }), {}))!.json();
    expect(revised.version).toBe(2);
    const page = await (await serve(new Request("https://app.test/api/views/notes"), {}))!.json();
    expect(page.rows.every((r: any) => typeof r.version === "number")).toBe(true);
    const { mcp } = await import(resolve(dir, "mcp.ts")), handle = mcp({ db: () => db, caller: () => caller, handlers });
    expect((await rpc(handle, "revise", { title: "mcp" })).version).toBe(2);
    expect((await rpc(handle, "notes", {})).rows.every((r: any) => typeof r.version === "number")).toBe(true);

    // past 2^53 the Store refuses rather than rounding into a lock
    const big = pg ? "9007199254740993" : "9007199254740992";
    if (pg) await db.unsafe(`UPDATE notes SET version = ${big} WHERE id = '${inserted.id}'`); else db.exec(`UPDATE notes SET version = ${big} WHERE id = '${inserted.id}'`);
    await expect(notes.findById(inserted.id)).rejects.toMatchObject({ code: "SQL_TYPE" });
  } finally {
    if (pg) { await db.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await db.close(); } else db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
