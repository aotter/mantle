import { describe, expect, it } from "vitest";
import {
  McpJsonRpcDispatcher,
  type McpUseCases,
} from "../src/infrastructure/mcp/McpJsonRpcDispatcher.js";
import {
  ArchiveUseCase,
  CreateDraftUseCase,
  DeleteEntryUseCase,
  GetEntryUseCase,
  ListEntriesUseCase,
  RequestPublishUseCase,
  UnpublishUseCase,
  UpdateDraftUseCase,
} from "../src/usecase/content/index.js";
import { InvokeProcedureUseCase } from "../src/usecase/procedure/InvokeProcedureUseCase.js";
import { InMemoryHandlerRegistry } from "../src/domain/port/HandlerRegistry.js";
import type { Clock } from "../src/domain/port/Clock.js";
import type { IdGenerator } from "../src/domain/port/IdGenerator.js";
import { TemplateRegistry } from "../src/domain/model/TemplateRegistry.js";
import { InMemoryEntryRepository } from "./fakes/in-memory-store.js";
import { makeProcedure, postsSchema, recentPostsView } from "./fakes/manifests.js";

interface Harness {
  store: InMemoryEntryRepository;
  dispatcher: McpJsonRpcDispatcher;
  publishCalls: string[];
  unpublishCalls: string[];
}

function buildHarness(schemas = [postsSchema()]): Harness {
  const store = new InMemoryEntryRepository();
  const schemasByName = new Map(schemas.map((s) => [s.metadata.name, s]));
  let i = 1;
  const clock: Clock = { now: () => 1_000_000 };
  const idgen: IdGenerator = { next: () => `mcp-${i++}` };
  const publishCalls: string[] = [];
  const unpublishCalls: string[] = [];
  const templates = new TemplateRegistry();
  const effects = {
    templates,
    siteConfig: {
      load: async () => ({
        title: "Test",
        brand: "Test",
        description: "",
        origin: "https://example.com",
        locales: ["en"],
        canonicalLocale: "en",
      }),
    },
    publishOrchestrator: {
      publish: async ({ entryId }: { entryId: string }) => {
        publishCalls.push(entryId);
      },
      unpublish: async ({ entryId }: { entryId: string }) => {
        unpublishCalls.push(entryId);
      },
    },
  };
  const useCases: McpUseCases = {
    listEntries: new ListEntriesUseCase(store, schemasByName),
    getEntry: new GetEntryUseCase(store),
    createDraft: new CreateDraftUseCase(store, schemasByName, clock, idgen),
    updateDraft: new UpdateDraftUseCase(store, schemasByName, clock),
    requestPublish: new RequestPublishUseCase(store, schemasByName, clock, effects),
    unpublish: new UnpublishUseCase(store, schemasByName, clock, effects),
    archive: new ArchiveUseCase(store, schemasByName, clock, effects),
    deleteEntry: new DeleteEntryUseCase(store),
  };
  return {
    store,
    dispatcher: new McpJsonRpcDispatcher(useCases, schemas),
    publishCalls,
    unpublishCalls,
  };
}

/**
 * Build a stripped-down McpUseCases for tests that only exercise the
 * procedure-dispatch / public-surface paths (#281). The CRUD use cases
 * are present (the McpUseCases interface requires them) but the
 * tests never reach them.
 */
function minimalUseCases(): McpUseCases {
  const store = new InMemoryEntryRepository();
  const schemasByName = new Map([["posts", postsSchema()]]);
  const clock: Clock = { now: () => 0 };
  const idgen: IdGenerator = { next: () => "x" };
  const templates = new TemplateRegistry();
  const effects = {
    templates,
    siteConfig: {
      load: async () => ({
        title: "T",
        brand: "T",
        description: "",
        origin: "https://example.com",
        locales: ["en"],
        canonicalLocale: "en",
      }),
    },
    publishOrchestrator: {
      publish: async () => {},
      unpublish: async () => {},
    },
  };
  return {
    listEntries: new ListEntriesUseCase(store, schemasByName),
    getEntry: new GetEntryUseCase(store),
    createDraft: new CreateDraftUseCase(store, schemasByName, clock, idgen),
    updateDraft: new UpdateDraftUseCase(store, schemasByName, clock),
    requestPublish: new RequestPublishUseCase(store, schemasByName, clock, effects),
    unpublish: new UnpublishUseCase(store, schemasByName, clock, effects),
    archive: new ArchiveUseCase(store, schemasByName, clock, effects),
    deleteEntry: new DeleteEntryUseCase(store),
  };
}

function jsonRpcReq(method: string, params?: unknown, id: number | string = 1): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

describe("McpJsonRpcDispatcher", () => {
  it("initialize returns protocol info", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(jsonRpcReq("initialize"), { userId: "u1" });
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-03-26");
  });

  it("tools/list emits generic + per-collection tools", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(jsonRpcReq("tools/list"), { userId: "u1" });
    const body = (await res.json()) as {
      result: { tools: { name: string }[] };
    };
    const names = body.result.tools.map((t) => t.name);
    // Generic read/status tools.
    expect(names).toContain("list_entries");
    expect(names).toContain("get_entry");
    expect(names).toContain("request_publish");
    expect(names).toContain("unpublish_entry");
    expect(names).toContain("archive_entry");
    // Per-collection authoring tools.
    expect(names).toContain("create_draft_posts");
    expect(names).toContain("update_draft_posts");
    // Old generic create_draft is gone.
    expect(names).not.toContain("create_draft");
  });

  it("public surface exposes View query tools, not staff authoring tools", async () => {
    const { dispatcher: _staff, ...h } = buildHarness();
    const dispatcher = new McpJsonRpcDispatcher(
      {
        listEntries: new ListEntriesUseCase(h.store, new Map([["posts", postsSchema()]])),
        getEntry: new GetEntryUseCase(h.store),
        createDraft: new CreateDraftUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }, { next: () => "x" }),
        updateDraft: new UpdateDraftUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        requestPublish: new RequestPublishUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        unpublish: new UnpublishUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        archive: new ArchiveUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        deleteEntry: new DeleteEntryUseCase(h.store),
      },
      [postsSchema()],
      {
        surface: "public",
        views: [recentPostsView()],
      },
    );
    const res = await dispatcher.dispatch(jsonRpcReq("tools/list"), { userId: "u1", staff: null });
    const body = (await res.json()) as {
      result: { tools: { name: string }[] };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toEqual(["query_view_recent_posts"]);
  });

  it("tools/list preserves media x-mcp-hint metadata for agents", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(jsonRpcReq("tools/list"), { userId: "u1" });
    const body = (await res.json()) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: { properties?: Record<string, Record<string, unknown>> };
        }>;
      };
    };
    const createPosts = body.result.tools.find((t) => t.name === "create_draft_posts");
    expect(createPosts?.inputSchema.properties?.coverUrl?.["x-mcp-hint"]).toBe("media-image");
  });

  it("tools/list marks media purpose required and exposes declared purpose enum", async () => {
    const { dispatcher: _unused, ...h } = buildHarness();
    const dispatcher = new McpJsonRpcDispatcher(
      {
        listEntries: new ListEntriesUseCase(h.store, new Map([["posts", postsSchema()]])),
        getEntry: new GetEntryUseCase(h.store),
        createDraft: new CreateDraftUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }, { next: () => "x" }),
        updateDraft: new UpdateDraftUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        requestPublish: new RequestPublishUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        unpublish: new UnpublishUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        archive: new ArchiveUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        deleteEntry: new DeleteEntryUseCase(h.store),
        media: {
          createUpload: { execute: async () => ({}) } as never,
          commitUpload: { execute: async () => ({}) } as never,
          purposes: [
            {
              name: "post-cover",
              required: ["image/avif", "image/webp", "image/jpeg"],
              maxBytes: {
                "image/avif": 200_000,
                "image/webp": 300_000,
                "image/jpeg": 500_000,
              },
            },
            {
              name: "product-gallery",
              required: ["image/avif", "image/webp", "image/jpeg"],
              maxBytes: {
                "image/avif": 250_000,
                "image/webp": 400_000,
                "image/jpeg": 600_000,
              },
            },
          ],
        },
      },
      [postsSchema()],
    );
    const res = await dispatcher.dispatch(jsonRpcReq("tools/list"), { userId: "u1" });
    const body = (await res.json()) as {
      result: {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: {
            required?: string[];
            properties?: Record<string, Record<string, unknown>>;
          };
        }>;
      };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("create_media_upload");
    expect(names).toContain("commit_media_upload");
    expect(names).not.toContain("upload_media_variant");
    const mediaTool = body.result.tools.find((t) => t.name === "create_media_upload");
    expect(mediaTool?.inputSchema.required).toContain("purpose");
    expect(mediaTool?.inputSchema.properties?.purpose?.enum).toEqual([
      "post-cover",
      "product-gallery",
    ]);
    expect(mediaTool?.description).toContain("image in chat");
    expect(mediaTool?.description).toContain("Do not ask the user to open a terminal");
    expect(mediaTool?.description).toContain("transparent PNG");
    expect(mediaTool?.description).toContain("animated GIFs must stay animated");
    expect(mediaTool?.description).toContain("does not expose a base64 upload tool");
    expect(mediaTool?.description).toContain("already-installed dependency");
    expect(mediaTool?.description).toContain("install a standard image processing package");
    expect(mediaTool?.description).toContain("Node agents should prefer sharp");
    expect(mediaTool?.description).toContain("Python agents should prefer Pillow");
    expect(mediaTool?.description).toContain("reusable agent memory or skills");
    expect(mediaTool?.description).not.toContain("mantle-media-tools");
  });

  it("tools/call create_draft_posts creates an entry through the use case", async () => {
    const { dispatcher, store } = buildHarness();
    const res = await dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "create_draft_posts",
        // Per-collection tool: agent sends Schema fields at top level
        // (no `{ data: ... }` wrapper).
        arguments: { title: "From MCP" },
      }),
      { userId: "u1" },
    );
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const created = JSON.parse(body.result.content[0]!.text) as { id: string };
    expect(await store.get(created.id)).toMatchObject({
      data: { title: "From MCP" },
      authorId: "u1",
    });
  });

  it("tools/call request_publish flips draft → published", async () => {
    const { dispatcher, store, publishCalls } = buildHarness();
    const created = await store.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: { title: "x" },
      authorId: "u1",
      now: 0,
    });
    const res = await dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "request_publish",
        arguments: { id: created.id },
      }),
      { userId: "u1" },
    );
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const result = JSON.parse(body.result.content[0]!.text) as { status: string };
    expect(result.status).toBe("published");
    expect(publishCalls).toEqual([created.id]);
  });

  it("tools/call unpublish_entry flips published → draft", async () => {
    const { dispatcher, store, unpublishCalls } = buildHarness();
    const created = await store.create({
      id: "p1",
      collection: "posts",
      status: "published",
      data: { title: "x" },
      authorId: "u1",
      now: 0,
    });
    const res = await dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "unpublish_entry",
        arguments: { id: created.id },
      }),
      { userId: "u1" },
    );
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const result = JSON.parse(body.result.content[0]!.text) as { status: string };
    expect(result.status).toBe("draft");
    expect(unpublishCalls).toEqual([created.id]);
  });

  it("tools/call request_publish rejects orphan translated children", async () => {
    const { dispatcher } = buildHarness(translatedSchemas());
    const createdRes = await dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "create_draft_post_translations",
        arguments: { slug: "ghost", locale: "en", title: "Ghost", body: "Missing parent" },
      }),
      { userId: "u1" },
    );
    const createdBody = (await createdRes.json()) as { result: { content: { text: string }[] } };
    const created = JSON.parse(createdBody.result.content[0]!.text) as { id: string };

    const publishRes = await dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "request_publish",
        arguments: { id: created.id },
      }),
      { userId: "u1" },
    );
    const body = (await publishRes.json()) as {
      error: { code: number; data: { code: string; value: Record<string, unknown> } };
    };
    expect(body.error.code).toBe(-32000);
    expect(body.error.data.code).toBe("TRANSLATES_PARENT_UNKNOWN");
    expect(body.error.data.value).toMatchObject({
      child: "post-translations",
      parent: "posts",
      field: "slug",
      value: "ghost",
    });
  });

  it("unknown tool returns -32601", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "ghost_tool", arguments: {} }),
      { userId: "u1" },
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it("create_draft_<unknown> returns -32601 unknown tool", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "create_draft_ghost",
        arguments: {},
      }),
      { userId: "u1" },
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it("Procedure-MCP trigger: tool appears in tools/list and tools/call invokes the Procedure (#281)", async () => {
    const procedure = makeProcedure({ name: "restock-sku" });
    const registry = new InMemoryHandlerRegistry();
    const calls: Array<{ msg: string; userId: string | undefined; role: string | null }> = [];
    registry.register("echoHandler", (input, ctx) => {
      calls.push({ msg: (input as { msg: string }).msg, userId: ctx.user?.id, role: ctx.staff?.role ?? null });
      return { ok: true };
    });
    const invokeProcedure = new InvokeProcedureUseCase(registry);
    const dispatcher = new McpJsonRpcDispatcher(
      { ...minimalUseCases(), invokeProcedure },
      [],
      { surface: "staff", procedures: [procedure] },
    );
    const list = (await (
      await dispatcher.dispatch(jsonRpcReq("tools/list"), { userId: "u1" })
    ).json()) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toContain("restock_sku");

    const callRes = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "restock_sku", arguments: { msg: "hi" } }),
      { userId: "u1", staff: { userId: "u1", role: "owner" } },
    );
    const body = (await callRes.json()) as {
      result?: { content: { text: string }[] };
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    const inner = JSON.parse(body.result!.content[0]!.text) as {
      ok: boolean;
      data?: { ok: boolean };
    };
    expect(inner.ok).toBe(true);
    expect(calls).toEqual([{ msg: "hi", userId: "u1", role: "owner" }]);
  });

  it("Procedure-MCP trigger on public surface: tool appears alongside Views, not staff tools (#281)", async () => {
    const procedure = makeProcedure({ name: "lookup-price" });
    const registry = new InMemoryHandlerRegistry();
    registry.register("echoHandler", () => ({ ok: true }));
    const invokeProcedure = new InvokeProcedureUseCase(registry);
    const dispatcher = new McpJsonRpcDispatcher(
      { ...minimalUseCases(), invokeProcedure },
      [postsSchema()],
      {
        surface: "public",
        views: [recentPostsView()],
        procedures: [procedure],
      },
    );
    const list = (await (
      await dispatcher.dispatch(jsonRpcReq("tools/list"), { userId: "u1" })
    ).json()) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toContain("lookup_price");
    expect(names).toContain("query_view_recent_posts");
    expect(names).not.toContain("create_draft_posts");
    expect(names).not.toContain("list_entries");
  });

  it("Procedure-MCP trigger: requires.auth.all enforces the predicate, returning AUTH_DENIED for missing staff (#281)", async () => {
    const procedure = makeProcedure({
      name: "restock-sku",
      authPredicates: [{ "ctx.staff": ["owner"] }],
    });
    const registry = new InMemoryHandlerRegistry();
    registry.register("echoHandler", () => ({ ok: true }));
    const dispatcher = new McpJsonRpcDispatcher(
      { ...minimalUseCases(), invokeProcedure: new InvokeProcedureUseCase(registry) },
      [],
      { surface: "staff", procedures: [procedure] },
    );
    // Bearer authenticated but no staff role: invokeProcedure returns
    // AUTH_DENIED, which the dispatcher wraps in the JSON-RPC result
    // (not as a -32000 error — the use case's `{ok: false}` IS the
    // payload, same shape as builtin op denials).
    const res = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "restock_sku", arguments: { msg: "x" } }),
      { userId: "u1", staff: null },
    );
    const body = (await res.json()) as {
      result?: { content: { text: string }[] };
    };
    const inner = JSON.parse(body.result!.content[0]!.text) as {
      ok: boolean;
      diagnostic?: { code: string };
    };
    expect(inner.ok).toBe(false);
    expect(inner.diagnostic?.code).toBe("AUTH_DENIED");
  });

  it("Procedure-MCP trigger does not shadow public-surface View routing when names don't match (#281)", async () => {
    // Procedures are checked first on every surface, but a non-match
    // must fall through to the existing routing — View tool calls
    // must still dispatch to executeView even when procedures are
    // configured on the dispatcher.
    const procedure = makeProcedure({ name: "restock-sku" });
    const executeViewCalls: Array<{ pathPrefix?: string }> = [];
    const fakeExecuteView = {
      execute: async (req: { pathPrefix?: string }) => {
        executeViewCalls.push({ pathPrefix: req.pathPrefix });
        return { ok: true, result: { rows: [], page: 1, show: 25, hasMore: false } };
      },
    } as unknown as McpUseCases["executeView"];
    const dispatcher = new McpJsonRpcDispatcher(
      {
        ...minimalUseCases(),
        executeView: fakeExecuteView,
        invokeProcedure: new InvokeProcedureUseCase(new InMemoryHandlerRegistry()),
      },
      [postsSchema()],
      {
        surface: "public",
        views: [recentPostsView()],
        procedures: [procedure],
      },
    );
    const res = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "query_view_recent_posts", arguments: {} }),
      { userId: "u1" },
    );
    const body = (await res.json()) as {
      result?: { content: { text: string }[] };
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    // executeView must have been invoked — proves the procedure-first
    // check correctly fell through instead of short-circuiting as
    // UNKNOWN_TOOL.
    expect(executeViewCalls).toHaveLength(1);
    expect(executeViewCalls[0]?.pathPrefix).toMatch(/^MCP query_view_recent_posts$/);
    const inner = JSON.parse(body.result!.content[0]!.text) as {
      ok: boolean;
      result?: { rows: unknown[] };
    };
    expect(inner.ok).toBe(true);
  });

  it("Procedure-MCP trigger on public surface still enforces requires.auth.all: ctx.staff (#281)", async () => {
    // A Procedure surfaced as public-MCP but auth-gated on ctx.staff
    // can still be invoked by a staff bearer (and is denied for
    // bearer-only callers). This pins the contract that surface
    // discriminates DISCOVERY, not auth — auth always evaluates the
    // McpAuthContext via the use case.
    const procedure = makeProcedure({
      name: "lookup-price",
      authPredicates: [{ "ctx.staff": ["owner"] }],
    });
    const registry = new InMemoryHandlerRegistry();
    let calls = 0;
    registry.register("echoHandler", () => {
      calls++;
      return { ok: true };
    });
    const dispatcher = new McpJsonRpcDispatcher(
      { ...minimalUseCases(), invokeProcedure: new InvokeProcedureUseCase(registry) },
      [],
      { surface: "public", procedures: [procedure] },
    );

    // Bearer without staff: denied.
    const deniedRes = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "lookup_price", arguments: { msg: "x" } }),
      { userId: "u1", staff: null },
    );
    const denied = (await deniedRes.json()) as { result: { content: { text: string }[] } };
    const deniedInner = JSON.parse(denied.result.content[0]!.text) as {
      ok: boolean;
      diagnostic?: { code: string };
    };
    expect(deniedInner.diagnostic?.code).toBe("AUTH_DENIED");
    expect(calls).toBe(0);

    // Bearer with staff: allowed (handler runs).
    const allowedRes = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "lookup_price", arguments: { msg: "x" } }, 2),
      { userId: "u1", staff: { userId: "u1", role: "owner" } },
    );
    const allowed = (await allowedRes.json()) as { result: { content: { text: string }[] } };
    const allowedInner = JSON.parse(allowed.result.content[0]!.text) as {
      ok: boolean;
      data?: unknown;
    };
    expect(allowedInner.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("Procedure tool name uses kebab→snake mangling (#281)", async () => {
    const procedure = makeProcedure({ name: "snapshot-inventory" });
    const dispatcher = new McpJsonRpcDispatcher(
      {
        ...minimalUseCases(),
        invokeProcedure: new InvokeProcedureUseCase(new InMemoryHandlerRegistry()),
      },
      [],
      { surface: "staff", procedures: [procedure] },
    );
    const list = (await (
      await dispatcher.dispatch(jsonRpcReq("tools/list"), { userId: "u1" })
    ).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toContain("snapshot_inventory");
  });

  it("rejects non-POST methods", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(
      new Request("https://example.com/mcp", { method: "PUT" }),
      { userId: "u1" },
    );
    expect(res.status).toBe(405);
  });
});

function translatedSchemas() {
  const parent = postsSchema();
  return [
    parent,
    {
      apiVersion: "cms.mantle.aotter.net/v1" as const,
      kind: "Schema" as const,
      metadata: { name: "post-translations" },
      spec: {
        title: "Post translations",
        localized: true,
        translates: { parent: "posts", on: "slug" },
        schema: {
          type: "object" as const,
          properties: {
            slug: { type: "string" as const },
            locale: { type: "string" as const },
            title: { type: "string" as const },
            body: { type: "string" as const },
          },
          required: ["slug", "locale", "title", "body"],
        },
        lifecycle: "simple" as const,
      },
    },
  ];
}
