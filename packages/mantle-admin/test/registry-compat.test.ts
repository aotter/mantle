import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bothItems, pkg, sampleKey, source } from "./registry-items";

// MCP App compatibility of every `both` registry item: each is used as an override under a sample slot key, built into the App by
// `buildAdmin`, shown by a page too (with the props its slot gets), and run through `checkMcpApp` in the host's AppBridge.
// Real Chrome: `pnpm test:browser` (MANTLE_BROWSER_TESTS=1), MANTLE_TEST_CHROMIUM where Chrome is not on the default path.
const temp = mkdtempSync(join(tmpdir(), "mantle-registry-compat-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const { buildAdmin } = await import(resolve(pkg, "dist/build/index.js")) as typeof import("../src/build/index.js");
const { checkMcpApp } = await import(resolve(pkg, "dist/testing/index.js")) as typeof import("../src/testing/index.js");

const catalogue = {
  views: {
    "pending_requests": { columns: { title: { type: "string" }, amount: { type: "integer" }, link: { type: "string", format: "uri" } }, list: { columns: ["title", "amount", "link"] }, actions: [] },
    "queue_page": { columns: {}, list: { columns: [] }, actions: [] },
  },
  actions: {},
};
const entry = '{ id: "e1", collection: "requests", locale: null, status: "draft", version: 1, data: { title: "Sample", amount: 5, link: "https://example.com/e1" }, updated_at: 0 }';
/** The props a slot of this family gets, as a page can give them. */
const props = (slot: string): string =>
  slot.startsWith("input:") ? '{ value: "Sample", onChange: () => undefined, readOnly: false, property: { type: "string" }, surface: "mcp-app" }'
    : slot.startsWith("record.") ? `{ collection: "requests", entry: ${entry}, surface: "mcp-app" }`
    : '{ value: "https://example.com/sample", row: {}, property: { type: "string" }, surface: "mcp-app" }';

describe("MCP App compatibility of the registry's `both` items", () => {
  for (const item of bothItems) it(`${item.name} renders in the Admin MCP App under AppBridge (${item.meta.slots.join(", ")})`, async () => {
    const dir = join(temp, item.name, "src");
    mkdirSync(dir, { recursive: true });
    const file = item.files[0]!;
    const text = source(file).replace(/"@aotter\/mantle-admin\/app"/g, JSON.stringify(resolve(pkg, "dist/admin-app/index.js"))).replace(/"@aotter\/mantle-admin\/hooks"/g, JSON.stringify(resolve(pkg, "dist/admin-app/hooks.js")));
    writeFileSync(join(dir, "item.tsx"), text);
    const component = /export function (\w+)/.exec(text)![1]!;
    // a View-column slot is rendered by the App's rows; the other slots only by the page, which hands the item its props
    const slot = item.meta.slots.find(each => each.startsWith("cell:view:")) ?? item.meta.slots[0]!;
    writeFileSync(join(dir, "admin.tsx"), [
      `import { defineAdmin } from ${JSON.stringify(resolve(pkg, "dist/admin-app/index.js"))};`,
      `import { ${component} as Item } from "./item";`,
      `const Page = () => <Item {...(${props(slot)} as never)} renderDefault={() => null} />;`,
      `export default defineAdmin({}, { components: { ${JSON.stringify(sampleKey(slot))}: Item as never }, pages: [{ path: "sample", title: "Sample", element: <Page />, mcp: { renders: "queue-page" } }] });`,
    ].join("\n"));
    const out = join(temp, item.name, "dist/client/admin");
    await buildAdmin({ entry: join(dir, "admin.tsx"), outDir: out });
    await expect(checkMcpApp({ catalogue, html: join(out, "mcp-app.html") })).resolves.toBeUndefined();
  }, 240_000);

  it("covers every `both` item of the registry", () => {
    expect(bothItems.length).toBeGreaterThan(0);
  });
});
