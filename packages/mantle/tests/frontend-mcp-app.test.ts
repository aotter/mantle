import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { sdkFixtureCaller } from "./apps/fixtures.js";
import type { Caller } from "../src/kernel/contracts.js";

test("frontend App uses authenticated owner scope, independent resource registration and no Admin authority", async () => {
  const text = await readFile(new URL("../../../docs/examples/frontend-mcp-app/manifest.yaml", import.meta.url), "utf8");
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "frontend.yaml", text }]);
  const dir = await mkdtemp(resolve(import.meta.dir, ".frontend-app-")), db = new Database(":memory:");
  let caller: Caller = { kind: "anonymous" };
  try {
    await writeGenerated(dir, files); db.exec(files["schema.sql"]!);
    db.exec("INSERT INTO tasks(id,version,created_at,updated_at,owner,title) VALUES ('a1',1,0,0,'alice','Alice one'),('a2',1,0,0,'alice','Alice two'),('b1',1,0,0,'bob','Bob one')");
    const { mcp } = await import(resolve(dir, "mcp.ts"));
    const uri = "ui://my-tasks/build-1";
    const handle = mcp({ db: () => db, caller: () => caller, apps: { public: { resources: [{ uri, name: "my-tasks", renders: ["my_tasks"], html: "<h1>My tasks</h1>" }] } } });
    const call = async (method: string, params: object = {}, path = "/mcp") => {
      const response = await handle(new Request("https://frontend.test" + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), {});
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text) : null };
    };
    expect((await call("tools/call", { name: "my_tasks", arguments: {} })).status).toBe(401);
    const user = (subject: string) => sdkFixtureCaller({ kind: "user" as const, subject, role: "user", admin: false, credential: "oauth" as const, scopes: ["mcp"], clientId: null, credentialId: null });
    caller = user("alice");
    const listed = (await call("tools/list")).body.result.tools;
    expect(listed.map((tool: { name: string }) => tool.name)).toEqual(["my_tasks"]);
    expect(listed[0]._meta.ui.resourceUri).toBe(uri);
    const first = (await call("tools/call", { name: "my_tasks", arguments: { limit: 1 } })).body.result.structuredContent;
    expect(first.rows.map((row: { id: string }) => row.id)).toEqual(["a1"]);
    const second = (await call("tools/call", { name: "my_tasks", arguments: { limit: 1, cursor: first.nextCursor } })).body.result.structuredContent;
    expect(second.rows.map((row: { id: string }) => row.id)).toEqual(["a2"]);
    expect((await call("tools/list", {}, "/mcp/admin")).status).toBe(403);
    expect((await call("tools/call", { name: "administration", arguments: {} })).body.error).toBeDefined();
    caller = user("bob");
    expect((await call("tools/call", { name: "my_tasks", arguments: {} })).body.result.structuredContent.rows.map((row: { id: string }) => row.id)).toEqual(["b1"]);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
