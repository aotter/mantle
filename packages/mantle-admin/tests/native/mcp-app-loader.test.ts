import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { adminMcpApps } = await import("../../src/server/mcp.ts");

const catalogue = { views: { pending: { actions: [] } }, actions: {} };
const request = new Request("https://svc.test/mcp/admin/", { method: "POST" });
const resolve = async (source: ReturnType<typeof adminMcpApps>, env: unknown) => typeof source === "function" ? source({ env, request }) : source;
const page = async (options: object, env: unknown): Promise<{ html: string; csp?: unknown }> => {
  const resource = (await resolve(adminMcpApps({ catalogue, ...options }), env)).resources[0]!;
  return (resource.html as (render: object) => Promise<{ html: string; csp?: unknown }>)({ tools: new Set(["pending"]), env, request });
};
const load = async (options: object, env: unknown): Promise<string> => (await page(options, env)).html;
const embedded = (html: string) => JSON.parse(/<script type="application\/json" id="mantle-catalog">(.*?)<\/script>/.exec(html)![1]!);

test("on a Worker the default loader reads /admin/mcp-app.html through env.ASSETS.fetch, and embeds this caller's catalogue", async () => {
  const asked: string[] = [];
  const env = { ASSETS: { fetch: async (asked_: Request) => { asked.push(asked_.url); return new Response("<html><head></head><body>app</body></html>"); } } };
  const html = await load({}, env);
  expect(asked).toEqual(["https://svc.test/admin/mcp-app.html"]);
  expect(html).toContain("<body>app</body>");
  expect(embedded(html)).toEqual({ views: { pending: { actions: [] } }, actions: {} });
});

test("the CSP the build wrote into the file is sent with the HTML, and a file without one sends none", async () => {
  const csp = { resourceDomains: ["https://cdn.example.test"], connectDomains: ["https://api.example.test"] };
  const meta = "<meta name=\"mantle-mcp-csp\" content='" + JSON.stringify(csp).replace(/[<'&]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + "'>";
  const env = (body: string) => ({ ASSETS: { fetch: async () => new Response(body) } });
  expect((await page({}, env("<head>" + meta + "</head>"))).csp).toEqual(csp);
  expect((await page({}, env("<head></head>"))).csp).toBeUndefined();
});

test("the default loader follows the one same-origin redirect the default html_handling answers a .html path with", async () => {
  const asked: string[] = [];
  const env = { ASSETS: { fetch: async (asked_: Request) => {
    asked.push(asked_.url);
    return asked_.url.endsWith(".html") ? new Response(null, { status: 307, headers: { location: "/admin/mcp-app" } }) : new Response("<head></head><p>redirected</p>");
  } } };
  expect(await load({}, env)).toContain("<p>redirected</p>");
  expect(asked).toEqual(["https://svc.test/admin/mcp-app.html", "https://svc.test/admin/mcp-app"]);
  // a redirect to another origin is not followed
  const away = { ASSETS: { fetch: async () => new Response(null, { status: 307, headers: { location: "https://elsewhere.test/x" } }) } };
  await expect(load({}, away)).rejects.toThrow("answered 307");
});

test("a missing built App is a loader failure the MCP handler redacts, not an empty page", async () => {
  const env = { ASSETS: { fetch: async () => new Response("missing", { status: 404 }) } };
  await expect(load({}, env)).rejects.toThrow("run `mantle bundle`");
});

test("on Bun the default loader reads dist/client/admin/mcp-app.html, or the file option", async () => {
  const root = mkdtempSync(join(tmpdir(), "mantle-mcp-app-loader-")), here = process.cwd();
  try {
    mkdirSync(join(root, "dist/client/admin"), { recursive: true });
    writeFileSync(join(root, "dist/client/admin/mcp-app.html"), "<head></head><p>default path</p>");
    writeFileSync(join(root, "elsewhere.html"), "<head></head><p>option</p>");
    process.chdir(root);
    expect(await load({}, {})).toContain("<p>default path</p>");
    expect(await load({ file: join(root, "elsewhere.html") }, undefined)).toContain("<p>option</p>");
  } finally { process.chdir(here); rmSync(root, { recursive: true, force: true }); }
});

test("html still overrides the default: a string, a zero-argument loader or one that reads the render", async () => {
  expect(await load({ html: "<head></head><p>string</p>" }, {})).toContain("<p>string</p>");
  const uri = "ui://mantle-admin/custom/build-1";
  expect(await load({ uri, html: () => "<head></head><p>none</p>" }, {})).toContain("<p>none</p>");
  expect(await load({ uri, html: ({ tools }: { tools: ReadonlySet<string> }) => `<head></head><p>${[...tools]}</p>` }, {})).toContain("<p>pending</p>");
  // a caller-dependent loader has no build identity to hash: the fixed URI only
  expect((adminMcpApps({ catalogue, html: () => "<head></head>" }) as { resources: { uri: string }[] }).resources.map(r => r.uri)).toEqual(["ui://mantle-admin/admin"]);
});

test("duplicate retained resource URIs fail when the contributor is constructed", () => {
  const snapshot = { uri: "ui://mantle-admin/admin/old", html: '<head><script type="application/json" id="mantle-catalog">{"views":{},"actions":{}}</script></head>' };
  expect(() => adminMcpApps({ catalogue, html: "<head></head>new", previous: [snapshot, snapshot] })).toThrow("registered twice");
});

test("the default URI is fixed across builds; the current build also answers at its content-hash URI (#1934)", async () => {
  const env = (body: string) => ({ ASSETS: { fetch: async () => new Response(`<head></head><p>${body}</p>`) } });
  const one = (await resolve(adminMcpApps({ catalogue }), env("build-one"))).resources;
  const two = (await resolve(adminMcpApps({ catalogue }), env("build-two"))).resources;
  // tools link the fixed URI whatever the build; only it claims the renderer
  for (const resources of [one, two]) {
    expect(resources[0]).toMatchObject({ uri: "ui://mantle-admin/admin", renders: ["pending"] });
    expect(resources[1]!.uri).toMatch(/^ui:\/\/mantle-admin\/admin\/[a-f0-9]{64}$/);
    expect(resources[1]).not.toHaveProperty("renders");
  }
  expect(one[1]!.uri).not.toBe(two[1]!.uri);
  // the hash alias is the same page as the fixed URI, with the caller's catalogue embedded per read
  const read = (resource: (typeof one)[number]) => (resource.html as (render: object) => Promise<{ html: string }>)({ env: env("build-one"), request, tools: new Set(["pending"]) });
  expect((await read(one[1]!)).html).toBe((await read(one[0]!)).html);
  // a retained snapshot keeps its own URI beside both; one with the current URI is not served twice
  const snapshot = { uri: "ui://mantle-admin/admin/" + "0".repeat(64), html: '<head><script type="application/json" id="mantle-catalog">{"views":{},"actions":{}}</script></head>' };
  const kept = (await resolve(adminMcpApps({ catalogue, previous: [snapshot, { ...snapshot, uri: "ui://mantle-admin/admin" }] }), env("build-one"))).resources;
  expect(kept.map(r => r.uri)).toEqual(["ui://mantle-admin/admin", one[1]!.uri, snapshot.uri]);
});

test("the build's hash URI versions raw build bytes, static catalogue and material resource metadata", async () => {
  const source = adminMcpApps({ catalogue });
  let reads = 0;
  const env = { ASSETS: { fetch: async () => { reads++; return new Response("<head></head><p>build-one</p>"); } } };
  const [first, again] = await Promise.all([resolve(source, env), resolve(source, env)]);
  const uri = first.resources[1]!.uri;
  expect(uri).toMatch(/^ui:\/\/mantle-admin\/admin\/[a-f0-9]{64}$/);
  expect(again.resources[1]!.uri).toBe(uri);
  expect(reads).toBe(1);
  const changedEnv = { ASSETS: { fetch: async () => new Response("<head></head><p>build-two</p>") } };
  expect((await resolve(source, changedEnv)).resources[1]!.uri).not.toBe(uri);
  const changedCatalogue = { views: { pending: { columns: { amount: { type: "integer" } }, actions: [] } }, actions: {} };
  expect((await resolve(adminMcpApps({ catalogue: changedCatalogue }), env)).resources[1]!.uri).not.toBe(uri);
  expect((await resolve(adminMcpApps({ catalogue, domain: "https://app.example.test" }), env)).resources[1]!.uri).not.toBe(uri);
  expect((await resolve(adminMcpApps({ catalogue, title: "Other title" }), env)).resources[1]!.uri).not.toBe(uri);
  expect((await resolve(adminMcpApps({ catalogue, renders: [] }), env)).resources[1]!.uri).not.toBe(uri);
});

test("only raw assets are cached: each read embeds the current caller's tools, and failed loads retry", async () => {
  const all = { views: { pending: { actions: ["approve"] }, other: { actions: [] } }, actions: { approve: {} } };
  let reads = 0;
  const env = { ASSETS: { fetch: async () => { reads++; return new Response("<head></head>", { status: reads === 1 ? 404 : 200 }); } } };
  const source = adminMcpApps({ catalogue: all });
  await expect(resolve(source, env)).rejects.toThrow("run `mantle bundle`");
  const apps = await resolve(source, env);
  const html = apps.resources[0]!.html as (render: object) => Promise<{ html: string }>;
  const a = embedded((await html({ env, request, tools: new Set(["pending"]) })).html);
  const b = embedded((await html({ env, request, tools: new Set(["other", "approve"]) })).html);
  expect(a).toEqual({ views: { pending: { actions: [] } }, actions: {} });
  expect(b).toEqual({ views: { other: { actions: [] } }, actions: { approve: {} } });
  expect(reads).toBe(2);
});

test("a Bun build changed in the same process gets a new revision URI behind the fixed one; explicit renderer partitions are checked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mantle-mcp-build-identity-"));
  try {
    const file = join(dir, "mcp-app.html"), source = adminMcpApps({ catalogue, file });
    writeFileSync(file, "<head></head><p>one</p>");
    const first = (await resolve(source, {})).resources;
    writeFileSync(file, "<head></head><p>two</p>");
    const second = (await resolve(source, {})).resources;
    expect([first[0]!.uri, second[0]!.uri]).toEqual(["ui://mantle-admin/admin", "ui://mantle-admin/admin"]);
    expect(second[1]!.uri).not.toBe(first[1]!.uri);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  expect(() => adminMcpApps({ catalogue, renders: ["unknown"] })).toThrow("unknown View");
  // `tools` adds Procedures and the application's own tools beside the catalogue's Views, which `renders` still names
  const withTools = adminMcpApps({ catalogue, uri: "ui://mantle-admin/explicit/build-3", html: "<head></head>", tools: ["approve_request", "pending"] });
  expect(withTools.resources[0]!.renders).toEqual(["pending", "approve_request"]);
  expect(adminMcpApps({ catalogue, uri: "ui://mantle-admin/explicit/build-3", html: "<head></head>", renders: [], tools: ["approve_request"] }).resources[0]!.renders).toEqual(["approve_request"]);
  expect(() => adminMcpApps({ catalogue, renders: ["approve_request"] })).toThrow("Name a Procedure or your own tool in `tools`");
  const custom = adminMcpApps({ catalogue, uri: "ui://mantle-admin/explicit/build-2", html: "<head></head>", renders: [] });
  expect(custom.resources[0]!.renders).toEqual([]);
  expect(custom.resources[0]!.uri).toBe("ui://mantle-admin/explicit/build-2");
});
