import { expect, it } from "vitest";
import { chromium } from "playwright";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";

// The same entry/CSS as mcp-app-browser.test.ts, mounted by the real public MantleAdmin root.
// API fixtures test UI composition, not server authorization (covered by Core acceptance).
it("the app's both cell, CSS and useView page work in browser Admin as in the MCP host", async () => {
  const root = await mkdtemp(join(tmpdir(), "mantle-custom-admin-"));
  const { buildAdmin } = await import("../dist/build/index.js");
  const dist = join(root, "admin");
  await buildAdmin({ entry: resolve(import.meta.dirname, "fixtures/admin.tsx"), outDir: dist });
  const requests: string[] = [];
  const views = ["pending", "queue"].map(name => ({ name, title: null, description: null, input: null, list: { columns: ["item"], searchFields: [], filterFields: [] }, columns: { item: { type: "string" } } }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname.startsWith("/admin/api/")) {
      requests.push(url.pathname + url.search);
      const fixed: Record<string, unknown> = {
        "/admin/api/me": { role: "admin", admin: true, developer: true, login: "fixture", image: null },
        "/admin/api/site": { brand: "Fixture", icons: [], locales: ["en"], canonicalLocale: "en" },
        "/admin/api/collections": { collections: [], allCollections: {} },
        "/admin/api/operations": { operations: [] }, "/admin/api/views-manifest": { views },
        "/admin/api/webmcp": { tools: [], routes: {} },
        "/admin/api/views/pending": { rows: [{ id: "p1", item: "Laptops" }] },
      };
      const data = url.pathname === "/admin/api/views/queue" ? url.searchParams.has("cursor") ? { rows: [{ id: "q2", item: "second" }] } : { rows: [{ id: "q1", item: "first" }], nextCursor: "q2" } : fixed[url.pathname] ?? {};
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(data)); return;
    }
    try {
      const path = url.pathname.slice("/admin/".length);
      if (/^[\w/-]+\.(?:js|css|svg)$/.test(path)) {
        response.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "image/svg+xml");
        response.end(await readFile(resolve(dist, path))); return;
      }
      response.setHeader("content-type", "text/html"); response.end(await readFile(join(dist, "index.html")));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const page = await browser.newPage(); page.setDefaultTimeout(15_000);
    await page.addInitScript(() => localStorage.setItem("cms.preference.language", "en"));
    await page.goto(origin + "/admin/views/pending");
    const cell = page.locator("mark"); await cell.waitFor();
    expect(await cell.getAttribute("data-surface")).toBe("browser");
    expect(await cell.innerText()).toBe("Laptops");
    expect(await cell.evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgb(254, 220, 186)");
    await page.goto(origin + "/admin/p/queue");
    await page.getByText("page:first").waitFor();
    expect(await page.locator("h1").allTextContents()).toEqual(["Queue"]);
    expect(await page.getByText("Work queue").count()).toBe(1);
    expect(await page.getByRole("link", { name: "Queue help" }).getAttribute("href")).toBe("https://example.test/help");
    expect(await page.getByRole("heading", { name: "queue-page" }).locator("..").evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgb(192, 255, 238)");
    await page.getByRole("button", { name: "More queue" }).click();
    await page.getByText("page:second").waitFor();
    expect(await page.getByText("page:first").count()).toBe(1);
    expect(requests.filter(path => path.startsWith("/admin/api/views/queue")).map(path => new URL(path, origin).searchParams.get("cursor"))).toEqual([null, "q2"]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 120_000);

it("recovers a failed lazy editor chunk only on explicit reload and rechecks authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "mantle-admin-recovery-"));
  const { buildAdmin } = await import("../dist/build/index.js");
  const dist = join(root, "admin"), entry = join(root, "entry.tsx");
  await writeFile(entry, `import { defineAdmin, AdminLink } from ${JSON.stringify(resolve(import.meta.dirname, "../dist/admin-app/index.js"))};\nexport default defineAdmin({}, { pages: [{ path: "start", title: "Start", element: <AdminLink href="/admin/c/requests/r1">Open record</AdminLink> }] });\n`);
  await buildAdmin({ entry, outDir: dist });
  const collection = { name: "requests", title: "Requests", description: null, lifecycle: "publishing", localized: false, hasTranslations: false, exportFields: ["title"], translates: null, uiSchema: {}, list: { primaryField: "title", columns: [] }, schema: { type: "object", properties: { title: { type: "string", title: "Title" } }, required: ["title"] } };
  let missingChunk = true, signedIn = true, htmlLoads = 0, entryReads = 0;
  const failedChunks: string[] = [], writes: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (request.method !== "GET") writes.push(request.method + " " + url.pathname);
    if (url.pathname === "/admin/api/me") {
      response.writeHead(signedIn ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(signedIn ? { role: "admin", admin: true, login: "fixture", image: null } : { error: { code: "UNAUTHENTICATED", message: "Sign in" } })); return;
    }
    if (url.pathname.startsWith("/admin/api/") || url.pathname === "/api/auth/methods") {
      const fixed: Record<string, unknown> = {
        "/admin/api/site": { brand: "Fixture", icons: [], locales: ["en"], canonicalLocale: "en" },
        "/admin/api/collections": { collections: [collection], allCollections: { requests: collection } },
        "/admin/api/operations": { operations: [] }, "/admin/api/views-manifest": { views: [] },
        "/admin/api/webmcp": { tools: [], routes: {} }, "/api/auth/methods": { methods: [{ kind: "email-otp" }] },
        "/admin/api/entries/r1": { collection, entry: { id: "r1", collection: "requests", locale: null, status: "draft", version: 1, data: { title: "Recovered record" }, updated_at: 0 }, related: [], parentEntryId: null },
      };
      if (url.pathname === "/admin/api/entries/r1") entryReads++;
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(fixed[url.pathname] ?? {})); return;
    }
    try {
      const path = url.pathname.slice("/admin/".length);
      if (/^[\w/-]+\.(?:js|css|svg)$/.test(path)) {
        if (missingChunk && /entry-edit-view-[^/]+\.js$/.test(path)) {
          failedChunks.push(path); response.writeHead(404, { "content-type": "text/plain" }); response.end("Not found"); return;
        }
        response.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "image/svg+xml");
        response.end(await readFile(resolve(dist, path))); return;
      }
      htmlLoads++; response.setHeader("content-type", "text/html"); response.setHeader("cache-control", "no-store");
      response.end(await readFile(join(dist, "index.html")));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const page = await browser.newPage(); page.setDefaultTimeout(15_000);
    await page.addInitScript(() => localStorage.setItem("cms.preference.language", "zh-TW"));
    await page.goto(origin + "/admin/p/start");
    await page.getByRole("link", { name: "Open record" }).click();
    const failure = page.getByRole("alert");
    await failure.getByRole("button", { name: "重新載入頁面", exact: true }).waitFor();
    expect(await failure.innerText()).toContain("尚未儲存的變更可能會遺失");
    expect(await failure.innerText()).not.toContain("entry-edit-view-");
    await page.waitForTimeout(250);
    expect(failedChunks).toHaveLength(1); expect(htmlLoads).toBe(1); expect(entryReads).toBe(0); expect(writes).toEqual([]);
    missingChunk = false;
    await failure.getByRole("button", { name: "重新載入頁面", exact: true }).click();
    const title = page.getByRole("textbox", { name: "Title", exact: true });
    await title.waitFor();
    expect(await title.inputValue()).toBe("Recovered record");
    expect(htmlLoads).toBe(2); expect(await page.getByRole("alert").count()).toBe(0);
    const reads = entryReads;
    signedIn = false; await page.reload();
    await page.getByRole("heading", { name: "登入", exact: true }).waitFor();
    expect(await page.getByRole("textbox", { name: "Title", exact: true }).count()).toBe(0);
    expect(entryReads).toBe(reads); expect(writes).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 120_000);

it("custom inputs report invalid local drafts, preserve them across locks and clear status on reload/unmount", async () => {
  const root = await mkdtemp(join(tmpdir(), "mantle-input-status-"));
  const { buildAdmin } = await import("../dist/build/index.js");
  const dist = join(root, "admin"), entryFile = join(root, "entry.tsx");
  await writeFile(entryFile, `
import * as React from "react";
import { defineAdmin } from ${JSON.stringify(resolve(import.meta.dirname, "../dist/admin-app/index.js"))};
import { useOperation } from ${JSON.stringify(resolve(import.meta.dirname, "../dist/admin-app/hooks.js"))};
function JsonInput({value, onChange, readOnly, onStatusChange, error, errorId}) {
  const [text, setText] = React.useState(JSON.stringify(value));
  React.useLayoutEffect(() => {
    window.lastStatusCallback = onStatusChange;
    if (new URLSearchParams(window.location.search).has("initial-invalid")) onStatusChange?.({error: "Initial invalid JSON", dirty: true});
    return () => onStatusChange?.();
  }, [onStatusChange]);
  return <textarea aria-label="Custom JSON" readOnly={readOnly} aria-invalid={Boolean(error)} aria-describedby={errorId} value={text} onChange={event => {
    const next = event.target.value; setText(next);
    try { const parsed = JSON.parse(next); onChange(parsed); onStatusChange?.({}); }
    catch { onStatusChange?.({error: "Enter valid JSON", dirty: true}); }
  }}/>;
}
function Actions() { const refresh = useOperation("refresh"); return <button onClick={() => refresh.run?.({})}>Refresh record</button>; }
export default defineAdmin({}, { components: { "input:notes.metadata": props => <JsonInput {...props}/>, "record.actions:notes": Actions } });
`);
  await buildAdmin({ entry: entryFile, outDir: dist });
  let version = 1, locked = false, hideMetadata = false;
  let data = { title: "Original", metadata: { items: [{ label: "A" }] } };
  const patches: unknown[] = [];
  const collection = () => ({ name: "notes", title: "Notes", description: null, lifecycle: "publishing", localized: false, hasTranslations: false, exportFields: ["title"], translates: null, uiSchema: {}, list: { primaryField: "title", columns: [] }, schema: { type: "object", properties: { title: { type: "string", title: "Title" }, ...(!hideMetadata ? { metadata: { type: "object", title: "Metadata", properties: { items: { type: "array", items: { type: "object", properties: { label: { type: "string" } } } } } } } : {}) }, required: ["title"] } });
  const document = (id = "r1") => ({ collection: collection(), entry: { id, collection: "notes", locale: null, status: "draft", version, data, updated_at: 0, locks: { update: locked ? { lock: "test", message: "Frozen" } : false, delete: false } }, related: [], parentEntryId: null });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname.startsWith("/admin/api/") || url.pathname === "/api/auth/methods") {
      response.setHeader("content-type", "application/json");
      if (request.method === "PATCH") {
        let raw = ""; for await (const chunk of request) raw += chunk;
        const patch = JSON.parse(raw); patches.push(patch);
        if (!Array.isArray(patch.data.metadata?.items)) {
          response.statusCode = 400; response.end(JSON.stringify({ error: { code: "INPUT_VALIDATION_FAILED", message: "items is required" } })); return;
        }
        data = patch.data; version++; response.end(JSON.stringify(document())); return;
      }
      const fixed: Record<string, unknown> = {
        "/admin/api/me": { role: "admin", admin: true, login: "fixture", image: null },
        "/admin/api/site": { brand: "Fixture", icons: [], locales: ["en"], canonicalLocale: "en" },
        "/admin/api/collections": { collections: [collection()], allCollections: { notes: collection() } },
        "/admin/api/operations": { operations: [] }, "/admin/api/views-manifest": { views: [] },
        "/admin/api/webmcp": { tools: [], routes: {} }, "/api/auth/methods": { methods: [{ kind: "email-otp" }] },
        "/admin/api/entries/r1": document(), "/admin/api/entries/r2": document("r2"),
        "/admin/api/operations/refresh": { ok: true, output: {} },
      };
      response.end(JSON.stringify(fixed[url.pathname] ?? {})); return;
    }
    try {
      const path = url.pathname.slice("/admin/".length);
      if (/^[\w/-]+\.(?:js|css|svg)$/.test(path)) {
        response.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "image/svg+xml");
        response.end(await readFile(resolve(dist, path))); return;
      }
      response.setHeader("content-type", "text/html"); response.end(await readFile(join(dist, "index.html")));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    await page.addInitScript(() => localStorage.setItem("cms.preference.language", "en"));
    await page.goto(origin + "/admin/c/notes/r1");
    const json = page.getByRole("textbox", { name: "Custom JSON", exact: true });
    const save = page.getByRole("button", { name: "Save changes", exact: true });
    await json.fill("{ malformed");
    const error = page.getByRole("alert").filter({ hasText: "Enter valid JSON" }); await error.waitFor();
    expect(await json.getAttribute("aria-invalid")).toBe("true");
    expect(await json.getAttribute("aria-describedby")).toBe(await error.getAttribute("id"));
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Other edit");
    expect(await save.isEnabled()).toBe(false); expect(patches).toEqual([]);
    await page.getByRole("link", { name: "Home", exact: true }).click(); await page.getByRole("alertdialog").waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await json.inputValue()).toBe("{ malformed");
    // A nested array stays owned by this root field through an unrelated re-read.
    await page.getByRole("button", { name: "Refresh record", exact: true }).click();
    expect(await json.inputValue()).toBe("{ malformed"); expect(await save.isEnabled()).toBe(false);
    version++;
    await page.getByRole("button", { name: "Refresh record", exact: true }).click();
    await page.getByRole("button", { name: "Load latest version", exact: true }).click();
    expect(await json.inputValue()).toBe(JSON.stringify(data.metadata)); expect(await error.count()).toBe(0);
    await json.fill("{}"); expect(await save.isEnabled()).toBe(true); // no local error: server remains authoritative
    await save.click(); await page.getByText("items is required", { exact: false }).waitFor(); expect(patches).toHaveLength(1);
    expect(data.metadata.items).toEqual([{ label: "A" }]);
    await json.fill(JSON.stringify(data.metadata));
    await json.fill("{ malformed again"); hideMetadata = true;
    await page.getByRole("button", { name: "Refresh record", exact: true }).click();
    await json.waitFor({ state: "detached" }); expect(await error.count()).toBe(0);
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await page.waitForURL(origin + "/admin"); expect(await page.getByRole("alertdialog").count()).toBe(0);
    hideMetadata = false;
    await page.goto(origin + "/admin/c/notes/r2"); await json.fill("{ local draft"); locked = true;
    await page.getByRole("button", { name: "Refresh record", exact: true }).click();
    await page.getByText("This record is locked. Frozen", { exact: false }).waitFor();
    expect(await error.count()).toBe(0); expect(await save.isEnabled()).toBe(false);
    locked = false;
    await page.getByRole("button", { name: "Refresh record", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('fieldset')?.disabled);
    expect(await json.inputValue()).toBe("{ local draft");
    await error.waitFor(); expect(await save.isEnabled()).toBe(false);
    version++;
    await page.getByRole("button", { name: "Refresh record", exact: true }).click();
    await page.getByRole("button", { name: "Load latest version", exact: true }).click();
    expect(await json.inputValue()).toBe(JSON.stringify(data.metadata)); expect(await error.count()).toBe(0);
    await page.getByRole("link", { name: "Home", exact: true }).click(); await page.waitForURL(origin + "/admin");
    expect(await page.getByRole("alertdialog").count()).toBe(0);
    // Production builds do not replay effects. Exercise the real Admin StrictMode mount through its Vite dev plugin too.
    const { adminVitePlugin } = await import("../dist/build/index.js");
    const { createServer: createViteServer } = await import("vite");
    const dev = await createViteServer({ configFile: false, logLevel: "silent", plugins: await adminVitePlugin({ entry: entryFile, target: origin }), server: { port: 0, host: "127.0.0.1" } });
    try {
      await dev.listen();
      const devOrigin = `http://127.0.0.1:${(dev.httpServer!.address() as { port: number }).port}`;
      await page.goto(devOrigin + "/admin/c/notes/r1?initial-invalid");
      const initialError = page.getByRole("alert").filter({ hasText: "Initial invalid JSON" });
      await initialError.waitFor();
      expect(await save.isEnabled()).toBe(false);
      await page.getByRole("link", { name: "Home", exact: true }).click(); await page.getByRole("alertdialog").waitFor();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      hideMetadata = true;
      await page.getByRole("button", { name: "Refresh record", exact: true }).click();
      await json.waitFor({ state: "detached" });
      await page.evaluate(() => (window as unknown as { lastStatusCallback?: (status: unknown) => void }).lastStatusCallback?.({ error: "Stale async error", dirty: true }));
      expect(await initialError.count()).toBe(0);
      await page.getByRole("link", { name: "Home", exact: true }).click(); await page.waitForURL(devOrigin + "/admin");
      expect(await page.getByRole("alertdialog").count()).toBe(0);
    } finally { await dev.close(); }
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 120_000);
