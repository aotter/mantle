import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { adminMcpApps } = await import("../../src/server/mcp.ts");

const catalogue = { views: { pending: { actions: [] } }, actions: {} };
const request = new Request("https://svc.test/mcp/admin/", { method: "POST" });
const load = (options: object, env: unknown): Promise<string> => (adminMcpApps({ catalogue, ...options }).resources[0]!.html as (render: object) => Promise<string>)({ tools: new Set(["pending"]), env, request });
const embedded = (html: string) => JSON.parse(/<script type="application\/json" id="mantle-catalog">(.*?)<\/script>/.exec(html)![1]!);

test("on a Worker the default loader reads /admin/mcp-app.html through env.ASSETS.fetch, and embeds this caller's catalogue", async () => {
  const asked: string[] = [];
  const env = { ASSETS: { fetch: async (asked_: Request) => { asked.push(asked_.url); return new Response("<html><head></head><body>app</body></html>"); } } };
  const html = await load({}, env);
  expect(asked).toEqual(["https://svc.test/admin/mcp-app.html"]);
  expect(html).toContain("<body>app</body>");
  expect(embedded(html)).toEqual({ views: { pending: { actions: [] } }, actions: {} });
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
  expect(await load({ html: () => "<head></head><p>none</p>" }, {})).toContain("<p>none</p>");
  expect(await load({ html: ({ tools }: { tools: ReadonlySet<string> }) => `<head></head><p>${[...tools]}</p>` }, {})).toContain("<p>pending</p>");
});
