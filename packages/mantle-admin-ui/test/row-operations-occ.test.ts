import { expect, it } from "vitest";
import { chromium } from "playwright";
import { createServer } from "vite";
import { resolve } from "node:path";

it("binds observed entry.version on row operations and does not reuse it after target or conflict", async () => {
  const server = await createServer({ configFile: resolve("vite.config.ts"), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    await page.addInitScript(() => {
      localStorage.setItem("cms.preference.language", "en");
      history.replaceState(null, "", "/admin/c/organizations");
    });
    const quotaBodies: unknown[] = [];
    const memberBodies: unknown[] = [];
    const orgVersion = { current: 4 };
    await page.route("**/admin/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace("/admin/api", "");
      const method = route.request().method();
      if (path === "/me") {
        return route.fulfill({ json: { id: "owner", role: "owner", login: "owner", image: null } });
      }
      if (path === "/site") {
        return route.fulfill({ json: { brand: "Site", icons: [], canonicalLocale: "en", locales: ["en"], title: "Site", description: "", publicUrl: "https://site.test", mcpUrl: "https://site.test/mcp" } });
      }
      if (path === "/collections") {
        return route.fulfill({ json: { collections: [orgCollection(), memberCollection()] } });
      }
      if (path === "/views-manifest") return route.fulfill({ json: { views: [] } });
      if (path === "/operations") {
        return route.fulfill({ json: { operations: [quotaOperation(), memberOperation()] } });
      }
      if (path === "/entries" && method === "GET") {
        return route.fulfill({ json: { items: [orgListRow()], previous_cursor: null, next_cursor: null } });
      }
      if (path === "/entries/org-1" && method === "GET") {
        return route.fulfill({ json: orgEditor(orgVersion.current) });
      }
      if (path === "/entries/member-1" && method === "GET") {
        return route.fulfill({ json: memberEditor(7) });
      }
      if (path === "/entries/member-2" && method === "GET") {
        return route.fulfill({ json: memberEditor(11, "member-2") });
      }
      if (path === "/operations/set-quota" && method === "POST") {
        quotaBodies.push(route.request().postDataJSON());
        if (quotaBodies.length === 1) {
          orgVersion.current = 5;
          return route.fulfill({
            status: 409,
            json: { ok: false, diagnostic: { code: "CONFLICT", message: "Version mismatch" } },
          });
        }
        return route.fulfill({ json: { ok: true, output: { ok: true } } });
      }
      if (path === "/operations/set-member-role" && method === "POST") {
        memberBodies.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true, output: { ok: true } } });
      }
      return route.fulfill({ json: {} });
    });

    await page.goto(new URL("/_mantle/admin/", server.resolvedUrls!.local[0]!).href);
    await page.getByRole("button", { name: "Row operations" }).waitFor();
    await page.getByRole("button", { name: "Row operations" }).click();
    await page.getByRole("menuitem", { name: "Set quota" }).click();
    const quotaDialog = page.getByRole("dialog");
    expect(await quotaDialog.getByText("Expected Version").count()).toBe(0);
    await quotaDialog.getByRole("spinbutton").fill("20");
    await quotaDialog.getByRole("button", { name: "Run", exact: true }).click();
    await quotaDialog.getByText("This record changed since you opened it.").waitFor();
    expect(quotaBodies[0]).toEqual({ organizationId: "org-1", quota: 20, expectedVersion: 4 });
    expect(await quotaDialog.getByRole("spinbutton").inputValue()).toBe("20");
    await quotaDialog.getByRole("button", { name: "Reload version" }).click();
    await quotaDialog.getByRole("button", { name: "Run", exact: true }).click();
    expect(quotaBodies[1]).toEqual({ organizationId: "org-1", quota: 20, expectedVersion: 5 });
    await quotaDialog.getByRole("button", { name: "Close" }).last().click();

    await page.getByRole("button", { name: "Row operations" }).click();
    await page.getByRole("menuitem", { name: "Set member role" }).click();
    const memberDialog = page.getByRole("dialog");
    await memberDialog.getByRole("textbox", { name: "Id" }).fill("member-1");
    await memberDialog.getByRole("textbox", { name: "Role" }).fill("owner");
    await memberDialog.getByRole("button", { name: "Run", exact: true }).click();
    await memberDialog.getByRole("region", { name: "Result" }).waitFor();
    expect(memberBodies[0]).toEqual({
      organizationId: "org-1",
      id: "member-1",
      role: "owner",
      expectedVersion: 7,
    });
    await memberDialog.getByRole("textbox", { name: "Id" }).fill("member-2");
    await memberDialog.getByRole("button", { name: "Run", exact: true }).click();
    expect(memberBodies[1]).toEqual({
      organizationId: "org-1",
      id: "member-2",
      role: "owner",
      expectedVersion: 11,
    });
  } finally {
    await browser.close();
    await server.close();
  }
}, 30_000);

function orgCollection() {
  return {
    name: "organizations",
    title: "Organizations",
    description: null,
    lifecycle: "operational",
    hasTranslations: false,
    localized: false,
    list: { primaryField: "name", columns: ["name"] },
    schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    },
  };
}

function memberCollection() {
  return {
    name: "organization-members",
    title: "Members",
    description: null,
    lifecycle: "operational",
    hasTranslations: false,
    localized: false,
    schema: { type: "object", properties: { role: { type: "string" } } },
  };
}

function orgListRow() {
  return {
    id: "org-1",
    collection: "organizations",
    locale: null,
    status: "published",
    version: 4,
    title: "Acme",
    updated_at: 1,
    translation_locales: [],
    data_preview: { name: "Acme" },
  };
}

function orgEditor(version: number) {
  return {
    collection: orgCollection(),
    entry: {
      id: "org-1",
      collection: "organizations",
      locale: null,
      status: "published",
      version,
      data: { name: "Acme" },
      updated_at: 1,
    },
    parentEntryId: null,
    related: [],
  };
}

function memberEditor(version: number, id = "member-1") {
  return {
    collection: memberCollection(),
    entry: {
      id,
      collection: "organization-members",
      locale: null,
      status: "published",
      version,
      data: { organizationId: "org-1", role: "editor" },
      updated_at: 1,
    },
    parentEntryId: null,
    related: [],
  };
}

function quotaOperation() {
  return {
    name: "set-quota",
    title: "Set quota",
    description: null,
    triggers: ["mcp"],
    uiSchema: null,
    targetCollection: "organizations",
    rowBindings: [{ collection: "organizations", inputField: "organizationId", rowField: "id" }],
    input: {
      type: "object",
      required: ["organizationId", "quota", "expectedVersion"],
      properties: {
        organizationId: { type: "string", title: "Organization", "x-mantle-ref": "organizations" },
        quota: { type: "integer", title: "Quota" },
        expectedVersion: { type: "number" },
      },
    },
  };
}

function memberOperation() {
  return {
    name: "set-member-role",
    title: "Set member role",
    description: null,
    triggers: ["mcp"],
    uiSchema: null,
    targetCollection: "organization-members",
    rowBindings: [
      { collection: "organizations", inputField: "organizationId", rowField: "id" },
      { collection: "organization-members", inputField: "id", rowField: "id" },
    ],
    input: {
      type: "object",
      required: ["id", "organizationId", "role", "expectedVersion"],
      properties: {
        id: { type: "string", title: "Id", "x-mantle-ref": "organization-members" },
        organizationId: { type: "string", title: "Organization", "x-mantle-ref": "organizations" },
        role: { type: "string", title: "Role" },
        expectedVersion: { type: "number" },
      },
    },
  };
}
