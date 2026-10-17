import { fixtureCaller } from "./apps/fixtures.js";
import { expect, test, spyOn } from "bun:test";
import { mcp, type Tool } from "../src/kernel/mcp.js";
import { ContractError } from "../src/kernel/contracts.js";
import type { McpApps, McpAppResource } from "../src/kernel/mcp-apps.js";

const capabilities = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
const meta = { "io.modelcontextprotocol/clientCapabilities": capabilities };
const tools: Tool<null>[] = ["public", "admin"].flatMap(surface => ["rows", "details"].map(name => ({
  name: `${surface}_${name}`, surface, description: name, inputSchema: { type: "object", additionalProperties: false },
  validate: (raw: unknown) => raw as Record<string, unknown>, path: name,
  page: async () => ({ rows: [{ id: "one" }] }),
})));
const refused = (build: () => unknown, fragment: string) => {
  try { build(); throw new Error("expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(ContractError); expect((error as ContractError).code).toBe("MCP_APP_CONFLICT"); expect((error as Error).message).toContain(fragment); }
};
const resource = (uri: string, renders: string[] = []): McpAppResource => ({ uri, name: uri.slice(5), html: "<h1>App</h1>", renders });
const handle = (apps?: Parameters<typeof mcp<unknown, null>>[1]["apps"]) => mcp(tools, {
  db: () => null, caller: () => (fixtureCaller({ kind: "user", subject: "u", role: "admin", admin: true, scopes: ["mcp"], credential: "oauth", credentialId: null, clientId: null })), apps,
});
const call = async (api: ReturnType<typeof handle>, method: string, params: Record<string, unknown> = {}, surface = "public", ui: boolean | null = true) => {
  const response = await api(new Request(`https://app.test/mcp${surface === "admin" ? "/admin/" : "/"}`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, ...(ui !== null ? { _meta: ui ? meta : { "io.modelcontextprotocol/clientCapabilities": {} } } : {}) } }),
  }), {});
  const text = await response!.text();
  return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text);
};

test("public app and admin app + external Admin contributor use the same hook; HTML is request-only", async () => {
  let loads = 0;
  const admin: McpApps = { resources: [{ ...resource("ui://mantle-admin/rows", ["admin_rows"]), html: () => { loads++; return "<h1>Admin</h1>"; }, csp: { connectDomains: ["https://app.test"] }, prefersBorder: true }] };
  const api = handle({ public: { resources: [resource("ui://my-app/rows", ["public_rows"])] }, admin: [admin, { resources: [resource("ui://my-app/details", ["admin_details"])] }] });
  expect(loads).toBe(0);
  const initialized = await call(api, "initialize", { protocolVersion: "2025-03-26", capabilities, clientInfo: { name: "test", version: "1" } }, "admin");
  expect(initialized.result.capabilities.resources).toBeDefined();
  expect((await call(api, "resources/list", {}, "admin")).result.resources.map((r: any) => r.uri)).toEqual(["ui://mantle-admin/rows", "ui://my-app/details"]);
  const listed = (await call(api, "tools/list", {}, "admin")).result.tools;
  expect(listed[0]._meta.ui.resourceUri).toBe("ui://mantle-admin/rows");
  expect(listed[0]._meta["ui/resourceUri"]).toBe("ui://mantle-admin/rows");
  expect(listed[0]._meta["openai/outputTemplate"]).toBe("ui://mantle-admin/rows");
  expect(listed[1]._meta.ui.resourceUri).toBe("ui://my-app/details");
  expect(loads).toBe(0);
  const read = await call(api, "resources/read", { uri: "ui://mantle-admin/rows" }, "admin");
  expect(read.result.contents[0]).toMatchObject({ uri: "ui://mantle-admin/rows", text: "<h1>Admin</h1>", mimeType: "text/html;profile=mcp-app", _meta: { ui: { prefersBorder: true } } });
  expect(loads).toBe(1);
  expect((await call(api, "resources/list")).result.resources.map((r: any) => r.uri)).toEqual(["ui://my-app/rows"]);
  const result = (await call(api, "tools/call", { name: "public_rows", arguments: {} })).result;
  expect(result.structuredContent).toEqual({ rows: [{ id: "one" }] });
  expect(result._meta).toEqual({ "net.aotter.mantle/tool": "public_rows" });
});

test("request-bound tool tables revalidate changed names and never dispatch the cached endpoint table",async()=>{
 let checks=0,invoked=0;const app:McpApps={get resources(){checks++;return[resource("ui://my-app/rows",["public_rows"])];}};
 const api=mcp<{changed:boolean;value:string},null>((_request,env)=>[{...tools[0]!,name:env.changed?"public_other":"public_rows",page:async()=>{invoked++;return{rows:[{value:env.value}]};}}], {db:()=>null,caller:()=>({kind:"anonymous"}),apps:{public:app}});
 const request=(name:string)=>new Request("https://app.test/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:{},_meta:meta}})});
 const response=await api(request("public_rows"),{changed:false,value:"first"}),body=await response!.text();expect(body).toContain('"value":"first"');expect(invoked).toBe(1);expect(checks).toBe(1);
 const second=await api(request("public_rows"),{changed:false,value:"second"});expect(await second!.text()).toContain('"value":"second"');expect(invoked).toBe(2);expect(checks).toBe(1);
 const rejected=await api(request("public_other"),{changed:true,value:"never"});expect(rejected!.status).toBe(500);expect(await rejected!.json()).toMatchObject({error:{code:"INTERNAL_ERROR"}});expect(checks).toBe(1);/* the catalogue is read once; the changed names are what get revalidated */expect(invoked).toBe(2);
});

test("request-bound tool tables revalidate a same-named View changing into a Procedure", async () => {
  let write = false, invoked = 0;
  const api = mcp<{ write: boolean }, null>((_request, env) => [env.write
    ? { name: "same", surface: "public", description: "write", inputSchema: { type: "object" }, validate: raw => raw as Record<string, unknown>, path: "same", run: async () => { invoked++; return {}; } }
    : { name: "same", surface: "public", description: "read", inputSchema: { type: "object" }, validate: raw => raw as Record<string, unknown>, path: "same", page: async () => ({ rows: [] }) }] as Tool<null>[],
  { db: () => null, caller: () => ({ kind: "anonymous" }), apps: { public: { resources: [{ ...resource("ui://app/same"), appOnly: ["same"] }] } } });
  const request = (method: string) => new Request("https://app.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "tools/call" ? { name: "same", arguments: {}, _meta: meta } : { _meta: meta } }) });
  expect((await api(request("tools/list"), { write }))!.status).toBe(200);
  write = true;
  expect((await api(request("tools/call"), { write }))!.status).toBe(500);
  expect(invoked).toBe(0);
});

test("clients that declare no MCP Apps support see no App resources or App-only tools", async () => {
  const api = handle({ public: { resources: [{ ...resource("ui://my-app/rows", ["public_rows"]), appOnly: ["public_details"] }] } });
  for (const ui of [false]) {
    const init = await call(api, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }, "public", ui);
    expect(init.error).toBeUndefined();
    expect((await call(api, "resources/list", {}, "public", ui)).result?.resources ?? []).toEqual([]);
    const listed = (await call(api, "tools/list", {}, "public", ui)).result.tools;
    expect(listed.map((t: any) => t.name)).toEqual(["public_rows"]);
    expect(listed[0]._meta).toBeUndefined();
    expect((await call(api, "tools/call", { name: "public_details", arguments: {} }, "public", ui)).error).toBeDefined();
  }
  const listed = (await call(api, "tools/list")).result.tools;
  expect(listed[1]._meta.ui).toEqual({ resourceUri: "ui://my-app/rows", visibility: ["app"] });
});

test("a request that advertises no capabilities (unknown) still sees App resources, _meta.ui and App-only tools", async () => {
  const api = handle({ public: { resources: [{ ...resource("ui://my-app/rows", ["public_rows"]), appOnly: ["public_details"] }] } });
  expect((await call(api, "resources/list", {}, "public", null)).result.resources.map((r: any) => r.uri)).toEqual(["ui://my-app/rows"]);
  const listed = (await call(api, "tools/list", {}, "public", null)).result.tools;
  expect(listed.map((t: any) => t.name)).toEqual(["public_rows", "public_details"]);
  expect(listed[0]._meta.ui).toEqual({ resourceUri: "ui://my-app/rows" });
  expect(listed[1]._meta.ui).toEqual({ resourceUri: "ui://my-app/rows", visibility: ["app"] });
  expect((await call(api, "tools/call", { name: "public_details", arguments: {} }, "public", null)).result.structuredContent).toEqual({ rows: [{ id: "one" }] });
});

for (const [name, resources, fragment] of [
  ["URI collision", [resource("ui://app/a"), { ...resource("ui://app/a"), name: "other" }], "URI"],
  ["name collision", [resource("ui://app/a"), { ...resource("ui://app/b"), name: "app/a" }], "name"],
  ["render ownership", [resource("ui://app/a", ["public_rows"]), resource("ui://app/b", ["public_rows"])], "claimed"],
  ["app-only ownership", [{ ...resource("ui://app/a"), appOnly: ["public_rows"] }, resource("ui://app/b", ["public_rows"])], "claimed"],
  ["foreign render tool", [resource("ui://app/a", ["admin_rows"])], "endpoint"],
  ["foreign app-only tool", [{ ...resource("ui://app/a"), appOnly: ["admin_rows"] }], "endpoint"],
  ["unknown tool", [resource("ui://app/a", ["absent"])], "endpoint"],
  ["non-ui URI", [resource("https://app.test/a")], "ui://"],
] as const) test(`App configuration refuses ${name} at construction with ContractError`, () => {
  refused(() => handle({ public: resources.map(r => ({ resources: [r] })) }), fragment);
});

test("App-only is for Views: a Procedure cannot be hidden from the model", async () => {
  const write: Tool<null> = { name: "public_write", surface: "public", description: "write", inputSchema: { type: "object" }, validate: raw => raw as Record<string, unknown>, run: async () => ({}) };
  refused(() => mcp<unknown, null>([...tools, write], { db: () => null, caller: () => ({ kind: "anonymous" }), apps: { public: { resources: [{ ...resource("ui://app/a"), appOnly: ["public_write"] }] } } }), "must be a View");
});

test("a bad configuration is not deferred to a request-bound tool table's first request", () => {
  refused(() => mcp<unknown, null>(() => tools, { db: () => null, caller: () => ({ kind: "anonymous" }), apps: { public: { resources: [resource("https://app.test/a")] } } }), "ui://");
});

test("App bindings are checked once per endpoint and render failures never expose loader secrets", async () => {
  let bindings = 0;
  const api = handle({ public: { get resources() { bindings++; return [{ ...resource("ui://app/a", ["public_rows"]), html: () => { throw new Error("token-secret"); } }]; } } });
  expect(bindings).toBe(1);
  await Promise.all([call(api, "tools/list"), call(api, "tools/list")]);
  expect(bindings).toBe(1);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try { const result = await call(api, "resources/read", { uri: "ui://app/a" }); expect(JSON.stringify(result)).not.toContain("token-secret"); expect(result.error).toBeDefined(); /* the response is redacted; the server log says why */ expect(log.mock.calls.flat().join(" ")).toContain("resource rendering failed: token-secret"); }
  finally { log.mockRestore(); }
});

test("the admin tool table loads only for an admin caller", async () => {
  let loads = 0, role: string | null = "admin", kind: "user" | "anonymous" = "anonymous";
  const api = mcp<unknown, null>(() => { loads++; return tools; }, { db: () => null, caller: () => kind === "anonymous" ? { kind } : fixtureCaller({ kind, subject: "u", role, admin: role === "admin", scopes: ["mcp"], credential: "oauth", credentialId: null, clientId: null }) });
  const list = () => api(new Request("https://app.test/mcp/admin", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), {});
  expect((await list())!.status).toBe(401);
  kind = "user"; role = "reader";
  expect((await list())!.status).toBe(403);
  expect(loads).toBe(0);
  role = "admin";
  expect((await list())!.status).toBe(200);
  expect(loads).toBe(1);
});

test("a resource's domain is passed through as _meta.ui.domain on list and read", async () => {
  const api = handle({ admin: { resources: [{ ...resource("ui://mantle-admin/rows", ["admin_rows"]), domain: "rows.apps.example" }] } });
  expect((await call(api, "resources/list", {}, "admin")).result.resources[0]._meta.ui).toEqual({ domain: "rows.apps.example" });
  expect((await call(api, "resources/read", { uri: "ui://mantle-admin/rows" }, "admin")).result.contents[0]._meta.ui).toEqual({ domain: "rows.apps.example" });
});

test("an HTML loader renders for the tools this caller's tools/list shows, and only those", async () => {
  const rendered: string[][] = [];
  const api = mcp(tools, {
    db: () => null, caller: () => fixtureCaller({ kind: "user", subject: "u", role: "admin", admin: true, scopes: ["mcp"], credential: "oauth", credentialId: null, clientId: null }),
    authorize: target => target.name !== "admin_details",
    apps: { admin: { resources: [{ ...resource("ui://mantle-admin/rows", ["admin_rows"]), html: ({ tools }) => { rendered.push([...tools]); return "<h1>Admin</h1>"; } }] } },
  });
  const listed = (await call(api, "tools/list", {}, "admin")).result.tools.map((tool: any) => tool.name);
  expect(listed).toEqual(["admin_rows"]);
  expect((await call(api, "resources/read", { uri: "ui://mantle-admin/rows" }, "admin")).result.contents[0].text).toBe("<h1>Admin</h1>");
  expect(rendered).toEqual([listed]);
});

test("an MCP page passes limits 1..500 to the View unchanged and refuses above 500", async () => {
  const limits: unknown[] = [];
  const api = mcp([{ ...tools[0]!, page: async (_db, _caller, _input, paging) => { limits.push(paging.limit); return { rows: [], nextCursor: "next" }; } }], { db: () => null, caller: () => ({ kind: "anonymous" }) });
  for (const limit of [20, 100, 101, 500]) expect((await call(api, "tools/call", { name: "public_rows", arguments: { limit } })).result.structuredContent).toEqual({ rows: [], nextCursor: "next" });
  expect(limits).toEqual([20, 100, 101, 500]);
  expect((await call(api, "tools/call", { name: "public_rows", arguments: { limit: 501 } })).result.isError).toBe(true);
  expect(limits).toHaveLength(4);
});

test("a loader may return { html, csp }: the CSP found at read time rides on the resources/read content, and replaces the resource's static one", async () => {
  const csp = { resourceDomains: ["https://cdn.example.test"] };
  const api = handle({ admin: { resources: [{ ...resource("ui://mantle-admin/rows", ["admin_rows"]), csp: { connectDomains: ["https://static.example.test"] }, html: () => ({ html: "<p>x</p>", csp }) }] } });
  const read = (await call(api, "resources/read", { uri: "ui://mantle-admin/rows" }, "admin")).result.contents[0];
  expect(read.text).toBe("<p>x</p>");
  expect(read._meta.ui.csp).toEqual(csp);
});

test("an HTML loader also receives the request's env and request; a zero-argument or tools-only loader still works", async () => {
  const seen: { tools: ReadonlySet<string>; env: unknown; request: Request }[] = [];
  const env = { ASSETS: { fetch: async () => new Response("x") } };
  const admin: McpApps = { resources: [
    { ...resource("ui://mantle-admin/full", ["admin_rows"]), html: render => { seen.push(render); return "<p>full</p>"; } },
    { ...resource("ui://mantle-admin/none", ["admin_details"]), html: () => "<p>none</p>" },
    { ...resource("ui://mantle-admin/tools"), html: ({ tools }) => "<p>" + [...tools].sort().join(",") + "</p>" },
  ] };
  const api = handle({ admin });
  const read = async (uri: string) => {
    const response = await api(new Request("https://app.test/mcp/admin/", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri, _meta: meta } }) }), env);
    const text = await response!.text();
    return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text).result.contents[0].text as string;
  };
  expect(await read("ui://mantle-admin/full")).toBe("<p>full</p>");
  expect(seen).toHaveLength(1);
  expect(seen[0]!.env).toBe(env);
  expect(new URL(seen[0]!.request.url).origin).toBe("https://app.test");
  expect([...seen[0]!.tools].sort()).toEqual(["admin_details", "admin_rows"]);
  expect(await read("ui://mantle-admin/none")).toBe("<p>none</p>");
  expect(await read("ui://mantle-admin/tools")).toBe("<p>admin_details,admin_rows</p>");
});

test("async Admin contributors resolve only after origin, caller and Admin gates", async () => {
  let role: "anonymous" | "member" | "admin" = "anonymous", resolved = 0;
  const env = { build: "one" }, seen: unknown[] = [];
  const api = mcp(tools, {
    db: () => null,
    caller: () => role === "anonymous" ? { kind: "anonymous" } : fixtureCaller({ kind: "user", subject: "u", role, admin: role === "admin", scopes: ["mcp"], credential: "oauth", credentialId: null, clientId: null }),
    apps: { admin: async context => { resolved++; seen.push(context); return { resources: [resource("ui://app/" + (context.env as typeof env).build, ["admin_rows"])] }; } },
  });
  const list = (origin?: string) => {
    const request = new Request("https://app.test/mcp/admin", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(origin ? { origin } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    return api(request, env);
  };
  expect(resolved).toBe(0);
  expect((await list())!.status).toBe(401);
  role = "member"; expect((await list())!.status).toBe(403);
  role = "admin"; expect((await list("https://foreign.test"))!.status).toBe(403);
  expect(resolved).toBe(0);
  expect((await list())!.status).toBe(200);
  expect(resolved).toBe(1);
  expect(seen[0]).toMatchObject({ env });
  expect((seen[0] as { request: Request }).request.url).toBe("https://app.test/mcp/admin");
});

test("mixed static and async contributors retain getter-once semantics and refresh links for the same tool names", async () => {
  let staticReads = 0, resolves = 0;
  const fixed: McpApps = { get resources() { staticReads++; return [resource("ui://app/fixed", ["public_details"])]; } };
  const api = mcp<{ build: string }, null>(tools, { db: () => null, caller: () => ({ kind: "anonymous" }), apps: { public: [fixed, async ({ env }) => {
    resolves++;
    const uri = "ui://app/" + (env as { build: string }).build;
    return { resources: [{ ...resource(uri, ["public_rows"]), html: ({ env }) => "<p>" + (env as { build: string }).build + "</p>" }] };
  }] } });
  expect(staticReads).toBe(1); expect(resolves).toBe(0);
  const request = async (build: string, method: string, params = {}) => {
    const response = await api(new Request("https://app.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), { build });
    const text = await response!.text();
    return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text);
  };
  for (const build of ["first", "second", "first"]) {
    const listed = (await request(build, "tools/list")).result.tools;
    expect(listed.find((tool: any) => tool.name === "public_rows")._meta.ui.resourceUri).toBe("ui://app/" + build);
    expect(listed.find((tool: any) => tool.name === "public_details")._meta.ui.resourceUri).toBe("ui://app/fixed");
    expect((await request(build, "resources/list")).result.resources.map((item: any) => item.uri)).toEqual(["ui://app/fixed", "ui://app/" + build]);
    expect((await request(build, "resources/read", { uri: "ui://app/" + build })).result.contents[0].text).toBe("<p>" + build + "</p>");
  }
  expect(staticReads).toBe(1); expect(resolves).toBe(9);
});

for (const [name, bad] of [
  ["URI", { ...resource("ui://app/static"), name: "private-uri-secret" }],
  ["name", { ...resource("ui://app/private-name-secret"), name: "app/static" }],
  ["renderer", resource("ui://app/private-renderer-secret", ["public_rows"])],
  ["foreign tool", resource("ui://app/private-foreign-secret", ["admin_rows"])],
] as const) test(`request-bound App contributors refuse ${name} conflicts with redacted responses`, async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    let resolves = 0;
    const api = handle({ public: [{ resources: [resource("ui://app/static", ["public_rows"])] }, async () => { resolves++; return { resources: [bad] }; }] });
    expect(resolves).toBe(0);
    const response = await call(api, "tools/list");
    expect(response).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(response)).not.toContain("private-");
    expect(resolves).toBe(1);
  } finally { log.mockRestore(); }
});

test("known static conflicts are eager even beside an unresolved contributor", () => {
  let resolves = 0;
  const dynamic = async () => { resolves++; return { resources: [] }; };
  for (const resources of [
    [resource("ui://app/a"), resource("ui://app/a")],
    [resource("ui://app/a", ["admin_rows"])],
    [resource("ui://app/a", ["public_rows"]), resource("ui://app/b", ["public_rows"])],
  ]) {
    expect(() => handle({ public: [{ resources }, dynamic] })).toThrow(ContractError);
  }
  expect(resolves).toBe(0);
});


test("a failing contributor is redacted and a later request may resolve it again", async () => {
  let attempts = 0;
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const api = handle({ public: async () => {
      if (++attempts === 1) throw new Error("private-loader-secret");
      return { resources: [resource("ui://app/recovered", ["public_rows"])] };
    } });
    const request = () => new Request("https://app.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const failed = await api(request(), {});
    expect(failed!.status).toBe(500);
    const body = await failed!.text();
    expect(body).toContain("INTERNAL_ERROR"); expect(body).not.toContain("private-loader-secret");
    expect((await call(api, "tools/list")).result.tools[0]._meta.ui.resourceUri).toBe("ui://app/recovered");
    expect(attempts).toBe(2);
  } finally { log.mockRestore(); }
});

test("authorize filters identity, scopes, checks and application refusals from lists and loader tools; default discovery remains independent", async () => {
  const open = { ...tools[0]!, name: "open" };
  const table: Tool<null>[] = [open,
    { ...open, name: "closed", closed: true },
    { ...open, name: "scoped", closed: true, scopes: ["private:read"] },
    { ...open, name: "checked", check: () => { throw new ContractError("AUTH_DENIED", "Not allowed."); } },
    { ...open, name: "application_denied" },
  ];
  let authenticated = false;
  const options = {
    db: () => null,
    caller: () => authenticated ? fixtureCaller({ kind: "user", subject: "u", role: "user", admin: false, scopes: ["mcp"], credential: "oauth", credentialId: null, clientId: null }) : { kind: "anonymous" as const },
    apps: { public: async () => ({ resources: [{ ...resource("ui://app/filtered", ["open"]), html: ({ tools }: { tools: ReadonlySet<string> }) => JSON.stringify([...tools]) }] }) },
  };
  const filtered = mcp(table, { ...options, authorize: target => target.name !== "application_denied" });
  for (const expected of [["open"], ["open", "closed"]]) {
    expect((await call(filtered, "tools/list")).result.tools.map((tool: any) => tool.name)).toEqual(expected);
    expect(JSON.parse((await call(filtered, "resources/read", { uri: "ui://app/filtered" })).result.contents[0].text)).toEqual(expected);
    authenticated = true;
  }
  const independent = mcp(table, options);
  const names = table.map(tool => tool.name);
  expect((await call(independent, "tools/list")).result.tools.map((tool: any) => tool.name)).toEqual(names);
  expect(JSON.parse((await call(independent, "resources/read", { uri: "ui://app/filtered" })).result.contents[0].text)).toEqual(names);
  const denied = await call(filtered, "tools/call", { name: "scoped", arguments: {} });
  expect(denied.error.code).toBe("AUTH_DENIED");
});
