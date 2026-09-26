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

it("locks the version the person reviewed; a conflict keeps the input and needs a review of the newer version", async () => {
  const session = await bootAdmin({ operations: [quotaOperation()] });
  try {
    const { page, quotaBodies } = session;
    await page.getByRole("button", { name: "Row operations" }).click();
    await page.getByRole("menuitem", { name: "Set quota" }).click();
    const dialog = page.getByRole("dialog");
    expect(await dialog.getByText("Expected Version").count()).toBe(0);
    await dialog.getByRole("spinbutton").fill("20");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByText("This entry changed before your update was saved.", { exact: false }).waitFor();
    expect(quotaBodies[0]).toEqual({ organizationId: "org-1", quota: 20, expectedVersion: 4 });
    expect(await dialog.getByRole("spinbutton").inputValue()).toBe("20");
    // The newer version is shown for review; nothing is sent until then.
    await dialog.getByRole("button", { name: "Load latest version" }).click();
    await dialog.getByRole("button", { name: "Review newer version" }).click();
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByRole("region", { name: "Result" }).waitFor();
    expect(quotaBodies[1]).toEqual({ organizationId: "org-1", quota: 20, expectedVersion: 5 });
    expect(quotaBodies).toHaveLength(2);
  } finally {
    await session.close();
  }
}, 30_000);

it("shows a change made since the list and never swaps the version silently", async () => {
  const session = await bootAdmin({ operations: [quotaOperation()], entryVersion: 6 });
  try {
    const { page, quotaBodies } = session;
    await page.getByRole("button", { name: "Row operations" }).click();
    await page.getByRole("menuitem", { name: "Set quota" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Someone changed this entry after you opened it.", { exact: false }).waitFor();
    await dialog.getByRole("spinbutton").fill("20");
    expect(await dialog.getByRole("button", { name: "Run", exact: true }).isEnabled()).toBe(false);
    await dialog.getByRole("button", { name: "Review newer version" }).click();
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await expect.poll(() => quotaBodies[0]).toEqual({ organizationId: "org-1", quota: 20, expectedVersion: 6 });
  } finally {
    await session.close();
  }
}, 30_000);

it("binds a reference without locking anything, and guesses no other target", async () => {
  const session = await bootAdmin({ operations: [memberOperation()] });
  try {
    const { page, memberBodies, memberReads } = session;
    await page.getByRole("button", { name: "Row operations" }).click();
    await page.getByRole("menuitem", { name: "Set member role" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("From the selected row").waitFor();
    // The member is not this row: its id and version are ordinary inputs.
    await dialog.getByRole("textbox", { name: "Id" }).fill("member-1");
    await dialog.getByRole("textbox", { name: "Role" }).fill("owner");
    await dialog.getByRole("spinbutton", { name: "Expected Version" }).fill("7");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByRole("region", { name: "Result" }).waitFor();
    expect(memberBodies).toEqual([{ organizationId: "org-1", id: "member-1", role: "owner", expectedVersion: 7 }]);
    expect(memberReads).toEqual([]);
  } finally {
    await session.close();
  }
}, 30_000);

it("runs a collection operation as an ordinary form", async () => {
  const session = await bootAdmin({ operations: [createSettingOperation()] });
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

it("never retries an uncertain write and refreshes the list after a success", async () => {
  const session = await bootAdmin({ operations: [quotaOperation()], firstAnswer: "lost" });
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
    await dialog.getByText("We could not confirm whether this was saved.", { exact: false }).waitFor();
    expect(quotaBodies).toHaveLength(1);
    expect(await dialog.getByRole("button", { name: "Run", exact: true }).isEnabled()).toBe(false);
    // The lost write did land: the re-read shows the newer version for review.
    await dialog.getByRole("button", { name: "Load latest version" }).click();
    await dialog.getByRole("button", { name: "Review newer version" }).click();
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByRole("region", { name: "Result" }).waitFor();
    expect(quotaBodies[1]).toMatchObject({ expectedVersion: 5, quota: 20 });
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    await dialog.waitFor({ state: "hidden" });
    // The list was refetched, so the next dialog starts from the new version.
    await open();
    await dialog.getByRole("spinbutton").fill("30");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByRole("region", { name: "Result" }).waitFor();
    expect(quotaBodies[2]).toMatchObject({ expectedVersion: 6, quota: 30 });
  } finally { await session.close(); }
}, 30_000);

it("shows a refusal that is not a conflict, with no version reload", async () => {
  const session = await bootAdmin({ operations: [quotaOperation()], conflictCode: "LIFECYCLE_HOOK_REJECTED" });
  try {
    const { page } = session;
    await page.getByRole("button", { name: "Row operations" }).click();
    await page.getByRole("menuitem", { name: "Set quota" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("spinbutton").fill("20");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByText("This operation was refused.").waitFor();
    await dialog.getByText("Rejected", { exact: true }).waitFor();
    expect(await dialog.getByRole("button", { name: "Load latest version" }).count()).toBe(0);
    expect(await dialog.getByRole("spinbutton").inputValue()).toBe("20");
  } finally { await session.close(); }
}, 30_000);

it("keeps the dialog open while a write is in flight, then refreshes the list", async () => {
  const session = await bootAdmin({ operations: [quotaOperation()], entryVersion: 4, hold: true });
  try {
    const { page, quotaBodies, listReads, release } = session;
    await page.getByRole("button", { name: "Row operations" }).click();
    await page.getByRole("menuitem", { name: "Set quota" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("spinbutton").fill("20");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await expect.poll(() => quotaBodies.length).toBe(1);
    // Neither Escape nor Cancel hides a write that may still land.
    await page.keyboard.press("Escape");
    expect(await dialog.isVisible()).toBe(true);
    expect(await dialog.getByRole("button", { name: "Cancel" }).isEnabled()).toBe(false);
    const before = listReads.count;
    release();
    await dialog.getByRole("region", { name: "Result" }).waitFor();
    await page.getByText("Set quota completed.").waitFor();
    await expect.poll(() => listReads.count).toBeGreaterThan(before);
  } finally { await session.close(); }
}, 30_000);

it("shows a CONFLICT on an unlocked operation as a refusal the person can fix", async () => {
  const session = await bootAdmin({ operations: [createSettingOperation()], createConflict: true });
  try {
    const { page, createBodies } = session;
    await page.getByRole("button", { name: "Create setting" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Site Key" }).fill("main");
    await dialog.getByRole("textbox", { name: "Theme" }).fill("light");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByText("Site key 'main' is already taken.").waitFor();
    await dialog.getByRole("textbox", { name: "Site Key" }).fill("second");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByRole("region", { name: "Result" }).waitFor();
    expect(createBodies[1]).toEqual({ siteKey: "second", theme: "light" });
  } finally { await session.close(); }
}, 30_000);

async function bootAdmin(args: { operations: unknown[]; conflictCode?: string; firstAnswer?: "refused" | "lost"; entryVersion?: number; hold?: boolean; createConflict?: boolean }): Promise<{
  page: Page;
  quotaBodies: unknown[];
  memberBodies: unknown[];
  createBodies: unknown[];
  entryReads: string[];
  memberReads: string[];
  listReads: { count: number };
  release: () => void;
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
  const createBodies: unknown[] = [];
  const entryReads: string[] = [];
  const memberReads: string[] = [];
  const listReads = { count: 0 };
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  // The list shows `listed`; the entry itself may be newer.
  const orgVersion = { current: args.entryVersion ?? 4, listed: 4 };
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
        entries: { items: [orgListRow(orgVersion.listed)], previous_cursor: null, next_cursor: null },
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
      listReads.count++;
      return route.fulfill({ json: { items: [orgListRow(orgVersion.listed)], previous_cursor: null, next_cursor: null } });
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
      if (args.hold) await held;
      if (quotaBodies.length === 1 && args.firstAnswer === "lost") {
        // The write lands, but the answer never arrives intact.
        orgVersion.current++;
        return route.fulfill({ status: 502, body: "Bad gateway" });
      }
      if (quotaBodies.length === 1 && (args.conflictCode || args.entryVersion === undefined)) {
        if (!args.conflictCode) orgVersion.current = 5;
        return route.fulfill({
          status: 409,
          json: { ok: false, diagnostic: { code: args.conflictCode ?? "CONFLICT", message: "Rejected" } },
        });
      }
      orgVersion.current++;
      orgVersion.listed = orgVersion.current;
      return route.fulfill({ json: { ok: true, output: { ok: true } } });
    }
    if (path === "/operations/set-member-role" && method === "POST") {
      memberBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, output: { ok: true } } });
    }
    if (path === "/operations/create-setting" && method === "POST") {
      createBodies.push(route.request().postDataJSON());
      if (args.createConflict && createBodies.length === 1) {
        return route.fulfill({ status: 409, json: { ok: false, diagnostic: { code: "CONFLICT", message: "Site key 'main' is already taken." } } });
      }
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
    createBodies,
    entryReads,
    memberReads,
    listReads,
    release,
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

function orgListRow(version = 4) {
  return {
    id: "org-1",
    collection: "organizations",
    locale: null,
    status: "published",
    version,
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
    rowBindings: [{ collection: "organizations", inputField: "organizationId", rowField: "id" }],
    interactions: [{ collection: "organizations", bind: [{ input: "organizationId", field: "id" }], version: "expectedVersion", mutates: true }],
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
    rowBindings: [
      { collection: "organization-members", inputField: "id", rowField: "id" },
      { collection: "organizations", inputField: "organizationId", rowField: "id" },
    ],
    interactions: [
      { collection: "organization-members", bind: [{ input: "id", field: "id" }], version: "expectedVersion", mutates: true },
      { collection: "organizations", bind: [{ input: "organizationId", field: "id" }], mutates: false },
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

function createSettingOperation() {
  return {
    name: "create-setting",
    title: "Create setting",
    description: null,
    triggers: ["mcp"],
    uiSchema: { collectionAction: "organizations" },
    rowBindings: [],
    interactions: [],
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
