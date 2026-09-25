import { resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { bindCapabilities, compileRuntimePlan, type CapabilityRuntime, type HandlerContext, type RuntimePlan } from "@aotter/mantle-runtime";
import { createMantleMcpHandler } from "@aotter/mantle-mcp";
import { chromium } from "playwright";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";
// The built App, exactly as it is published (run `pnpm run build` first).
import { interactionAppResource } from "../dist/mcp-app/index.js";

/**
 * #1119 CI host matrix: the published MCP App in a host built on the
 * official `ext-apps` AppBridge (the basic-host shape), against a real
 * Mantle MCP handler; and the same flow through the official client with
 * no UI. Example A: a staff member reviews a pending requisition.
 */

const manifest = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: requisitions }
spec:
  title: Requisitions
  lifecycle: operational
  schema:
    type: object
    properties:
      item: { type: string }
      requestStatus: { type: string }
      reviewerNote: { type: string }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: pending-approvals }
spec:
  surface: staff
  from: requisitions
  fields: [id, version, item, requestStatus]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: review-requisition }
spec:
  title: Review requisition
  description: Approve or reject one requisition.
  requires: { auth: { all: [{ ctx.staff: [owner, editor] }] } }
  input:
    type: object
    required: [id, expectedVersion, requestStatus]
    properties:
      id: { type: string }
      expectedVersion: { type: number }
      requestStatus: { type: string, enum: [approved, rejected], title: Decision }
      reviewerNote: { type: string, title: Reviewer note }
  output: { type: object }
  handler: { kind: ref, ref: reviewRequisition }
  target: { schema: requisitions, id: id, version: expectedVersion }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: review-requisition-mcp }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: review-requisition }
`;

interface Entry { id: string; version: number; data: Record<string, unknown> }

function harness() {
  const plan = compile(manifest);
  const entries = new Map<string, Entry>([["r1", { id: "r1", version: 3, data: { item: "Laptops", requestStatus: "submitted" } }]]);
  const writes: Record<string, unknown>[] = [];
  const runtime = {
    schemas: new Map(Object.values(plan.schemas).map(({ manifest: schema }) => [schema.metadata.name, schema])),
    getEntry: { execute: async ({ id }: { id: string }) => ({ ...entries.get(id)!, collection: "requisitions" }) },
    executeView: async () => ({
      ok: true,
      result: { rows: [...entries.values()].map((entry) => ({ id: entry.id, version: entry.version, ...entry.data })), page: 1, show: 20, hasMore: false },
    }),
    invokeTrigger: async ({ input }: { input: Record<string, unknown> }) => {
        const entry = entries.get(String(input["id"]))!;
        if (input["expectedVersion"] !== entry.version) {
          return { ok: false, diagnostic: { code: "CONFLICT", phase: "runtime", severity: "error", path: "MCP review_requisition", message: "This requisition changed." } };
        }
        writes.push(input);
        entry.version += 1;
        entry.data = { ...entry.data, requestStatus: input["requestStatus"], reviewerNote: input["reviewerNote"] };
        return { ok: true, data: { id: entry.id, version: entry.version } };
    },
    media: null,
  } as unknown as CapabilityRuntime;
  const invoker = bindCapabilities(runtime, plan, { surface: "staff" });
  const handler = createMantleMcpHandler(invoker, { apps: { resources: [interactionAppResource()] } });
  const staff: HandlerContext = { user: { id: "s1" }, staff: { id: "s1", role: "editor" }, env: {} } as HandlerContext;
  return { handler, entries, writes, staff };
}

describe("MCP Apps host matrix (#1119)", () => {
  it("runs example A in an official AppBridge host: rows, review, conflict keeps input", async () => {
    const { handler, entries, writes, staff } = harness();
    const server = await createServer({
      root: resolve(import.meta.dirname, "host"),
      configFile: false,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      const toolCalls: string[] = [];
      await page.route("**/mcp", async (route) => {
        const request = route.request();
        const body = request.method() === "POST" ? JSON.parse(request.postData() ?? "null") as { method?: string; params?: { name?: string } } : null;
        if (body?.method === "tools/call" && body.params?.name) toolCalls.push(body.params.name);
        const response = await handler.fetch(new Request(request.url(), {
          method: request.method(),
          headers: request.headers(),
          ...(request.method() === "POST" ? { body: request.postData() ?? "" } : {}),
        }), staff);
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
      });
      await page.goto(new URL("/index.html?tool=query_view_pending_approvals", server.resolvedUrls!.local[0]!).href);
      await page.getByText("result delivered").waitFor();
      const app = page.frameLocator("#app");
      await app.getByText("Laptops").waitFor();

      await app.getByRole("button", { name: "Review requisition" }).click();
      await app.getByText("From the selected row").waitFor();
      await app.getByLabel("Decision").selectOption("approved");
      await app.getByLabel("Reviewer note").fill("Within budget");
      await app.getByRole("button", { name: "Run", exact: true }).click();
      await app.getByText("Done.", { exact: true }).waitFor();
      expect(writes).toEqual([{ id: "r1", expectedVersion: 3, requestStatus: "approved", reviewerNote: "Within budget" }]);
      // The host's own View call, then the App's read, write and refresh.
      // The refresh follows the success asynchronously.
      await expect.poll(() => toolCalls).toEqual(["query_view_pending_approvals", "read_entry", "review_requisition", "query_view_pending_approvals"]);
      await app.getByRole("button", { name: "Close", exact: true }).click();

      // Someone else decides between the read and the submit.
      await app.getByRole("button", { name: "Review requisition" }).click();
      await app.getByText("From the selected row").waitFor();
      await app.getByLabel("Decision").selectOption("rejected");
      entries.get("r1")!.version = 9;
      await app.getByRole("button", { name: "Run", exact: true }).click();
      await app.getByText("This entry changed before your update was saved.", { exact: false }).waitFor();
      expect(await app.getByLabel("Decision").inputValue()).toBe("rejected");
      expect(writes).toHaveLength(1);

      // The host's theme and locale reach the App.
      await page.goto(new URL("/index.html?tool=query_view_pending_approvals&theme=dark&locale=zh-TW", server.resolvedUrls!.local[0]!).href);
      await page.getByText("result delivered").waitFor();
      await app.getByRole("button", { name: "Review requisition" }).click();
      await app.getByText("來自選取的資料列").waitFor();
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
      expect(await frame.evaluate(() => [document.documentElement.lang, getComputedStyle(document.body).backgroundColor]))
        .toEqual(["zh-TW", "rgb(24, 24, 27)"]);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 60_000);

  it("runs the same flow with the official client and no UI, and shows the conflict to the model", async () => {
    const { handler, staff } = harness();
    const client = new Client({ name: "plain", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new StreamableHTTPClientTransport(new URL("https://example.test/mcp"), {
      fetch: async (input: string | URL | Request, init?: RequestInit) => handler.fetch(new Request(input, init), staff),
    }));
    const { tools } = await client.listTools();
    const view = tools.find(({ name }) => name === "query_view_pending_approvals")!;
    expect(view._meta?.["ui"]).toBeUndefined();
    expect(view.description).toContain("Row actions: review_requisition (id = row.id, expectedVersion = row.version).");
    const listed = await client.callTool({ name: view.name, arguments: {} });
    expect(listed._meta?.["net.aotter.mantle/interaction"]).toBeUndefined();
    const [row] = (listed.structuredContent as { rows: { id: string; version: number }[] }).rows;
    const done = await client.callTool({ name: "review_requisition", arguments: { id: row!.id, expectedVersion: row!.version, requestStatus: "approved" } });
    expect(done.isError).toBeFalsy();
    const stale = await client.callTool({ name: "review_requisition", arguments: { id: row!.id, expectedVersion: row!.version, requestStatus: "rejected" } });
    expect(stale.isError).toBe(true);
    expect(JSON.parse((stale.content as { text: string }[])[0]!.text)).toMatchObject({ diagnostics: [{ code: "CONFLICT" }] });
  });
});

function compile(text: string): RuntimePlan {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:host", text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(compiled.diagnostics.map((item) => item.message).join("\n"));
  return compiled.value;
}
