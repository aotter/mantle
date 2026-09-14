import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import type { Collection } from "../src/lib/types";

it("uses only the composition relationship and resets bulk selection when collection or parent changes", async () => {
  const deleted: string[] = [];
  const scopes: string[] = [];
  const errors: string[] = [];
  const collection = (name: string, title: string, child = false): Collection => ({
    name, title, description: null, lifecycle: "operational", hasTranslations: false, localized: false,
    parent: child ? { collection: "organizations", parentField: "id", childField: "organizationId" } : null,
    nav: null, translates: null, sortableFields: [], filter: null, list: { primaryField: "name", columns: [] },
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        billingOrganizationId: { type: "string", "x-mantle-ref": "organizations" },
        organizationId: { type: "string", "x-mantle-ref": "organizations" },
      },
      required: child ? ["organizationId"] : [],
    },
  });
  const org = collection("organizations", "Organizations");
  const projects = collection("projects", "Projects", true);
  projects.nav = { standalone: true, parentField: "organizationId", parentCollection: "organizations" };
  const members = collection("members", "Members", true);
  const item = (name: string, id: string, title: string) => ({
    id, collection: name, status: "published", version: 1, title,
    updated_at: 1, created_at: 1, data_preview: { name: title }, locales: [],
  });
  const parentPayload = (id: string) => ({
    collection: org,
    entry: { id, collection: org.name, status: "published", version: 1, locale: null, data: { name: id === "org-a" ? "Org A" : "Org B" }, updated_at: 1 },
    parentEntryId: null,
    related: [
      // The optional ref deliberately precedes the actual composition field.
      { collection: projects, relationship: { kind: "field", parentField: "id", childField: "billingOrganizationId", parentValue: id }, entries: [] },
      ...[projects, members].map((child) => ({
        collection: child,
        relationship: { kind: "field", parentField: "id", childField: "organizationId", parentValue: id },
        entries: [],
      })),
    ],
  });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost");
      const path = url.pathname;
      if (path.startsWith("/admin/api/")) {
        res.setHeader("content-type", "application/json");
        let body: unknown = {};
        if (req.method === "DELETE") { deleted.push(path); body = { removed: true }; }
        else if (path === "/admin/api/me") body = { role: "owner", login: "review", image: null };
        else if (path === "/admin/api/site") body = { brand: "Review", title: "Review", icons: [], locales: ["en"], canonicalLocale: "en" };
        else if (path === "/admin/api/collections") body = { collections: [org, projects, members] };
        else if (path === "/admin/api/operations") body = { operations: [] };
        else if (path === "/admin/api/views-manifest") body = { views: [] };
        else if (path === "/admin/api/entries/org-a" || path === "/admin/api/entries/org-b") body = parentPayload(path.slice("/admin/api/entries/".length));
        else if (path === "/admin/api/entries") {
          const name = url.searchParams.get("collection")!;
          const scope = url.searchParams.get("scope_field");
          if (scope) scopes.push(scope);
          if (scope === "billingOrganizationId") {
            res.statusCode = 400;
            body = { error: "INPUT_VALIDATION_FAILED" };
          } else {
            const isB = url.searchParams.get("scope_value") === "org-b";
            const rows = name === "organizations"
              ? [item(name, "org-a", "Org A"), item(name, "org-b", "Org B")]
              : [name === "projects" ? item(name, isB ? "p-b" : "p-a", isB ? "Project B" : "Project A") : item(name, "m-a", "Member A")];
            body = { items: rows.filter((row) => !deleted.includes(`/admin/api/entries/${row.id}`)), next_cursor: null, previous_cursor: null };
          }
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
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${origin}/admin/c/organizations/org-a?child=projects`);
    await page.getByRole("cell", { name: "Project A", exact: true }).waitFor();
    const children = page.getByRole("navigation", { name: "Child collections" });
    expect(await children.getByRole("link", { name: "Projects", exact: true }).count()).toBe(1);
    await page.getByRole("checkbox").first().check();
    await page.getByText("1 selected", { exact: true }).waitFor();
    await children.getByRole("link", { name: "Members", exact: true }).click();
    await page.getByRole("cell", { name: "Member A", exact: true }).waitFor();
    expect(await page.getByText("1 selected", { exact: true }).isVisible()).toBe(false);
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect.poll(() => deleted).toEqual(["/admin/api/entries/m-a"]);

    await page.goto(`${origin}/admin/c/projects?parent=org-a`);
    await page.getByRole("cell", { name: "Project A", exact: true }).waitFor();
    await page.getByRole("checkbox").first().check();
    await page.getByText("1 selected", { exact: true }).waitFor();
    await page.locator("#parent-filter-projects").fill("Org B");
    await page.getByRole("button", { name: /Org B/ }).click();
    await page.getByRole("cell", { name: "Project B", exact: true }).waitFor();
    expect(await page.getByText("1 selected", { exact: true }).isVisible()).toBe(false);
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect.poll(() => deleted).toEqual(["/admin/api/entries/m-a", "/admin/api/entries/p-b"]);
    expect(scopes.length).toBeGreaterThan(0);
    expect(new Set(scopes)).toEqual(new Set(["organizationId"]));
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 30_000);
