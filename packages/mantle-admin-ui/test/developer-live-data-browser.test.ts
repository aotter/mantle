import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import type { Collection, DeveloperConsoleSnapshot } from "../src/lib/types";

it("loads live model data only on demand through the existing guarded paths", async () => {
  const reads: string[] = [];
  const schema = (name: string, lifecycle: "operational" | "publishing" = "operational"): DeveloperConsoleSnapshot["dataModel"]["schemas"][number] => ({
    name, title: name, lifecycle, localized: false, translates: null,
    schema: { type: "object", properties: { title: { type: "string" } } },
    uniqueIndexes: [], indexes: [], searchableFields: [], manifest: {},
  });
  const collection = (name: string, lifecycle: "operational" | "publishing" = "operational"): Collection => ({
    name, title: name, description: null, lifecycle, hasTranslations: false,
    localized: false, parent: null, nav: null, translates: null, sortableFields: [], filter: null,
    list: { primaryField: "title", columns: ["title"] },
    schema: { type: "object", properties: { title: { type: "string" } } },
  });
  const snapshot: DeveloperConsoleSnapshot = {
    dataModel: {
      schemas: [schema("articles"), schema("empty"), schema("news", "publishing")],
      views: [{
        name: "lookup", title: "Lookup", surface: "staff", authorization: [], guard: null,
        query: { kind: "declarative", from: "articles", orderBy: [], params: {
          type: "object", properties: { sku: { type: "string" } }, required: ["sku"],
        } },
        manifest: {},
      }],
    },
    logic: { triggers: [], procedures: [] },
    interfaces: { http: [], callable: [] },
    graph: { atoms: [
      { id: "Schema:articles", kind: "Schema", name: "articles", title: "articles" },
      { id: "Schema:empty", kind: "Schema", name: "empty", title: "empty" },
      { id: "Schema:news", kind: "Schema", name: "news", title: "news" },
      { id: "View:lookup", kind: "View", name: "lookup", title: "Lookup" },
    ], relations: [] },
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost");
      const path = url.pathname;
      if (path.startsWith("/admin/api/")) {
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "private, no-store");
        let body: unknown = {};
        if (path === "/admin/api/me") body = { role: "owner", login: "review", image: null };
        else if (path === "/admin/api/site") body = { brand: "Review", title: "Review", icons: [], locales: ["en"], canonicalLocale: "en" };
        else if (path === "/admin/api/developer-console") body = snapshot;
        else if (path === "/admin/api/collections") body = { collections: [collection("articles"), collection("empty"), collection("news", "publishing")] };
        else if (path === "/admin/api/entries") {
          reads.push(url.href);
          body = { items: url.searchParams.get("collection") === "articles" ? [{
            id: "article-1", collection: "articles", status: "published", version: 2,
            title: "Article A", updated_at: 1_700_000_000_000, data_preview: { title: "Article A" },
          }] : url.searchParams.get("collection") === "news" ? [{
            id: "news-1", collection: "news", status: "published", version: 1,
            title: "News title", updated_at: 1_700_000_000_000,
          }] : [], previous_cursor: null, next_cursor: null };
        } else if (path === "/admin/api/views/lookup") {
          reads.push(url.href);
          if (url.searchParams.get("sku") === "denied") {
            res.statusCode = 403;
            body = { ok: false, diagnostic: { message: "View access denied" } };
          } else body = { ok: true, data: { rows: [{ sku: url.searchParams.get("sku"), title: "Found" }], page: 1, show: 20, hasMore: false } };
        }
        res.end(JSON.stringify(body));
        return;
      }
      if (path.startsWith("/_mantle/admin/")) {
        const file = resolve("dist", path.slice("/_mantle/admin/".length));
        res.setHeader("content-type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "image/svg+xml");
        res.end(await readFile(file));
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end((await readFile(resolve("dist/index.html"), "utf8")).replace("<head>", "<head><script>localStorage.setItem('cms.preference.language','en')</script>"));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(`${origin}/admin/dev/model/schemas?selected=Schema:articles`);
    await page.getByRole("tab", { name: "Live data" }).waitFor();
    expect(reads).toEqual([]);
    await page.getByRole("tab", { name: "Live data" }).click();
    await page.getByRole("cell", { name: "Article A" }).waitFor();
    expect(reads).toHaveLength(1);
    expect(await page.getByRole("link", { name: "article-1" }).getAttribute("href"))
      .toBe("/admin/c/articles/article-1");

    await page.goto(`${origin}/admin/dev/model/schemas?selected=Schema:empty&tab=data`);
    await page.getByRole("heading", { name: "No data yet" }).waitFor();

    await page.goto(`${origin}/admin/dev/model/schemas?selected=Schema:news&tab=data`);
    await page.getByRole("cell", { name: "News title" }).waitFor();

    await page.goto(`${origin}/admin/dev/model/views?selected=View:lookup&tab=data`);
    expect(reads.filter((url) => url.includes("/views/lookup"))).toEqual([]);
    await page.getByLabel("sku").fill("ok");
    await page.getByRole("button", { name: "Query" }).click();
    await page.getByRole("cell", { name: "Found" }).waitFor();
    expect(reads.filter((url) => url.includes("/views/lookup"))).toHaveLength(1);
    const repeat = page.waitForResponse((response) => response.url().includes("/views/lookup") && response.url().includes("sku=ok"));
    await page.getByRole("button", { name: "Query" }).click();
    await repeat;
    expect(reads.filter((url) => url.includes("/views/lookup"))).toHaveLength(2);
    await page.getByLabel("sku").fill("denied");
    await page.getByRole("button", { name: "Query" }).click();
    await page.getByText("View access denied").waitFor();
  } finally {
    await browser.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 30_000);
