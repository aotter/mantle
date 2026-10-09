// The plan's MCP App: the catalog it embeds, and the tool each rendered result names.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { APP_TOOL_META_KEY, appCatalog, createMcpSurface, planApp, withCatalog } from "../../src/mcp/index.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: requests }
spec:
  title: Requests
  lifecycle: operational
  schema:
    type: object
    required: [item, totalMinor]
    properties:
      item: { type: string, title: { en: Item, zh-TW: 品項 } }
      totalMinor: { type: integer, x-mcp-hint: money-minor }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: approve }
spec:
  title: { en: Approve, zh-TW: 核准 }
  input: { type: object, required: [id, expectedVersion], properties: { id: { type: string }, expectedVersion: { type: integer } } }
  output: { type: object }
  target: { schema: requests, id: id, version: expectedVersion }
  handler: { sql: "UPDATE requests SET item = item WHERE id = input.id AND version = input.expectedVersion RETURNING id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: approve-mcp }
spec: { source: { kind: mcp, surface: staff }, target: { procedure: approve } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: pending }
spec:
  title: Pending
  surface: staff
  uiSchema: { list: { columns: [item, totalMinor] } }
  sql: SELECT id, version, item, totalMinor, created_at FROM requests ORDER BY item
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: totals }
spec: { surface: staff, sql: "SELECT count(*) AS n, sum(totalMinor) AS total FROM requests ORDER BY 1" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: notes }
spec: { title: Notes, lifecycle: operational, schema: { type: object, properties: { item: { type: string } } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: joined }
spec: { surface: staff, sql: "SELECT n.id, r.item FROM notes n JOIN requests r ON r.item = n.item ORDER BY 1" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: aliased }
spec: { surface: staff, sql: "SELECT item AS id, version FROM requests ORDER BY 1" }
`;

const staff: Caller = { kind: "user", subject: "s1", role: "owner", scopes: ["mcp"], credential: "oauth", credentialId: null, clientId: null };
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const UI = { [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } };
let rt: MantleRuntime;
let d1: LocalD1;
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:catalog", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan: res.plan, handlers: {}, storage: sqliteStorage(d1) });
  await rt.store.write([{ insert: "requests", values: { item: "Laptops", totalMinor: 1500 } }]);
}, 60_000);
afterAll(() => d1?.dispose());

describe("appCatalog", () => {
  it("names each View tool's columns as the fields they read, and the Procedures that act on its row", () => {
    const catalog = appCatalog(rt.plan, "staff");
    expect(Object.keys(catalog.views)).toEqual(["pending", "totals", "joined", "aliased"]);
    expect(catalog.views["pending"]).toEqual({
      title: "Pending",
      columns: { item: { type: "string", title: { en: "Item", "zh-TW": "品項" } }, totalMinor: { type: "integer", "x-mcp-hint": "money-minor" }, created_at: { type: "string", format: "date-time" } },
      list: { columns: ["item", "totalMinor"] },
      actions: ["approve"],
    });
    expect(catalog.actions).toEqual({ approve: { capability: "approve", title: { en: "Approve", "zh-TW": "核准" }, inputSchema: rt.plan.procedures["approve"]!.input, bind: [{ input: "id", field: "id" }], version: "expectedVersion", mutates: true } });
    // the aggregate keeps the field it sums; it outputs no id, so nothing acts on its rows
    expect(catalog.views["totals"]).toEqual({ columns: { total: { type: "integer", "x-mcp-hint": "money-minor" } }, list: { columns: [] }, actions: [] });
    // a join, or an id that is another column, names no entry
    expect(catalog.views["joined"]!.actions).toEqual([]);
    expect(catalog.views["aliased"]!.actions).toEqual([]);
    expect(JSON.stringify(catalog)).not.toMatch(/SELECT|UPDATE/);
  });

  it("is embedded as JSON no value can break out of", () => {
    const html = withCatalog("<html><head></head><body></body></html>", { views: { x: { columns: {}, list: { columns: [] }, actions: [], title: "</script><script>alert(1)</script> $$ $& $' $`" } }, actions: {} });
    expect(html).toContain('<script type="application/json" id="mantle-catalog">');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(html.slice(html.indexOf(">", html.indexOf("mantle-catalog")) + 1, html.indexOf("</script>"))).views.x.title).toBe("</script><script>alert(1)</script> $$ $& $' $`");
  });
});

describe("planApp on the staff surface", () => {
  const surface = () => createMcpSurface(rt, { basePath: "/mcp/staff", surface: "staff", apps: { resources: [planApp(rt.plan, { surface: "staff", html: "<html><head></head><body>app</body></html>" })] } });
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const res = await surface()(new Request("http://x/mcp/staff", { method: "POST", headers: HEADERS, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: UI } }) }), staff);
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text).result;
  };

  it("renders every View tool, serves the HTML with the catalog, and each rendered result names its tool", async () => {
    const tools = (await rpc("tools/list", {})).tools as { name: string; _meta?: { ui?: { resourceUri?: string } } }[];
    expect(Object.fromEntries(tools.map((t) => [t.name, t._meta?.ui?.resourceUri ?? null]))).toEqual({ approve: null, pending: "ui://mantle/staff", totals: "ui://mantle/staff", joined: "ui://mantle/staff", aliased: "ui://mantle/staff" });
    const metas = Object.fromEntries((tools as unknown as { name: string; _meta?: Record<string, unknown> }[]).map((t) => [t.name, t._meta]));
    expect(metas.pending).toMatchObject({ "openai/outputTemplate": "ui://mantle/staff", ui: { resourceUri: "ui://mantle/staff" } });
    expect(metas.approve).toBeUndefined();
    const [content] = (await rpc("resources/read", { uri: "ui://mantle/staff" })).contents;
    expect(content.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(content.text).toContain('"actions":{"approve":{"capability":"approve"');
    const pending = await rpc("tools/call", { name: "pending", arguments: {} });
    expect(pending._meta).toEqual({ [APP_TOOL_META_KEY]: "pending" });
    expect(pending.structuredContent.rows[0]).toMatchObject({ item: "Laptops", version: 1 });
    // a tool no App renders carries no tag
    expect((await rpc("tools/call", { name: "approve", arguments: { id: pending.structuredContent.rows[0].id, expectedVersion: 1 } }))._meta).toBeUndefined();
  });
});
