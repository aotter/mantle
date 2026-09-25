import { expect, it } from "vitest";
import { chromium, type Page } from "playwright";
import { createServer } from "vite";
import { resolve } from "node:path";

it("prefetches row detail on intent and reuses it after navigation", async () => {
  const session = await bootAdmin({ operations: [] });
  try {
    const { page, entryReads } = session;
    await page.getByRole("row").filter({ hasText: "Acme" }).hover();
    await expect.poll(() => entryReads).toEqual(["org-1"]);
    await page.getByRole("link", { name: "Edit Acme." }).click();
    await page.getByRole("heading", { name: "Acme" }).waitFor();
    expect(entryReads).toEqual(["org-1"]);
  } finally {
    await session.close();
  }
}, 30_000);

it("binds observed entry.version on row operations and does not reuse it after target or conflict", async () => {
  const session = await bootAdmin({
    operations: [quotaOperation(), memberOperation()],
  });
  try {
    const { page, quotaBodies, memberBodies, memberReads } = session;
    await page.getByRole("button", { name: "Row operations" }).click();
    await page.getByRole("menuitem", { name: "Set quota" }).click();
    const quotaDialog = page.getByRole("dialog");
    expect(await quotaDialog.getByText("Expected Version").count()).toBe(0);
    await quotaDialog.getByRole("spinbutton").fill("20");
    await quotaDialog.getByRole("button", { name: "Run", exact: true }).click();
    await quotaDialog.getByText("This record changed since you opened it.").waitFor();
    await expect.poll(() => quotaBodies[0]).toEqual({ organizationId: "org-1", quota: 20, expectedVersion: 4 });
    expect(await quotaDialog.getByRole("spinbutton").inputValue()).toBe("20");
    await quotaDialog.getByRole("button", { name: "Reload version" }).click();
    await quotaDialog.getByRole("button", { name: "Run", exact: true }).click();
    await expect.poll(() => quotaBodies[1]).toEqual({ organizationId: "org-1", quota: 20, expectedVersion: 5 });
    await quotaDialog.getByRole("button", { name: "Close" }).last().click();

    await page.getByRole("button", { name: "Row operations" }).click();
    await page.getByRole("menuitem", { name: "Set member role" }).click();
    const memberDialog = page.getByRole("dialog");
    await memberDialog.getByRole("textbox", { name: "Id" }).fill("member-1");
    await memberDialog.getByRole("textbox", { name: "Role" }).fill("owner");
    const memberRun = memberDialog.getByRole("button", { name: "Run", exact: true });
    await expect.poll(() => memberReads.includes("member-1")).toBe(true);
    // Playwright waits for enablement; Vitest's short poll raced the UI under CI load.
    await memberRun.click();
    await memberDialog.getByRole("region", { name: "Result" }).waitFor();
    await expect.poll(() => memberBodies[0]).toEqual({
      organizationId: "org-1",
      id: "member-1",
      role: "owner",
      expectedVersion: 7,
    });
    await memberDialog.getByRole("textbox", { name: "Id" }).fill("member-2");
    await expect.poll(() => memberReads.includes("member-2")).toBe(true);
    await memberRun.click();
    await expect.poll(() => memberBodies[1]).toEqual({
      organizationId: "org-1",
      id: "member-2",
      role: "owner",
      expectedVersion: 11,
    });
  } finally {
    await session.close();
  }
}, 30_000);

it("binds observed version on a row-opened upsert before submit even when expectedVersion is not required", async () => {
  const session = await bootAdmin({
    operations: [upsertThemeOperation()],
  });
  try {
    const { page, upsertBodies } = session;
    await page.getByRole("button", { name: "Row operations" }).click();
    await page.getByRole("menuitem", { name: "Set theme" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Theme" }).fill("dark");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await expect.poll(() => upsertBodies[0]).toEqual({ organizationId: "org-1", theme: "dark", expectedVersion: 4 });
  } finally {
    await session.close();
  }
}, 30_000);

it("keeps Run disabled when expectedVersion is required and no OCC target is resolved", async () => {
  const session = await bootAdmin({
    operations: [memberOperation()],
  });
  try {
    const { page, memberBodies } = session;
    await page.getByRole("button", { name: "Row operations" }).click();
    await page.getByRole("menuitem", { name: "Set member role" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Role" }).fill("owner");
    expect(await dialog.getByRole("button", { name: "Run", exact: true }).isEnabled()).toBe(false);
    expect(memberBodies).toHaveLength(0);
  } finally {
    await session.close();
  }
}, 30_000);

it("lets a collection create dialog omit expectedVersion when it is not required", async () => {
  const session = await bootAdmin({
    operations: [createSettingOperation()],
  });
  try {
    const { page, createBodies } = session;
    await page.getByRole("button", { name: "Create setting" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Site Key" }).fill("main");
    await dialog.getByRole("textbox", { name: "Theme" }).fill("light");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await expect.poll(() => createBodies[0]).toEqual({ siteKey: "main", theme: "light" });
  } finally {
    await session.close();
  }
}, 30_000);

it("re-reads identical cached data and refreshes version after success before reopening", async () => {
  const session = await bootAdmin({ operations: [quotaOperation()], unchangedConflict: true });
  try {
    const { page, quotaBodies } = session;
    const open = async () => {
      await page.getByRole("button", { name: "Row operations" }).click();
      await page.getByRole("menuitem", { name: "Set quota" }).click();
    };
    await open();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("spinbutton").fill("20");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByRole("button", { name: "Reload version" }).click();
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByRole("region", { name: "Result" }).waitFor();
    expect(quotaBodies[1]).toMatchObject({ expectedVersion: 4, quota: 20 });
    await dialog.getByRole("button", { name: "Close" }).last().click();
    await open();
    await dialog.getByRole("spinbutton").fill("30");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByRole("region", { name: "Result" }).waitFor();
    expect(quotaBodies[2]).toMatchObject({ expectedVersion: 5, quota: 30 });
  } finally { await session.close(); }
}, 30_000);

it("does not offer version reload for non-OCC 409", async () => {
  const session = await bootAdmin({ operations: [quotaOperation()], conflictCode: "LIFECYCLE_HOOK_REJECTED" });
  try {
    const { page } = session;
    await page.getByRole("button", { name: "Row operations" }).click();
    await page.getByRole("menuitem", { name: "Set quota" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("spinbutton").fill("20");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByText("The operation ran but failed to complete.").waitFor();
    expect(await dialog.getByRole("button", { name: "Reload version" }).count()).toBe(0);
  } finally { await session.close(); }
}, 30_000);

async function bootAdmin(args: { operations: unknown[]; unchangedConflict?: boolean; conflictCode?: string }): Promise<{
  page: Page;
  quotaBodies: unknown[];
  memberBodies: unknown[];
  upsertBodies: unknown[];
  createBodies: unknown[];
  entryReads: string[];
  memberReads: string[];
  close: () => Promise<void>;
}> {
  const server = await createServer({ configFile: resolve("vite.config.ts"), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  await page.addInitScript(() => {
    localStorage.setItem("cms.preference.language", "en");
    history.replaceState(null, "", "/admin/c/organizations");
  });
  const quotaBodies: unknown[] = [];
  const memberBodies: unknown[] = [];
  const upsertBodies: unknown[] = [];
  const createBodies: unknown[] = [];
  const entryReads: string[] = [];
  const memberReads: string[] = [];
  const orgVersion = { current: 4 };
  await page.route("**/admin/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/admin/api", "");
    const method = route.request().method();
    if (path === "/bootstrap") {
      return route.fulfill({ json: {
        me: { userId: "owner", role: "owner", login: "owner", image: null },
        site: { brand: "Site", icons: [], canonicalLocale: "en", locales: ["en"], title: "Site", description: "", publicUrl: "https://site.test", mcpUrl: "https://site.test/mcp" },
        collections: [orgCollection(), memberCollection()],
        views: [],
        operations: args.operations,
        webmcp: { tools: [], routes: {} },
        entries: { items: [orgListRow()], previous_cursor: null, next_cursor: null },
      } });
    }
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
      return route.fulfill({ json: { operations: args.operations } });
    }
    if (path === "/entries" && method === "GET") {
      return route.fulfill({ json: { items: [orgListRow()], previous_cursor: null, next_cursor: null } });
    }
    if (path === "/entries/org-1" && method === "GET") {
      entryReads.push("org-1");
      return route.fulfill({ json: orgEditor(orgVersion.current) });
    }
    if (path === "/entries/member-1" && method === "GET") {
      memberReads.push("member-1");
      return route.fulfill({ json: memberEditor(7) });
    }
    if (path === "/entries/member-2" && method === "GET") {
      memberReads.push("member-2");
      return route.fulfill({ json: memberEditor(11, "member-2") });
    }
    if (path === "/operations/set-quota" && method === "POST") {
      quotaBodies.push(route.request().postDataJSON());
      if (quotaBodies.length === 1) {
        orgVersion.current = args.unchangedConflict ? 4 : 5;
        return route.fulfill({
          status: 409,
          json: { ok: false, diagnostic: { code: args.conflictCode ?? "CONFLICT", message: "Rejected" } },
        });
      }
      orgVersion.current++;
      return route.fulfill({ json: { ok: true, output: { ok: true } } });
    }
    if (path === "/operations/set-member-role" && method === "POST") {
      memberBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, output: { ok: true } } });
    }
    if (path === "/operations/set-theme" && method === "POST") {
      upsertBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, output: { ok: true } } });
    }
    if (path === "/operations/create-setting" && method === "POST") {
      createBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, output: { ok: true } } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(new URL("/_mantle/admin/", server.resolvedUrls!.local[0]!).href);
  await page.getByRole("heading", { name: "Organizations" }).waitFor();
  return {
    page,
    quotaBodies,
    memberBodies,
    upsertBodies,
    createBodies,
    entryReads,
    memberReads,
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}

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

function upsertThemeOperation() {
  return {
    name: "set-theme",
    title: "Set theme",
    description: null,
    triggers: ["mcp"],
    uiSchema: null,
    targetCollection: "organizations",
    rowBindings: [{ collection: "organizations", inputField: "organizationId", rowField: "id" }],
    input: {
      type: "object",
      required: ["organizationId", "theme"],
      properties: {
        organizationId: { type: "string", title: "Organization", "x-mantle-ref": "organizations" },
        theme: { type: "string", title: "Theme" },
        expectedVersion: { type: "number" },
      },
    },
  };
}

function createSettingOperation() {
  return {
    name: "create-setting",
    title: "Create setting",
    description: null,
    triggers: ["mcp"],
    uiSchema: { collectionAction: "organizations" },
    targetCollection: "site-settings",
    rowBindings: [],
    input: {
      type: "object",
      required: ["siteKey", "theme"],
      properties: {
        siteKey: { type: "string", title: "Site Key" },
        theme: { type: "string", title: "Theme" },
        expectedVersion: { type: "number" },
      },
    },
  };
}
