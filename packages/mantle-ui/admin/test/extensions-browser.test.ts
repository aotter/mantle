import { expect, it } from "vitest";
import { chromium, type Page, type Route } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

// The built Admin (`pnpm build`), so the import map and the shared modules are the ones that ship (ADR-lite 1376).
const DIST = resolve(import.meta.dirname, "../../dist/admin");
const ORIGIN = "http://admin.test";

const MODULE = `
import * as React from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { Button } from "@aotter/mantle-ui/kit";
import { defineAdminExtension } from "@aotter/mantle-ui/extension";

const mount = (Component) => (element, context) => {
  const root = createRoot(element);
  root.render(jsx(Component, { context }));
  return { update: (next) => root.render(jsx(Component, { context: next })), unmount: () => root.unmount() };
};
function Grants({ context }) {
  const [count, setCount] = React.useState(0);
  const same = React === globalThis.__MANTLE_ADMIN_SHARED__.react || React.useState === globalThis.__MANTLE_ADMIN_SHARED__.react.useState;
  return jsxs("div", { children: [
    jsx(Button, { onClick: () => setCount(count + 1), children: "Count " + count }),
    jsx("p", { children: "shared react " + same }),
    jsx("p", { children: "api " + context.apiBase + " as " + context.caller.role }),
  ] });
}
function Color({ context }) {
  return jsx("input", { "aria-label": "Brand color", value: String(context.field.value ?? ""), onChange: (event) => context.onChange(event.target.value) });
}
export default defineAdminExtension({
  pages: { grants: mount(Grants) },
  panels: { usage: (element, context) => { element.textContent = "Usage of " + context.record.id + " v" + context.record.version; } },
  fields: {
    color: mount(Color),
    swatch: (element, context) => { element.textContent = "swatch:" + context.field.value; },
  },
});
`;

const extension = {
  id: "brand", title: "Brand", module: "/ext/brand.js",
  contributes: {
    pages: [{ id: "grants", title: "Grants", role: "editor", nav: { group: "more" } }],
    settings: [{ id: "policy", title: "Policy", role: "owner", schema: { type: "object", properties: { limit: { type: "integer", title: "Limit", minimum: 1 } } } }],
    actions: [{ id: "flag", title: "Flag", role: "editor", target: "record/v1", presentation: "confirm", when: { schema: ["organizations"] } }],
    panels: [{ id: "usage", title: "Usage", role: "contributor", target: "record.sidebar/v1", when: { schema: ["organizations"] } }],
    fields: [{ id: "color", target: "field.input/v1" }, { id: "swatch", target: "field.cell/v1" }],
  },
};
const collection = {
  name: "organizations", title: "Organizations", description: null, lifecycle: "operational", hasTranslations: false, localized: false,
  list: { primaryField: "name", columns: ["name", "color"] },
  uiSchema: { fields: { color: { widget: "brand/color" } }, list: { cells: { color: "brand/swatch" } } },
  schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, color: { type: "string" } } },
};
const site = { brand: "Site", icons: [], canonicalLocale: "en", locales: ["en"], title: "Site", description: "", publicUrl: "https://site.test", mcpUrl: null, extensions: [extension] };
const row = { id: "org-1", collection: "organizations", locale: null, status: "published", version: 4, title: "Acme", updated_at: 1, translation_locales: [], data_preview: { name: "Acme", color: "teal" } };
const editor = { collection, entry: { id: "org-1", collection: "organizations", locale: null, status: "published", version: 4, data: { name: "Acme", color: "teal" }, updated_at: 1 }, parentEntryId: null, related: [] };

const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png" };

async function boot(path: string): Promise<{ page: Page; calls: { method: string; path: string; body: unknown }[]; close: () => Promise<void> }> {
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  await page.addInitScript(() => localStorage.setItem("cms.preference.language", "en"));
  const calls: { method: string; path: string; body: unknown }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/ext/brand.js") return route.fulfill({ body: MODULE, contentType: "text/javascript" });
    if (url.pathname.startsWith("/admin/api/")) {
      const api = url.pathname.replace("/admin/api", "");
      const body = method === "GET" ? undefined : route.request().postDataJSON();
      calls.push({ method, path: api, body });
      if (api === "/me") return route.fulfill({ json: { id: "owner", role: "owner", login: "owner", image: null } });
      if (api === "/bootstrap") return route.fulfill({ json: { me: { id: "owner", role: "owner", login: "owner", image: null }, site, collections: [collection], views: [], operations: [], webmcp: { tools: [], routes: {} }, entries: { items: [row], previous_cursor: null, next_cursor: null } } });
      if (api === "/site") return route.fulfill({ json: site });
      if (api === "/collections") return route.fulfill({ json: { collections: [collection] } });
      if (api === "/views-manifest") return route.fulfill({ json: { views: [] } });
      if (api === "/operations") return route.fulfill({ json: { operations: [] } });
      if (api === "/entries" && method === "GET") return route.fulfill({ json: { items: [row], previous_cursor: null, next_cursor: null } });
      if (api === "/entries/org-1" && method === "GET") return route.fulfill({ json: editor });
      if (api === "/entries/org-1" && method === "PATCH") return route.fulfill({ json: { ...editor, entry: { ...editor.entry, version: 5, data: (body as { data: unknown }).data } } });
      if (api === "/x/brand/settings/policy") return route.fulfill({ json: { value: method === "GET" ? { limit: 2 } : (body as { value: unknown }).value } });
      if (api === "/x/brand/actions/flag") return route.fulfill({ json: { ok: true, result: { message: "Flagged Acme" } } });
      return route.fulfill({ json: {} });
    }
    const rel = url.pathname.replace(/^\/admin\/?/, "");
    const file = resolve(DIST, rel);
    if (rel && file.startsWith(DIST) && existsSync(file) && extname(file)) return route.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" });
    return route.fulfill({ body: readFileSync(resolve(DIST, "index.html")), contentType: "text/html" });
  });
  await page.goto(`${ORIGIN}${path}`);
  return { page, calls, close: async () => { await browser.close(); expect(errors).toEqual([]); } };
}

it.skipIf(!existsSync(resolve(DIST, "index.html")))("renders extension pages, settings, actions, panels and widgets with Admin's own React", async () => {
  const { page, calls, close } = await boot("/admin/c/organizations");
  try {
    // a list cell from uiSchema.list.cells
    await page.getByText("swatch:teal").waitFor();

    // a page from the sidebar, sharing Admin's React and kit
    await page.getByRole("link", { name: "Grants", exact: true }).click();
    await page.getByRole("heading", { name: "Grants" }).waitFor();
    await page.getByText("shared react true").waitFor();
    await page.getByText("api /admin/api/x/brand/api as owner").waitFor();
    await page.getByRole("button", { name: "Count 0" }).click();
    await page.getByRole("button", { name: "Count 1" }).waitFor();

    // settings rendered from the schema, saved whole
    await page.getByRole("link", { name: "Policy", exact: true }).click();
    const limit = page.getByRole("spinbutton");
    await expect.poll(() => limit.inputValue()).toBe("2");
    await limit.fill("5");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Settings saved").waitFor();
    expect(calls.filter((c) => c.path === "/x/brand/settings/policy" && c.method === "PATCH").map((c) => c.body)).toEqual([{ value: { limit: 5 } }]);

    // a record: its panel, its confirmed action and an extension widget that edits the field
    await page.goto(`${ORIGIN}/admin/c/organizations/org-1/edit`);
    await page.getByText("Usage of org-1 v4").waitFor();
    await page.getByRole("button", { name: "Flag" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Confirm" }).click();
    await page.getByText("Flagged Acme").waitFor();
    expect(calls.filter((c) => c.path === "/x/brand/actions/flag").map((c) => c.body)).toEqual([{ record: { schema: "organizations", id: "org-1", version: 4 } }]);
    const color = page.getByRole("textbox", { name: "Brand color" });
    await expect.poll(() => color.inputValue()).toBe("teal");
    await page.getByRole("button", { name: "Unlock editing" }).click();
    await color.fill("navy blue");
    // typing keeps the widget mounted, focused and in step
    expect(await color.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(() => calls.find((c) => c.path === "/entries/org-1" && c.method === "PATCH")?.body).toMatchObject({ data: { name: "Acme", color: "navy blue" }, expectedVersion: 4 });
  } finally {
    await close();
  }
}, 40_000);
