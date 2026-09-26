/**
 * ADR-0029 D10: staff preview an entry's site page over MCP with the same
 * renderer as `?preview=1`, authorized by the MCP caller, never by a staff
 * cookie. The HTML travels in that call's result only.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Manifest } from "@aotter/mantle-spec";
import { TemplateRegistry } from "@aotter/mantle-web";
import { createMantleRuntimeRef } from "../src/mount/bootRuntimeOnce.js";
import { createMcpApiHandler } from "../src/mount/mountMcp.js";
import { mountPublicRoutes } from "../src/mount/mountPublicRoutes.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import { compileTestPlan } from "./compileTestPlan.js";
import { StubAssetServer, stubAuth } from "./fakes/runtime-bindings.js";
import { MCP_HEADERS, readJsonRpc } from "./mcpWire.js";
import type { MantleMcpApps } from "@aotter/mantle-mcp";

const RESOURCE = "https://example.test/mcp";
const UI = { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } };
// The built-in App resource lists the preview as App-only, as this one does.
const APPS: MantleMcpApps = {
  resources: [{ uri: "ui://test/app", name: "app", html: "<!doctype html>", renders: (capability) => capability.route.kind === "view", appOnly: ["preview_entry"] }],
};

const manifests: Manifest[] = [{
  apiVersion: "cms.mantle.aotter.net/v1",
  kind: "Schema",
  metadata: { name: "posts" },
  spec: {
    title: "Posts",
    localized: true,
    lifecycle: "publishing",
    schema: {
      type: "object",
      properties: { slug: { type: "string" }, locale: { type: "string" }, title: { type: "string" } },
      required: ["slug", "locale", "title"],
    },
  },
}];

function harness(options: { publicRoutes?: boolean; apps?: boolean; slugOverride?: boolean } = {}) {
  const db = new InMemoryDatabase();
  const templates = new TemplateRegistry();
  templates.registerEntryTemplate("posts", ({ entry }) => `<html><body><h1>${String(entry.data["title"])}</h1></body></html>`);
  const ref = createMantleRuntimeRef({
    plan: compileTestPlan(manifests),
    templates,
    siteDefaults: { title: "Blog", brand: "Blog", origin: "https://example.com", locales: ["en"] },
    bindings: { db, adminAssets: new StubAssetServer() },
    auth: {
      ...stubAuth,
      getUserRole: async () => "editor",
      verifyOAuthAccessToken: async (_request: Request, { audience }: { audience: string }) => audience === RESOURCE
        ? { ok: true as const, userId: "editor-1", clientId: "agent", credentialId: "t1", scopes: ["mcp"] }
        : { ok: false as const, status: 401 as const, reason: "invalid-token" },
    },
  });
  // Built before public routes are mounted, as createMantleWorker does: an
  // App-only preview must not fail construction.
  const apps = options.apps === false ? {} : { apps: APPS };
  const staff = createMcpApiHandler({ ref, surface: "staff", resource: RESOURCE, ...apps });
  const pub = createMcpApiHandler({ ref, surface: "public", resource: RESOURCE, ...apps });
  if (options.publicRoutes !== false) {
    mountPublicRoutes(new Hono(), ref, {
      collectionRoutes: [{ collection: "posts", segment: "posts" }],
      notFoundRenderer: async () => new Response("missing", { status: 404 }),
      ...(options.slugOverride ? { slugOverrides: [{ collection: "posts", slug: "custom", render: async () => new Response("custom") }] } : {}),
    });
  }
  const row = (id: string, status: string, title: string, updated: number) => db.entries.set(id, {
    id, collection: "posts", status, version: 1,
    data: JSON.stringify({ slug: "hello", locale: "en", title }),
    author_id: null, created_at: 1, updated_at: updated,
  });
  row("p1", "published", "Hello", 2);
  row("d1", "draft", "Draft wins", 3);
  db.entries.set("c1", {
    id: "c1", collection: "posts", status: "draft", version: 1,
    data: JSON.stringify({ slug: "custom", locale: "en", title: "Custom" }),
    author_id: null, created_at: 1, updated_at: 1,
  });
  const call = async (handler: typeof staff, method: string, params?: unknown, token = "mcp-token", ui = true) => {
    const response = await handler.fetch!(new Request(`${RESOURCE}/staff`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(method === "tools/call" ? { "mcp-name": String((params as { name?: unknown }).name) } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {
        ...(params as object | undefined),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": ui ? { extensions: UI } : {},
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
        },
      } }),
    }), {}, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    return response;
  };
  return { staff, pub, call };
}

type Tools = { result: { tools: { name: string; inputSchema: unknown; annotations?: unknown; _meta?: unknown }[] } };
type Called = { result: { structuredContent?: { html: string }; content: { text: string }[]; isError?: boolean } };

describe("preview_entry (ADR-0029 D10)", () => {
  it("renders exactly the requested entry, drafts included, for the App only, and never caches it", async () => {
    const { staff, call } = harness();
    const listed = await readJsonRpc<Tools>(await call(staff, "tools/list"));
    const tool = listed.result.tools.find(({ name }) => name === "preview_entry");
    expect(tool).toMatchObject({
      inputSchema: { properties: { collection: { enum: ["posts"] } } },
      annotations: { readOnlyHint: true },
      _meta: { ui: { visibility: ["app"] } },
    });

    const draft = await call(staff, "tools/call", { name: "preview_entry", arguments: { collection: "posts", id: "d1" } });
    expect(draft.headers.get("cache-control")).toMatch(/no-store/u);
    const body = await readJsonRpc<Called>(draft);
    expect(body.result.structuredContent?.html).toContain("Draft wins");
    // The model-facing text says what was rendered and carries none of the page.
    expect(body.result.content[0]!.text).not.toContain("Draft wins");
    // Relative links and assets resolve against the site, as on the page itself.
    expect(body.result.structuredContent?.html).toContain('<base href="https://example.com/">');
    const published = await readJsonRpc<Called>(
      await call(staff, "tools/call", { name: "preview_entry", arguments: { collection: "posts", id: "p1" } }));
    expect(published.result.structuredContent?.html).toContain("Hello");
  });

  it("is staff-only, needs a caller, and exists only with a site renderer and an App", async () => {
    const { staff, pub, call } = harness();
    const names = async (handler: typeof staff, ui = true, target = call) =>
      (await readJsonRpc<Tools>(await target(handler, "tools/list", undefined, "mcp-token", ui))).result.tools.map(({ name }) => name);
    expect(await names(pub)).not.toContain("preview_entry");
    expect(await names(staff, false)).not.toContain("preview_entry");
    const anonymous = await call(staff, "tools/call", { name: "preview_entry", arguments: { collection: "posts", id: "d1" } }, "");
    expect(anonymous.status).toBe(401);

    const bare = harness({ publicRoutes: false });
    expect(await names(bare.staff, true, bare.call)).not.toContain("preview_entry");
    const withoutApp = harness({ apps: false });
    expect(await names(withoutApp.staff, true, withoutApp.call)).not.toContain("preview_entry");
  });

  it("refuses collections it does not render, missing entries and slug overrides", async () => {
    const { staff, call } = harness({ slugOverride: true });
    const refused = async (args: Record<string, unknown>) =>
      (await readJsonRpc<Called>(await call(staff, "tools/call", { name: "preview_entry", arguments: args }))).result;
    expect(await refused({ collection: "secrets", id: "d1" })).toMatchObject({ isError: true });
    expect(await refused({ collection: "posts", id: "missing" })).toMatchObject({ isError: true });
    // A slug override has its own page for a request; there is no request here.
    const custom = await refused({ collection: "posts", id: "c1" });
    expect(custom.isError).toBe(true);
    expect(custom.content[0]!.text).toContain("NOT_FOUND");
  });
});
