import { expect, it } from "vitest";
import { chromium } from "playwright";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";

it("the public media picker preserves the page draft, selects explicitly, never selects a late upload and takes any file a purpose allows", async () => {
  const root = await mkdtemp(join(tmpdir(), "mantle-media-picker-"));
  const { buildAdmin } = await import("../dist/build/index.js");
  const dist = join(root, "admin"),
    entry = join(root, "entry.tsx");
  await writeFile(
    entry,
    `
import * as React from "react";
import { defineAdmin } from ${JSON.stringify(resolve(import.meta.dirname, "../dist/admin-app/index.js"))};
import { MediaPicker } from ${JSON.stringify(resolve(import.meta.dirname, "../dist/admin-app/media.js"))};
function Page() {
  const [open, setOpen] = React.useState(false), [readOnly, setReadOnly] = React.useState(false), [mounted, setMounted] = React.useState(true);
  const [purpose, setPurpose] = React.useState(undefined), [selected, setSelected] = React.useState(null), [record, setRecord] = React.useState("r1");
  React.useEffect(() => { window.pickerTest = { setReadOnly, setMounted, setRecord, setPurpose }; }, []);
  return <><input aria-label="Unsaved draft" defaultValue="original"/><output aria-label="Selected">{JSON.stringify(selected)}</output>
    <button onClick={() => setOpen(true)}>Open picker</button>
    {mounted && <MediaPicker key={record} open={open} onOpenChange={setOpen} readOnly={readOnly} uploadPurpose={purpose}
      onSelect={asset => { window.picks = [...(window.picks || []), {record, asset}]; setSelected(asset); }}/>}</>;
}
export default defineAdmin({}, {pages: [{path: "cards", title: "Cards", element: <Page/>}]});
`,
  );
  const mcpEntry = join(root, "entry.mcp.tsx");
  await writeFile(
    mcpEntry,
    `import { defineAdmin } from ${JSON.stringify(resolve(import.meta.dirname, "../dist/admin-app/index.js"))}; export default defineAdmin({});`,
  );
  await buildAdmin({ entry, mcpEntry, outDir: dist });
  const requests: string[] = [],
    creates: unknown[] = [];
  let denied = false,
    commitCount = 0,
    pendingCommit: (() => void) | undefined;
  const items = [
    { id: "existing", primaryUrl: null, alt: "Existing private image", caption: null, byteSize: 1, createdAt: 0 },
    {
      id: "document",
      primaryUrl: "https://media.example.com/document.pdf",
      mime: "application/pdf",
      filename: "report.pdf",
      alt: null,
      caption: null,
      byteSize: 1,
      createdAt: 0,
    },
  ];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/upload") {
      for await (const _ of request) {
      }
      response.end();
      return;
    }
    if (url.pathname.startsWith("/admin/api/")) {
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/admin/api/media/uploads") {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const created = JSON.parse(raw);
        creates.push(created);
        if (denied) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: { code: "AUTH_DENIED", message: "Upload refused" } }));
          return;
        }
        response.end(
          JSON.stringify({
            uploadGroupId: "g1",
            capabilities: created.variants.map((variant: { mimeType: string; role: string }) => ({
              mimeType: variant.mimeType,
              role: variant.role,
              method: "PUT",
              uploadUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/upload`,
            })),
          }),
        );
        return;
      }
      if (url.pathname.endsWith("/g1/commit")) {
        commitCount++;
        pendingCommit = () => {
          items.push({ id: "uploaded", primaryUrl: null, alt: "Uploaded", caption: null, byteSize: 1, createdAt: 0 });
          response.end(JSON.stringify({ id: "uploaded", variants: [] }));
        };
        return;
      }
      const fixed: Record<string, unknown> = {
        "/admin/api/me": { role: "admin", admin: true, login: "fixture", image: null },
        "/admin/api/site": {
          brand: "Fixture",
          icons: [],
          locales: ["en"],
          canonicalLocale: "en",
          media: {
            purposes: [
              { name: "card", required: ["image/png"], maxBytes: { "image/png": 100000 } },
              { name: "docs", required: ["*/*"], maxBytes: { "*/*": 100000 } },
            ],
          },
        },
        "/admin/api/collections": { collections: [], allCollections: {} },
        "/admin/api/operations": { operations: [] },
        "/admin/api/views-manifest": { views: [] },
        "/admin/api/webmcp": { tools: [], routes: {} },
        "/admin/api/media": { items, next_cursor: null },
      };
      response.end(JSON.stringify(fixed[url.pathname] ?? {}));
      return;
    }
    try {
      const path = url.pathname.slice("/admin/".length);
      if (/^[\w/-]+\.(?:js|css|svg)$/.test(path)) {
        response.setHeader(
          "content-type",
          path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "image/svg+xml",
        );
        response.end(await readFile(resolve(dist, path)));
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(await readFile(join(dist, "index.html")));
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({
    channel: "chrome",
    executablePath: process.env.MANTLE_TEST_CHROMIUM,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await page.goto(origin + "/admin/p/cards");
    await page.getByRole("textbox", { name: "Unsaved draft" }).fill("keep this draft");
    const dialog = page.getByRole("dialog"),
      upload = dialog.getByRole("button", { name: "Upload", exact: true });
    await page.getByRole("button", { name: "Open picker" }).click();
    await dialog.getByRole("button", { name: "Use this file" }).first().waitFor();
    expect(await upload.isEnabled()).toBe(false);
    // a file that is not an image is a file tile with its name, not a broken image
    expect(await dialog.locator("[data-media-file]").textContent()).toBe("report.pdf");
    expect(await dialog.locator('img[src$="document.pdf"]').count()).toBe(0);
    const search = dialog.getByRole("textbox", { name: "Search alt text, caption, or id" });
    await search.fill("private");
    await search.press("Enter");
    await page.waitForFunction(() => window.location.pathname === "/admin/p/cards");
    await expect.poll(() => requests.some(path => path.includes("search=private"))).toBe(true);
    expect(await page.locator('[aria-label="Unsaved draft"]').inputValue()).toBe("keep this draft");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    expect(await page.getByLabel("Selected").textContent()).toBe("null");
    await page.getByRole("button", { name: "Open picker" }).click();
    expect(await search.inputValue()).toBe("");
    await dialog.getByRole("button", { name: "Use this file" }).first().click();
    await dialog.waitFor({ state: "detached" });
    expect(await page.getByLabel("Selected").textContent()).toBe('{"id":"existing","primaryUrl":null}');
    await page.evaluate(() => (window as any).pickerTest.setPurpose("unknown"));
    await page.getByRole("button", { name: "Open picker" }).click();
    expect(await upload.isEnabled()).toBe(false);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.evaluate(() => (window as any).pickerTest.setPurpose("card"));
    await page.getByRole("button", { name: "Open picker" }).click();
    expect(await upload.isEnabled()).toBe(true);
    // an image purpose takes any image, re-encoded into its types
    expect(await dialog.locator('input[type="file"]').getAttribute("accept")).toBe("image/*");
    // Real raster encoding + create, direct PUT and commit. Commit remains pending while the owning input disappears.
    const png = Buffer.from(
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 2;
        canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
        return canvas.toDataURL("image/png").split(",")[1]!;
      }),
      "base64",
    );
    await dialog.locator('input[type="file"]').setInputFiles({ name: "card.png", mimeType: "image/png", buffer: png });
    await expect.poll(() => commitCount).toBe(1);
    expect(creates[0]).toMatchObject({ purpose: "card" });
    await page.evaluate(() => (window as any).pickerTest.setReadOnly(true));
    await dialog.waitFor({ state: "detached" });
    pendingCommit!();
    pendingCommit = undefined;
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).picks)).toHaveLength(1);
    await page.evaluate(() => {
      (window as any).pickerTest.setMounted(false);
      (window as any).pickerTest.setRecord("r2");
      (window as any).pickerTest.setReadOnly(false);
    });
    await page.evaluate(() => (window as any).pickerTest.setMounted(true));
    // commit survives cancellation; the remounted list can paint its cached page before the refetch adds the upload
    await expect.poll(() => dialog.getByRole("button", { name: "Use this file" }).count()).toBe(3);
    denied = true;
    await dialog
      .locator('input[type="file"]')
      .setInputFiles({ name: "denied.png", mimeType: "image/png", buffer: png });
    await dialog.getByText(/Upload refused/).waitFor();
    expect(commitCount).toBe(1);
    expect(await page.evaluate(() => (window as any).picks)).toHaveLength(1);
    // a PDF on an image purpose is refused by name, before any request
    const pdf = Buffer.from("%PDF-1.7\n%%EOF\n");
    await dialog
      .locator('input[type="file"]')
      .setInputFiles({ name: "minutes.pdf", mimeType: "application/pdf", buffer: pdf });
    await dialog.getByText(/minutes\.pdf is application\/pdf, but 'card' takes images/).waitFor();
    expect(creates).toHaveLength(2);
    // a purpose that takes any type: the file goes up as it is, with no alt text
    denied = false;
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.evaluate(() => (window as any).pickerTest.setPurpose("docs"));
    await page.getByRole("button", { name: "Open picker" }).click();
    expect(await dialog.locator('input[type="file"]').getAttribute("accept")).toBe("");
    await dialog
      .locator('input[type="file"]')
      .setInputFiles({ name: "minutes.pdf", mimeType: "application/pdf", buffer: pdf });
    await expect.poll(() => commitCount).toBe(2);
    pendingCommit!();
    pendingCommit = undefined;
    expect(creates[2]).toEqual({
      filename: "minutes.pdf",
      purpose: "docs",
      variants: [{ mimeType: "application/pdf", byteSize: pdf.length, role: "primary" }],
    });
    expect(requests.some(path => path.startsWith("PATCH") || path.startsWith("DELETE"))).toBe(false);
  } finally {
    pendingCommit?.();
    await browser.close();
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
