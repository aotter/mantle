import { expect, spyOn, test } from "bun:test";
import { mcp, type McpApps, type Tool } from "@aotter/mantle/mcp";
import { sdkFixtureCaller as fixtureCaller } from "../../../mantle/tests/apps/fixtures.js";
import { adminMcpApps } from "../../src/server/mcp.js";

const catalogue = { views: { pending: { actions: [] }, other: { actions: [] } }, actions: {} };
const caller = fixtureCaller({
  kind: "user",
  subject: "a",
  role: "admin",
  admin: true,
  credential: "oauth",
  scopes: ["mcp"],
  credentialId: null,
  clientId: null,
});
const tools: Tool<null>[] = ["pending", "other"].map(name => ({
  name,
  target: { kind: "view", name },
  surface: "admin",
  description: name,
  inputSchema: { type: "object" },
  validate: () => ({}),
  page: async () => ({ rows: [] }),
}));
const custom: McpApps = {
  resources: [{ name: "custom-other", uri: "ui://custom/other/build-1", renders: ["other"], html: "<p>custom</p>" }],
};
const ui = {
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  },
};
type Env = { ASSETS: { fetch(request: Request): Promise<Response> } };
const env = (build: string): Env => ({ ASSETS: { fetch: async () => new Response(`<head></head><p>${build}</p>`) } });
const rpc = async (api: ReturnType<typeof mcp<Env, null>>, env: Env, method: string, params: object = {}) => {
  const response = await api(
    new Request("https://app.test/mcp/admin", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: ui } }),
    }),
    env,
  );
  const text = await response!.text();
  return {
    status: response!.status,
    body: JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text),
  };
};

test("by default tools link the fixed URI across builds; it reads the current build, which also answers at its hash URI (#1934)", async () => {
  const api = mcp<Env, null>(tools, {
    db: () => null,
    caller: () => caller,
    authorize: target => target.name === "pending",
    apps: { admin: [adminMcpApps({ catalogue, renders: ["pending"] }), custom] },
  });
  const builds = [env("build-one"), env("build-two")];
  const revisions: string[] = [];
  for (const [index, binding] of builds.entries()) {
    const tool = (await rpc(api, binding, "tools/list")).body.result.tools[0];
    expect(tool._meta.ui.resourceUri).toBe("ui://mantle-admin/admin");
    const listed = (await rpc(api, binding, "resources/list")).body.result.resources.map(
      (resource: { uri: string }) => resource.uri,
    );
    const revision = listed.find((uri: string) => /^ui:\/\/mantle-admin\/admin\/[a-f0-9]{64}$/.test(uri));
    expect(revision).toBeDefined();
    revisions.push(revision);
    for (const uri of ["ui://mantle-admin/admin", revision]) {
      const read = (await rpc(api, binding, "resources/read", { uri })).body.result.contents[0];
      expect(read.text).toContain(index === 0 ? "build-one" : "build-two");
    }
  }
  expect(revisions[0]).not.toBe(revisions[1]);
});

test("each build's hash URI reads that build only, without caching a caller catalogue", async () => {
  const api = mcp<Env, null>(tools, {
    db: () => null,
    caller: () => caller,
    authorize: target => target.name === "pending",
    apps: { admin: [adminMcpApps({ catalogue, renders: ["pending"] }), custom] },
  });
  const builds = [env("build-one"), env("build-two")];
  const lists = await Promise.all(builds.map(binding => rpc(api, binding, "tools/list")));
  const uris = await Promise.all(
    builds.map(async binding =>
      (await rpc(api, binding, "resources/list")).body.result.resources
        .map((resource: { uri: string }) => resource.uri)
        .find((uri: string) => /\/admin\/[a-f0-9]{64}$/.test(uri)),
    ),
  );
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
    for (const sources of [
      [adminMcpApps({ catalogue }), custom],
      [custom, adminMcpApps({ catalogue })],
    ]) {
      const api = mcp<Env, null>(tools, { db: () => null, caller: () => caller, apps: { admin: sources } });
      expect((await rpc(api, env("build"), "tools/list")).status).toBe(500);
    }
    expect(
      log.mock.calls.flat().filter(value => value instanceof Error && value.message.includes("claimed by two")),
    ).toHaveLength(2);
  } finally {
    log.mockRestore();
  }
  const api = mcp<Env, null>(tools, {
    db: () => null,
    caller: () => caller,
    apps: { admin: [adminMcpApps({ catalogue, renders: ["pending"] }), custom] },
  });
  const listed = (await rpc(api, env("build"), "tools/list")).body.result.tools;
  expect(listed.find((tool: { name: string }) => tool.name === "pending")._meta.ui.resourceUri).toBe(
    "ui://mantle-admin/admin",
  );
  expect(listed.find((tool: { name: string }) => tool.name === "other")._meta.ui.resourceUri).toBe(
    "ui://custom/other/build-1",
  );
});

test("a host-supplied URI scopes the App per site: the resource and every tool it renders link it, and no default or hash URI is served (#1952)", async () => {
  for (const uri of ["ui://mantle-admin/site-a/admin", "ui://mantle-admin/site-b/admin"]) {
    const api = mcp<Env, null>(tools, {
      db: () => null,
      caller: () => caller,
      apps: { admin: [adminMcpApps({ catalogue, uri })] },
    });
    const listed = (await rpc(api, env("build"), "tools/list")).body.result.tools;
    expect(listed.map((tool: { _meta: { ui: { resourceUri: string } } }) => tool._meta.ui.resourceUri)).toEqual([
      uri,
      uri,
    ]);
    expect(
      (await rpc(api, env("build"), "resources/list")).body.result.resources.map(
        (resource: { uri: string }) => resource.uri,
      ),
    ).toEqual([uri]);
    expect((await rpc(api, env("build"), "resources/read", { uri })).body.result.contents[0].text).toContain("build");
    expect(
      (await rpc(api, env("build"), "resources/read", { uri: "ui://mantle-admin/admin" })).body.error,
    ).toBeDefined();
  }
});

test("`tools` links a Procedure tool to the Admin App beside the catalogue's Views; an unserved name is refused", async () => {
  const approve: Tool<null> = {
    name: "approve_request",
    target: { kind: "procedure", name: "approve-request" },
    surface: "admin",
    description: "approve",
    inputSchema: { type: "object" },
    validate: () => ({}),
    run: async () => ({ results: [[{ id: "r1" }]] }),
  };
  const api = mcp<Env, null>([...tools, approve], {
    db: () => null,
    caller: () => caller,
    apps: { admin: adminMcpApps({ catalogue, tools: ["approve_request"] }) },
  });
  const listed = (await rpc(api, env("build-one"), "tools/list")).body.result.tools as {
    name: string;
    _meta?: { ui?: { resourceUri?: string } };
  }[];
  expect(listed.map(tool => [tool.name, tool._meta?.ui?.resourceUri])).toEqual([
    ["pending", "ui://mantle-admin/admin"],
    ["other", "ui://mantle-admin/admin"],
    ["approve_request", "ui://mantle-admin/admin"],
  ]);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const unserved = mcp<Env, null>(tools, {
      db: () => null,
      caller: () => caller,
      apps: { admin: adminMcpApps({ catalogue, tools: ["approve_request"] }) },
    });
    // MCP_APP_CONFLICT is a configuration error: redacted on the wire, logged on the server
    expect((await rpc(unserved, env("build-one"), "tools/list")).status).toBe(500);
    expect(String((errors.mock.calls[0]![1] as Error).message)).toContain(
      "names tool 'approve_request', which this endpoint does not serve",
    );
  } finally {
    errors.mockRestore();
  }
});
