import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    pending: { columns: { item: { type: "string" }, amount: { type: "integer" }, link: { type: "string", format: "uri" }, when: { type: "string", format: "date-time" } }, list: { columns: ["item", "amount", "link", "when"] }, actions: [] },
    queue: { columns: {}, list: { columns: [] }, actions: [] },
  },
  actions: {},
};

/** An application whose `cell:view:pending.item` override is the body of `Cell`, beside a page for the `queue` View; returns the built file. */
async function build(name: string, cell: string, imports = ""): Promise<string> {
  const src = join(temp, name, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "admin.tsx"), [
    `import { defineAdmin } from ${JSON.stringify(resolve(pkg, "dist/admin-app/index.js"))};`,
    `import { useView } from ${JSON.stringify(resolve(pkg, "dist/admin-app/hooks.js"))};`,
    'import { useEffect } from "react";', imports,
    `function Cell({ value }: { value: unknown }) { ${cell} return <b>{String(value)}</b>; }`,
    'function Queue() { const { rows } = useView("queue", {}); return <ul>{rows.map(row => <li key={String(row["id"])}>{String(row["id"])}</li>)}</ul>; }',
    'export default defineAdmin({}, { components: { "cell:view:pending.item": Cell }, pages: [{ path: "queue", title: "Queue", element: <Queue />, mcp: { renders: "queue" } }] });',
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
