import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { sdkFixtureCaller } from "./apps/fixtures.js";
import type { Caller } from "../src/kernel/contracts.js";
import { mcp, type Tool } from "../src/kernel/mcp.js";

const uri = "ui://my-tasks/build-1";
const apps = {
  public: { resources: [{ uri, name: "my-tasks", renders: ["my_tasks"], html: "<h1>My tasks</h1>" }] },
};
const user = (subject: string) =>
  sdkFixtureCaller({
    kind: "user" as const,
    subject,
    role: "user",
    admin: false,
    credential: "oauth" as const,
    scopes: ["mcp"],
    clientId: null,
    credentialId: null,
  });
const ids = (result: { structuredContent: { rows: { id: string }[] } }) =>
  result.structuredContent.rows.map(row => row.id);

/** The example manifest generated into a throwaway directory, over a database holding two of alice's tasks and one of bob's. */
async function example(run: (generated: string, db: Database) => Promise<void>) {
  const text = await readFile(
    new URL("../../../docs/examples/frontend-mcp-app/manifest.yaml", import.meta.url),
    "utf8",
  );
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "frontend.yaml", text }]);
  const dir = await mkdtemp(resolve(import.meta.dir, ".frontend-app-")),
    db = new Database(":memory:");
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    db.exec(
      "INSERT INTO tasks(id,version,created_at,updated_at,owner,title) VALUES ('a1',1,0,0,'alice','Alice one'),('a2',1,0,0,'alice','Alice two'),('b1',1,0,0,'bob','Bob one')",
    );
    await run(resolve(dir, "mcp.ts"), db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** One JSON-RPC request; `params._meta` may declare the client's capabilities. */
async function post(
  handle: (request: Request, env: object) => Promise<Response | undefined>,
  path: string,
  body: object,
) {
  const response = (await handle(
    new Request("https://frontend.test" + path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    }),
    {},
  ))!;
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text) : null,
  };
}

test("frontend App uses authenticated owner scope, independent resource registration and no Admin authority", () =>
  example(async (generated, db) => {
    let caller: Caller = { kind: "anonymous" };
    const handle = (await import(generated)).mcp({ db: () => db, caller: () => caller, apps });
    const call = (method: string, params: object = {}, path = "/mcp") => post(handle, path, { method, params });
    expect((await call("tools/call", { name: "my_tasks", arguments: {} })).status).toBe(401);
    caller = user("alice");
    const listed = (await call("tools/list")).body.result.tools;
    expect(listed.map((tool: { name: string }) => tool.name)).toEqual(["my_tasks"]);
    expect(listed[0]._meta.ui.resourceUri).toBe(uri);
    const first = (await call("tools/call", { name: "my_tasks", arguments: { limit: 1 } })).body.result;
    expect(ids(first)).toEqual(["a1"]);
    const second = (
      await call("tools/call", {
        name: "my_tasks",
        arguments: { limit: 1, cursor: first.structuredContent.nextCursor },
      })
    ).body.result;
    expect(ids(second)).toEqual(["a2"]);
    expect((await call("tools/list", {}, "/mcp/admin")).status).toBe(403);
    expect((await call("tools/call", { name: "administration", arguments: {} })).body.error).toBeDefined();
    caller = user("bob");
    expect(ids((await call("tools/call", { name: "my_tasks", arguments: {} })).body.result)).toEqual(["b1"]);
  }));

test("a generated View tool marked as a host entry point keeps its App link, first page and authorization", () =>
  example(async (generated, db) => {
    let caller: Caller = { kind: "anonymous" };
    const { tools } = await import(generated);
    // The composition the example README shows: the generated tools, one given the host's entry-point key.
    const marked = (tools as readonly Tool<Database>[]).map(tool =>
      tool.name === "my_tasks" ? { ...tool, meta: { "openai/ui": { entrypoints: [{ type: "global" }] } } } : tool,
    );
    const handle = mcp(marked, { db: () => db, caller: () => caller, apps });
    // `withApps: false` is a client that declares its capabilities, without MCP Apps.
    const call = (method: string, params: object = {}, withApps = true) =>
      post(handle, "/mcp", {
        method,
        params: withApps ? params : { ...params, _meta: { "io.modelcontextprotocol/clientCapabilities": {} } },
      });
    expect((await call("tools/call", { name: "my_tasks", arguments: {} })).status).toBe(401);
    caller = user("alice");
    const [listed] = (await call("tools/list")).body.result.tools;
    expect(listed._meta.ui).toEqual({ resourceUri: uri });
    expect(listed._meta["openai/ui"]).toEqual({ entrypoints: [{ type: "global" }] });
    // What the host's entry-point page asks of the marked tool: every input optional, callable by the model,
    // a title of at most 60 characters, and a name without "__", ".." or a dot next to an underscore.
    expect(listed.inputSchema.required).toBeUndefined();
    expect(listed._meta.ui.visibility).toBeUndefined();
    expect(listed.title).toBe("My tasks");
    expect(listed.name).not.toMatch(/__|\.\.|\._|_\./);
    // Opened from the entry point, the host calls it with {}: the caller's own first page.
    expect(ids((await call("tools/call", { name: "my_tasks", arguments: {} })).body.result)).toEqual(["a1", "a2"]);
    caller = user("bob");
    expect(ids((await call("tools/call", { name: "my_tasks", arguments: {} })).body.result)).toEqual(["b1"]);
    // Without MCP Apps support the App link is gone and the result still reads as JSON text.
    const [plain] = (await call("tools/list", {}, false)).body.result.tools;
    expect(plain._meta.ui).toBeUndefined();
    const result = (await call("tools/call", { name: "my_tasks", arguments: {} }, false)).body.result;
    expect(JSON.parse(result.content[0].text).rows.map((row: { id: string }) => row.id)).toEqual(["b1"]);
  }));
