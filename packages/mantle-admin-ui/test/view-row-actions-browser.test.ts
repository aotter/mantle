import { expect, it } from "vitest";
import { chromium } from "playwright";
import { createServer } from "vite";
import { resolve } from "node:path";

/** ADR-0029: a View row runs its staff operation through the shared controller over staff MCP. */
it("runs a View row action with the reviewed version and asks for a review when the entry moved", async () => {
  const server = await createServer({ configFile: resolve("vite.config.ts"), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    await page.addInitScript(() => { localStorage.setItem("cms.preference.language", "en"); history.replaceState(null, "", "/admin/views/pending"); });
    let readVersion = 3;
    let viewFetches = 0;
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await page.route("**/admin/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace("/admin/api", "");
      if (path === "/mcp") {
        if (route.request().method() !== "POST") return route.fulfill({ status: 405 });
        const message = route.request().postDataJSON() as { id?: number; method: string; params?: { protocolVersion?: string; name: string; arguments: Record<string, unknown> } };
        if (message.id === undefined) return route.fulfill({ status: 202 });
        if (message.method === "initialize") return route.fulfill({ json: { jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" },
        } } });
        const call = message.params!;
        calls.push({ name: call.name, arguments: call.arguments });
        const data = call.name === "read_entry"
          ? { id: "r1", collection: "requisitions", version: readVersion, data: { item: readVersion > 3 ? "Laptops ×2" : "Laptops", requestStatus: "submitted" } }
          : { id: "r1", version: readVersion + 1 };
        return route.fulfill({ json: { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } } });
      }
      const json = path === "/me" ? { id: "owner", role: "owner", login: "owner", image: null }
        : path === "/site" ? { brand: "Procurement", icons: [], canonicalLocale: "en" }
        : path === "/collections" ? { collections: [] }
        : path === "/operations" ? { operations: [{
          name: "review-requisition",
          title: "Review requisition",
          description: null,
          uiSchema: null,
          triggers: ["mcp"],
          rowBindings: [],
          input: { type: "object", required: ["id", "expectedVersion"], properties: {
            id: { type: "string" }, expectedVersion: { type: "number" }, reviewerNote: { type: "string", title: "Reviewer note" },
          } },
        }] }
        : path === "/views-manifest" ? { views: [{
          name: "pending", title: "Pending approvals", surface: "staff", from: "requisitions",
          params: { type: "object", properties: { q: { type: "string" } } },
          fields: ["id", "version", "item"], list: { columns: ["item"], searchFields: [], filterFields: [] },
          rowActions: [{ capability: "review_requisition", procedure: "review-requisition", bind: [{ input: "id", field: "id" }], version: "expectedVersion", mutates: true }],
        }] }
        : path === "/views/pending" ? (viewFetches++, { ok: true, data: { rows: [{ id: "r1", version: readVersion, item: "Laptops" }], page: 1, show: 50, hasMore: false } })
        : {};
      return route.fulfill({ json });
    });
    await page.goto(new URL("/_mantle/admin/", server.resolvedUrls!.local[0]!).href);
    await page.getByRole("cell", { name: "Laptops" }).waitFor();

    await page.getByRole("button", { name: "Row actions" }).click();
    await page.getByRole("menuitem", { name: "Review requisition" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("From the selected row").waitFor();
    await dialog.getByRole("textbox").fill("Within budget");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    readVersion = 4;
    await dialog.getByText("Done.", { exact: true }).waitFor();
    expect(calls.map(({ name }) => name)).toEqual(["read_entry", "review_requisition"]);
    // The list refreshes once and the finished dialog stays finished, even
    // though the refreshed row carries a new version.
    const fetchesAfterDone = viewFetches;
    await page.waitForTimeout(800);
    expect(viewFetches - fetchesAfterDone).toBeLessThanOrEqual(1);
    expect(await dialog.getByText("Done.", { exact: true }).isVisible()).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.arguments).toEqual({ id: "r1", expectedVersion: 3, reviewerNote: "Within budget" });
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await dialog.waitFor({ state: "hidden" });

    // Cancel closes the dialog.
    await page.getByRole("button", { name: "Row actions" }).click();
    await page.getByRole("menuitem", { name: "Review requisition" }).click();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });

    // Someone else moved the entry: the reviewed version is never swapped silently.
    readVersion = 5;
    await page.getByRole("button", { name: "Row actions" }).click();
    await page.getByRole("menuitem", { name: "Review requisition" }).click();
    await dialog.getByRole("status").getByText("Someone changed this entry after you opened it.", { exact: false }).waitFor();
    await dialog.getByRole("table", { name: "What changed" }).waitFor();
    expect(await dialog.getByRole("button", { name: "Run", exact: true }).isDisabled()).toBe(true);
    await dialog.getByRole("button", { name: "Review newer version" }).click();
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByText("Done.", { exact: true }).waitFor();
    expect(calls[calls.length - 1]!.arguments).toMatchObject({ id: "r1", expectedVersion: 5 });
  } finally { await browser.close(); await server.close(); }
}, 40_000);
