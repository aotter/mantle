import { expect, spyOn, test } from "bun:test";
import { mcp, type McpApps, type Tool } from "@aotter/mantle/mcp";
import { sdkFixtureCaller as fixtureCaller } from "../../../mantle/tests/apps/fixtures.js";
import { adminMcpApps } from "../../src/server/mcp.js";

const catalogue = { views: { pending: { actions: [] }, other: { actions: [] } }, actions: {} };
const caller = fixtureCaller({ kind: "user", subject: "a", role: "admin", admin: true, credential: "oauth", scopes: ["mcp"], credentialId: null, clientId: null });
const tools: Tool<null>[] = ["pending", "other"].map(name => ({ name, target: { kind: "view", name }, surface: "admin", description: name,
  inputSchema: { type: "object" }, validate: () => ({}), page: async () => ({ rows: [] }) }));
const custom: McpApps = { resources: [{ name: "custom-other", uri: "ui://custom/other/build-1", renders: ["other"], html: "<p>custom</p>" }] };
const ui = { "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } };
type Env = { ASSETS: { fetch(request: Request): Promise<Response> } };
const env = (build: string): Env => ({ ASSETS: { fetch: async () => new Response(`<head></head><p>${build}</p>`) } });
const rpc = async (api: ReturnType<typeof mcp<Env, null>>, env: Env, method: string, params: object = {}) => {
  const response = await api(new Request("https://app.test/mcp/admin", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: ui } }) }), env);
  const text = await response!.text();
  return { status: response!.status, body: JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text) };
};

test("new Admin builds update tools and resource links together, without caching a caller catalogue", async () => {
  const api = mcp<Env, null>(tools, { db: () => null, caller: () => caller, authorize: target => target.name === "pending",
    apps: { admin: [adminMcpApps({ catalogue, renders: ["pending"] }), custom] } });
  const builds = [env("build-one"), env("build-two")];
  const lists = await Promise.all(builds.map(binding => rpc(api, binding, "tools/list")));
  const uris = lists.map(list => list.body.result.tools[0]._meta.ui.resourceUri);
  expect(uris[0]).not.toBe(uris[1]);
  for (const [index, binding] of builds.entries()) {
    expect(lists[index]!.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["pending"]);
    const uri = uris[index];
    const listed = (await rpc(api, binding, "resources/list")).body.result.resources;
    expect(listed.map((resource: { uri: string }) => resource.uri)).toContain(uri);
    const read = (await rpc(api, binding, "resources/read", { uri })).body.result.contents[0];
    expect(read.uri).toBe(uri);
    expect(read.text).toContain(index === 0 ? "build-one" : "build-two");
    const embedded = JSON.parse(/id="mantle-catalog">(.*?)<\/script>/.exec(read.text)![1]!);
    expect(embedded).toEqual({ views: { pending: { actions: [] } }, actions: {} });
  }
  expect((await rpc(api, builds[1]!, "resources/read", { uri: uris[0] })).body.error).toBeDefined();
  expect((await rpc(api, builds[0]!, "tools/call", { name: "other", arguments: {} })).status).toBe(403);
});

test("default/custom renderer collisions fail in either order; explicit partitions preserve each link", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const sources of [[adminMcpApps({ catalogue }), custom], [custom, adminMcpApps({ catalogue })]]) {
      const api = mcp<Env, null>(tools, { db: () => null, caller: () => caller, apps: { admin: sources } });
      expect((await rpc(api, env("build"), "tools/list")).status).toBe(500);
    }
    expect(log.mock.calls.flat().filter(value => value instanceof Error && value.message.includes("claimed by two"))).toHaveLength(2);
  } finally { log.mockRestore(); }
  const api = mcp<Env, null>(tools, { db: () => null, caller: () => caller,
    apps: { admin: [adminMcpApps({ catalogue, renders: ["pending"] }), custom] } });
  const listed = (await rpc(api, env("build"), "tools/list")).body.result.tools;
  expect(listed.find((tool: { name: string }) => tool.name === "pending")._meta.ui.resourceUri).toMatch(/^ui:\/\/mantle-admin\/admin\/[a-f0-9]{64}$/);
  expect(listed.find((tool: { name: string }) => tool.name === "other")._meta.ui.resourceUri).toBe("ui://custom/other/build-1");
});
