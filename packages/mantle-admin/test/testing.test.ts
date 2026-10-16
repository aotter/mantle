import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Real Chrome: `pnpm test:browser` (MANTLE_BROWSER_TESTS=1), with MANTLE_TEST_CHROMIUM set where Chrome is not on the default path.
const pkg = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "mantle-compat-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const { buildAdmin } = await import(resolve(pkg, "dist/build/index.js")) as typeof import("../src/build/index.js");
const { checkMcpApp } = await import(resolve(pkg, "dist/testing/index.js")) as typeof import("../src/testing/index.js");

const catalogue = {
  views: {
    pending: { columns: { item: { type: ["string", "null"] }, amount: { type: "integer" }, link: { type: "string", format: "uri" }, when: { type: "string", format: "date-time" } }, list: { columns: ["item", "amount", "link", "when"] }, actions: [] },
    queue: { columns: {}, list: { columns: [] }, actions: [] },
  },
  actions: {},
};

/** An application whose `cell:view:pending.item` override is the body of `Cell`, beside a page for the `queue` View; returns the built file. */
async function build(name: string, cell: string, options = ""): Promise<string> {
  const src = join(temp, name, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "admin.tsx"), [
    `import { defineAdmin } from ${JSON.stringify(resolve(pkg, "dist/admin-app/index.js"))};`,
    `import { useView } from ${JSON.stringify(resolve(pkg, "dist/admin-app/hooks.js"))};`,
    'import { useEffect } from "react";',
    `function Cell({ value }: { value: unknown }) { ${cell} return <b>{String(value)}</b>; }`,
    'function Queue() { const { rows } = useView("queue", {}); return <ul>{rows.map(row => <li key={String(row["id"])}>{String(row["id"])}</li>)}</ul>; }',
    'export default defineAdmin({}, { components: { "cell:view:pending.item": Cell }, pages: [{ path: "queue", title: "Queue", element: <Queue />, mcp: { renders: "queue" } }]' + options + ' });',
  ].join("\n"));
  const out = join(temp, name, "dist/client/admin");
  await buildAdmin({ entry: join(src, "admin.tsx"), outDir: out });
  return join(out, "mcp-app.html");
}
const attempt = (html: string) => checkMcpApp({ catalogue, html }).then(() => undefined, (error: Error) => error.message);

describe("@aotter/mantle-admin/testing: checkMcpApp", () => {
  it("passes an App whose override and page are compatible, in a light and a dark host", async () => {
    expect(await attempt(await build("ok", ""))).toBeUndefined();
  }, 180_000);

  it("fails an override that makes a network request at render, which the build cannot see, naming the URL", async () => {
    // the origin is put together at run time
    const html = await build("network", 'useEffect(() => { const host = ["example", "org"].join("."); void fetch("https://" + host + "/runtime.json").catch(() => undefined); new Image().src = "https://" + host + "/runtime.png"; }, []);');
    const message = await attempt(html);
    // the default CSP refuses it (a console error naming the URL) before it can leave
    expect(message).toContain("https://example.org/runtime");
    expect(message).toContain("cell:view:pending.item");
  }, 180_000);

  it("fails an override that logs a console error", async () => {
    expect(await attempt(await build("console", 'useEffect(() => { console.error("cell-console-failure"); }, []);'))).toContain("console error: cell-console-failure");
  }, 180_000);

  it("fails an override that throws", async () => {
    expect(await attempt(await build("throws", 'useEffect(() => { throw new Error("cell-throw-failure"); }, []);'))).toContain("cell-throw-failure");
  }, 180_000);

  it("gives a nullable column a null row", async () => {
    expect(await attempt(await build("null-row", 'useEffect(() => { if (value === null) console.error("cell-saw-null"); }, [value]);'))).toContain("console error: cell-saw-null");
  }, 180_000);

  it("serves the App from another origin than the host page: it cannot reach its parent", async () => {
    expect(await attempt(await build("origin", 'useEffect(() => { try { void window.parent.document.title; console.error("parent-reachable"); } catch { /* a cross-origin frame */ } }, []);'))).toBeUndefined();
  }, 180_000);

  it("answers a wildcard origin the App declared for what it loads, and refuses the others", async () => {
    const cell = 'useEffect(() => { const i = new Image(); i.src = "https://" + ["a", "cdn", "example", "test"].join(".") + "/x.png"; const j = new Image(); j.src = "https://" + ["other", "example", "test"].join(".") + "/y.png"; }, []);';
    const message = await attempt(await build("wildcard", cell, ', mcp: { csp: { resourceDomains: ["https://*.cdn.example.test"] } }'));
    expect(message).toContain("https://other.example.test/y.png");
    expect(message).not.toContain("a.cdn.example.test/x.png");
  }, 180_000);

  it("fails an App that never renders the View, saying so", async () => {
    const blank = join(temp, "blank.html");
    writeFileSync(blank, "<!doctype html><html><head></head><body><div id=root></div></body></html>");
    expect(await attempt(blank)).toContain("the App did not render the View");
  }, 180_000);

  it("runs every View of the catalogue when the file records no manifest", async () => {
    const plain = join(temp, "plain.html");
    // an App that renders but whose file has no manifest: the catalogue's two Views are each run
    const html = readFileSync(await build("manifest", 'useEffect(() => { console.error("cell-ran"); }, []);'), "utf8").replace(/<meta name="mantle-mcp-app"[^>]*>/, "");
    writeFileSync(plain, html);
    const message = await attempt(plain);
    expect(message).toContain("View pending");
  }, 180_000);

  it("finds the host script from a path with a space in it", async () => {
    const copy = join(temp, "with space", "dist");
    mkdirSync(copy, { recursive: true });
    for (const dir of ["testing", "build", "app"]) cpSync(resolve(pkg, "dist", dir), join(copy, dir), { recursive: true });
    const { checkMcpApp: spaced } = await import(pathToFileURL(join(copy, "testing/index.js")).href) as typeof import("../src/testing/index.js");
    await expect(spaced({ catalogue, html: await build("space", "") })).resolves.toBeUndefined();
  }, 180_000);

  it("fails, not skips, when no browser is found, and says how to get one", async () => {
    const html = await build("nobrowser", "");
    const before = process.env["MANTLE_TEST_CHROMIUM"];
    process.env["MANTLE_TEST_CHROMIUM"] = join(temp, "no-such-chrome");
    try {
      const message = await attempt(html);
      expect(message).toContain("found no browser");
      expect(message).toContain("npx playwright-core install chromium");
      expect(message).toContain("MANTLE_TEST_CHROMIUM");
    } finally { if (before === undefined) delete process.env["MANTLE_TEST_CHROMIUM"]; else process.env["MANTLE_TEST_CHROMIUM"] = before; }
  }, 180_000);
});
