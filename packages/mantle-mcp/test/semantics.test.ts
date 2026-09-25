import { DiagnosticError, runtimeDiagnostic } from "@aotter/mantle-spec";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import {
  buildMcpToolCatalog,
  McpJsonRpcDispatcher,
  MCP_PROTOCOL_VERSION,
  type McpUseCases,
} from "./dispatcherShim.js";
import {
  ArchiveUseCase,
  CreateDraftUseCase,
  DeleteEntryUseCase,
  GetEntryUseCase,
  RequestPublishUseCase,
  UnpublishUseCase,
  UpdateDraftUseCase,
} from "../../mantle-runtime/src/usecase/content/index.js";
import { InvokeProcedureUseCase } from "../../mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.js";
import { InMemoryHandlerRegistry } from "../../mantle-runtime/src/domain/port/HandlerRegistry.js";
import type { HandlerContext } from "../../mantle-runtime/src/domain/model/HandlerContext.js";
import type { Clock } from "../../mantle-runtime/src/domain/port/Clock.js";
import type { IdGenerator } from "../../mantle-runtime/src/domain/port/IdGenerator.js";
import type {
  DeferredHookDispatcher,
  DeferredHookEnvelope,
} from "../../mantle-runtime/src/domain/port/DeferredHookDispatcher.js";
import { TriggerIndex } from "../../mantle-runtime/src/domain/service/TriggerIndex.js";
import type {
  ProcedureCallableCapability,
  ViewCallableCapability,
} from "../../mantle-runtime/src/domain/service/CallableCapabilityProjector.js";
import { LifecycleHookingEntryRepository } from "../../mantle-runtime/src/infrastructure/persistence/LifecycleHookingEntryRepository.js";
import { RunLifecycleHooksUseCase } from "../../mantle-runtime/src/usecase/lifecycle/RunLifecycleHooksUseCase.js";
import { InMemoryEntryRepository } from "../../mantle-runtime/test/fakes/in-memory-store.js";
import {
  makeLifecycleTrigger,
  makeProcedure,
  postsSchema,
  recentPostsView,
} from "../../mantle-runtime/test/fakes/manifests.js";

interface Harness {
  store: InMemoryEntryRepository;
  dispatcher: McpJsonRpcDispatcher;
}

function buildHarness(schemas = [postsSchema()]): Harness {
  const store = new InMemoryEntryRepository();
  const schemasByName = new Map(schemas.map((s) => [s.metadata.name, s]));
  let i = 1;
  const clock: Clock = { now: () => 1_000_000 };
  const idgen: IdGenerator = { next: () => `mcp-${i++}` };
  const useCases: McpUseCases = {
    getEntry: new GetEntryUseCase(store),
    createDraft: new CreateDraftUseCase(store, schemasByName, clock, idgen),
    updateDraft: new UpdateDraftUseCase(store, schemasByName, clock),
    requestPublish: new RequestPublishUseCase(store, schemasByName, clock),
    unpublish: new UnpublishUseCase(store, schemasByName, clock),
    archive: new ArchiveUseCase(store, schemasByName, clock),
    deleteEntry: new DeleteEntryUseCase(store, schemasByName),
  };
  return {
    getEntry: new GetEntryUseCase(store),
    store,
    dispatcher: new McpJsonRpcDispatcher(useCases, schemas),
  };
}

function operationalPostsSchema() {
  const schema = postsSchema();
  return { ...schema, spec: { ...schema.spec, description: { en: "Operational posts", "zh-TW": "營運文章" }, lifecycle: "operational" as const } };
}

function readOnlyOperationalPostsSchema() {
  const schema = operationalPostsSchema();
  return { ...schema, spec: { ...schema.spec, schema: { ...schema.spec.schema, readOnly: true } } };
}

/**
 * Build a stripped-down McpUseCases for tests that only exercise the
 * procedure-dispatch / public-surface paths (#281).
 */
function minimalUseCases(): McpUseCases {
  const store = new InMemoryEntryRepository();
  const schemasByName = new Map([["posts", postsSchema()]]);
  const clock: Clock = { now: () => 0 };
  const idgen: IdGenerator = { next: () => "x" };
  return {
    createDraft: new CreateDraftUseCase(store, schemasByName, clock, idgen),
    updateDraft: new UpdateDraftUseCase(store, schemasByName, clock),
    requestPublish: new RequestPublishUseCase(store, schemasByName, clock),
    unpublish: new UnpublishUseCase(store, schemasByName, clock),
    archive: new ArchiveUseCase(store, schemasByName, clock),
    deleteEntry: new DeleteEntryUseCase(store, schemasByName),
  };
}

function procedureCapability(
  procedure: ReturnType<typeof makeProcedure>,
  surface: "staff" | "public" = "staff",
): ProcedureCallableCapability {
  return {
    kind: "procedure",
    name: procedure.metadata.name.replaceAll("-", "_").toLowerCase(),
    ownerName: procedure.metadata.name,
    trigger: `${procedure.metadata.name}-mcp`,
    surface,
    description: `Invoke Procedure '${procedure.metadata.name}'.`,
    inputSchema: procedure.spec.input,
    outputSchema: procedure.spec.output,
    manifest: procedure,
  };
}

function viewCapability(view: ReturnType<typeof recentPostsView>): ViewCallableCapability {
  return {
    kind: "view",
    name: `query_view_${view.metadata.name.replaceAll("-", "_").toLowerCase()}`,
    ownerName: view.metadata.name,
    surface: view.spec.surface,
    description: `Query ${view.spec.surface} View '${view.metadata.name}'.`,
    inputSchema: {
      type: "object",
      properties: {
        ...(view.spec.params?.properties ?? {}),
        page: { type: "number" },
        show: { type: "number" },
      },
      ...(view.spec.params?.required?.length ? { required: view.spec.params.required } : {}),
    },
    manifest: view,
  };
}

function triggerInvoker(
  procedure: ReturnType<typeof makeProcedure>,
  invokeProcedure: InvokeProcedureUseCase,
): NonNullable<McpUseCases["invokeTrigger"]> {
  return {
    execute: ({ input, ctx, pathPrefix }) => invokeProcedure.execute({
      procedure,
      input,
      ctx,
      pathPrefix,
    }),
  };
}

function jsonRpcReq(method: string, params?: unknown, id: number | string = 1): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

function mcpContext(
  userId = "u1",
  role: NonNullable<HandlerContext["staff"]>["role"] | null = null,
  auth: Partial<NonNullable<HandlerContext["auth"]>> = {},
): HandlerContext {
  return {
    user: { id: userId },
    staff: role ? { id: userId, role } : null,
    auth: {
      credential: "oauth",
      credentialId: auth.credentialId ?? null,
      clientId: auth.clientId ?? "client-1",
      scopes: auth.scopes ?? ["mcp"],
    },
    env: {},
  };
}

function staffCtx(
  role: NonNullable<HandlerContext["staff"]>["role"] = "editor",
): HandlerContext {
  return mcpContext("u1", role);
}

describe("McpJsonRpcDispatcher", () => {
  it("initialize returns protocol info", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(jsonRpcReq("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }), mcpContext());
    const body = (await res.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string; version: string } };
    };
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(body.result.serverInfo).toEqual({
      name: "aotter.mantle",
      version: packageJson.version,
    });
  });

  it("requires the negotiated protocol version after initialize", async () => {
    const { dispatcher } = buildHarness();
    const unsupported = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "1999-01-01" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect((await dispatcher.dispatch(unsupported, mcpContext())).status).toBe(400);
    const get = await dispatcher.dispatch(new Request("https://example.com/mcp"), mcpContext());
    expect(get.status).toBe(405);
  });

  it("answers malformed JSON with the SDK's parse error", async () => {
    const { dispatcher } = buildHarness();
    const response = await dispatcher.dispatch(new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": MCP_PROTOCOL_VERSION },
      body: "{",
    }), mcpContext());
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });

  it("accepts the initialized notification without a response body", async () => {
    const { dispatcher } = buildHarness();
    const request = new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const response = await dispatcher.dispatch(request, mcpContext());
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("tools/list omits generic reads and emits lifecycle + per-collection tools", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(jsonRpcReq("tools/list"), mcpContext());
    const body = (await res.json()) as {
      result: { tools: { name: string }[] };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).not.toContain("list_entries");
    expect(names).not.toContain("get_entry");
    expect(names).toContain("request_publish");
    expect(names).toContain("unpublish_entry");
    expect(names).toContain("archive_entry");
    // Per-collection authoring tools.
    expect(names).toContain("create_draft_posts");
    expect(names).toContain("update_draft_posts");
    // Old generic create_draft is gone.
    expect(names).not.toContain("create_draft");
    for (const name of ["list_entries", "get_entry"]) {
      const call = await dispatcher.dispatch(jsonRpcReq("tools/call", {
        name, arguments: name === "list_entries" ? { collection: "posts" } : { id: "post-1" },
      }), mcpContext());
      expect((await call.json()) as { error: { code: number } }).toMatchObject({ error: { code: -32602 } });
    }
  });

  it("update tools describe expected_version as the observed native version", () => {
    const tools = buildMcpToolCatalog([postsSchema()]);
    const update = tools.find((tool) => tool.name === "update_draft_posts");
    expect(update?.description).toContain("observed native entry.version");
    expect(update?.description).toContain("not version+1");
    expect(update?.inputSchema).toMatchObject({
      properties: {
        expected_version: {
          description: expect.stringContaining("not version+1"),
        },
      },
    });
  });

  it("collapses localized JSON Schema annotations at the MCP catalog boundary", () => {
    const baseSchema = postsSchema();
    const schema = {
      ...baseSchema,
      spec: {
        ...baseSchema.spec,
        schema: {
          ...baseSchema.spec.schema,
          properties: {
            ...baseSchema.spec.schema.properties,
            title: {
              type: "string",
              title: { "zh-TW": "標題" },
              description: { en: "Post title", "zh-TW": "文章標題" },
            },
            tags: {
              type: "array",
              items: { type: "string", title: { en: "Tag" } },
            },
          },
        },
      },
    };
    const procedure = makeProcedure({
      name: "restock-sku",
      input: {
        type: "object",
        title: { "zh-TW": "補貨" },
        $defs: {
          sku: { type: "string", description: { en: "Stock keeping unit" } },
        },
        allOf: [
          {
            properties: {
              quantity: { type: "number", title: { en: "Quantity" } },
            },
          },
        ],
      },
    });

    const tools = buildMcpToolCatalog([schema], { capabilities: [procedureCapability(procedure)] });
    const createInput = tools.find((tool) => tool.name === "create_draft_posts")!
      .inputSchema;
    expect(createInput).toMatchObject({
      properties: {
        title: { title: "標題", description: "Post title" },
        tags: { items: { title: "Tag" } },
      },
    });

    const procedureInput = tools.find((tool) => tool.name === "restock_sku")!
      .inputSchema;
    expect(procedureInput).toMatchObject({
      title: "補貨",
      $defs: { sku: { description: "Stock keeping unit" } },
      allOf: [{ properties: { quantity: { title: "Quantity" } } }],
    });

    expect(schema.spec.schema.properties.title.title).toEqual({ "zh-TW": "標題" });
    expect(procedure.spec.input.title).toEqual({ "zh-TW": "補貨" });
  });

  it("uses record tools for lifecycle: operational collections and creates them live", async () => {
    const { dispatcher } = buildHarness([operationalPostsSchema()]);
    const list = await dispatcher.dispatch(jsonRpcReq("tools/list"), mcpContext());
    const listBody = (await list.json()) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    const names = listBody.result.tools.map((tool) => tool.name);
    expect(names).toContain("create_record_posts");
    expect(names).toContain("update_record_posts");
    expect(names).not.toContain("create_draft_posts");
    expect(names).not.toContain("update_draft_posts");
    expect(
      listBody.result.tools.find((tool) => tool.name === "create_record_posts")?.description,
    ).toContain("live operational record");
    expect(
      listBody.result.tools.find((tool) => tool.name === "create_record_posts")?.description,
    ).toContain("Operational posts");
    expect(
      listBody.result.tools.find((tool) => tool.name === "update_record_posts")?.description,
    ).toContain("Operational posts");

    const call = await dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "create_record_posts",
        arguments: { title: "Submission" },
      }),
      staffCtx(),
    );
    const callBody = (await call.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(callBody.result.content[0]!.text)).toMatchObject({
      status: "published",
      data: { title: "Submission" },
    });
  });

  it("keeps read-only Schemas queryable but removes and rejects generic authoring", async () => {
    const { dispatcher, store } = buildHarness([readOnlyOperationalPostsSchema()]);
    await store.create({
      id: "managed-1",
      collection: "posts",
      status: "published",
      data: { title: "Managed" },
      authorId: null,
      now: 1,
    });

    const list = await dispatcher.dispatch(jsonRpcReq("tools/list"), mcpContext());
    const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    const names = listBody.result.tools.map((tool) => tool.name);
    expect(names).not.toContain("list_entries");
    expect(names).not.toContain("get_entry");
    expect(names).not.toContain("create_record_posts");
    expect(names).not.toContain("update_record_posts");

    const deletion = await dispatcher.dispatch(jsonRpcReq("tools/call", {
      name: "delete_entry",
      arguments: { collection: "posts", id: "managed-1" },
    }), mcpContext());
    const deletionBody = (await deletion.json()) as { error: { code: number } };
    expect(deletionBody.error.code).toBe(-32602);
    expect(await store.get({ id: "managed-1", collection: "posts" })).not.toBeNull();
  });

  it("limits lifecycle discovery and rejects inapplicable or cross-collection calls", async () => {
    const operational = operationalPostsSchema();
    const content = { ...postsSchema(), metadata: { name: "articles" } };
    const managed = { ...readOnlyOperationalPostsSchema(), metadata: { name: "managed" } };
    const lifecycleTools = ["request_publish", "unpublish_entry", "archive_entry"];
    for (const schemas of [[operational], [managed], [content], [content, operational, managed]]) {
      const { dispatcher, store } = buildHarness(schemas);
      const catalog = buildMcpToolCatalog(schemas);
      const hasContent = schemas.includes(content);
      for (const name of lifecycleTools) expect(catalog.some((t) => t.name === name)).toBe(hasContent);
      for (const schema of schemas) {
        const original = await store.create({ id: schema.metadata.name, collection: schema.metadata.name,
          status: "draft", data: { title: "Unchanged" }, authorId: null, now: 1 });
        if (schema === content) continue;
        for (const name of [...lifecycleTools, "update_draft_articles"]) {
          const response = await dispatcher.dispatch(jsonRpcReq("tools/call", {
            name, arguments: { collection: schema.metadata.name, id: original.id, expected_version: 1, title: "Wrong" },
          }), mcpContext("owner", "owner"));
          const body = await response.json() as { error: { code: number; data?: { code: string } } };
          expect(body.error).toBeDefined();
          if (hasContent) expect(body.error.data?.code).toBe(name === "update_draft_articles" ? "NOT_FOUND" : "CONFLICT");
          else expect(body.error.code).toBe(-32602);
          expect(await store.get({ id: original.id, collection: original.collection })).toEqual(original);
        }
      }
    }
  });

  it("public surface exposes View query tools, not staff authoring tools", async () => {
    const { dispatcher: _staff, ...h } = buildHarness();
    const dispatcher = new McpJsonRpcDispatcher(
      {
        getEntry: new GetEntryUseCase(h.store),
        createDraft: new CreateDraftUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }, { next: () => "x" }),
        updateDraft: new UpdateDraftUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        requestPublish: new RequestPublishUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        unpublish: new UnpublishUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        archive: new ArchiveUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        deleteEntry: new DeleteEntryUseCase(
          h.store,
          new Map([["posts", postsSchema()]]),
        ),
        executeView: { execute: async () => ({ ok: true, result: { rows: [], page: 1, show: 20, hasMore: false } }) } as never,
      },
      [postsSchema()],
      {
        surface: "public",
        capabilities: [viewCapability(recentPostsView())],
      },
    );
    const res = await dispatcher.dispatch(jsonRpcReq("tools/list"), mcpContext());
    const body = (await res.json()) as {
      result: { tools: { name: string }[] };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toEqual(["query_view_recent_posts"]);
  });

  it("emits only provable or declared tool annotations", () => {
    const procedure = makeProcedure();
    const catalogFor = (manifest: ReturnType<typeof makeProcedure>) =>
      buildMcpToolCatalog([], { surface: "staff", capabilities: [procedureCapability(manifest)] })[0];

    // A ref handler is a black box: nothing inferred, declarations pass through.
    expect(catalogFor(procedure)?.annotations).toBeUndefined();
    expect(catalogFor({ ...procedure, spec: { ...procedure.spec, mcp: { readOnlyHint: true, openWorldHint: true } } })?.annotations)
      .toEqual({ readOnlyHint: true, openWorldHint: true });

    // Every builtin op writes; delete destroys.
    const builtin = { ...procedure, spec: { ...procedure.spec, handler: { kind: "builtin" as const, op: "update" as const, schema: "posts" } } };
    expect(catalogFor(builtin)?.annotations).toEqual({ readOnlyHint: false });
    const remove = { ...procedure, spec: { ...procedure.spec, handler: { kind: "builtin" as const, op: "delete" as const, schema: "posts" } } };
    expect(catalogFor(remove)?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    // A declared openWorldHint merges with the inferred facts.
    expect(catalogFor({ ...remove, spec: { ...remove.spec, mcp: { openWorldHint: true } } })?.annotations)
      .toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });

    // An idempotency-key input is the one thing inferable for a ref handler.
    const keyed = { ...procedure, spec: { ...procedure.spec, input: {
      type: "object", properties: { operationId: { type: "string", "x-mcp-hint": "idempotency-key" } }, required: ["operationId"],
    } } };
    expect(catalogFor(keyed)?.annotations).toEqual({ idempotentHint: true });

    // Generic tools carry their fixed facts.
    const generic = buildMcpToolCatalog([postsSchema()], { surface: "staff" });
    expect(generic.find((tool) => tool.name === "delete_entry")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(generic.find((tool) => tool.name === "request_publish")?.annotations).toEqual({ readOnlyHint: false });
    expect(generic.find((tool) => tool.name === "create_draft_posts")?.annotations).toEqual({ readOnlyHint: false });
  });

  it("tells agents in the description that an idempotency-key input must be reused on retry", () => {
    const procedure = makeProcedure();
    const withKey = {
      ...procedure,
      spec: {
        ...procedure.spec,
        input: {
          type: "object",
          properties: {
            tenantId: { type: "string" },
            operationId: { type: "string", format: "uuid", "x-mcp-hint": "idempotency-key" },
          },
          required: ["tenantId", "operationId"],
        },
      },
    };
    const [tool] = buildMcpToolCatalog([], {
      surface: "staff",
      capabilities: [procedureCapability(withKey)],
    });
    expect(tool?.description).toContain("retries must reuse the same operationId");
    const [plain] = buildMcpToolCatalog([], {
      surface: "staff",
      capabilities: [procedureCapability(procedure)],
    });
    expect(plain?.description).not.toContain("Idempotency");
  });

  it("tools/list preserves media x-mcp-hint metadata for agents", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(jsonRpcReq("tools/list"), mcpContext());
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
        createDraft: new CreateDraftUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }, { next: () => "x" }),
        updateDraft: new UpdateDraftUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        requestPublish: new RequestPublishUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        unpublish: new UnpublishUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        archive: new ArchiveUseCase(h.store, new Map([["posts", postsSchema()]]), { now: () => 0 }),
        deleteEntry: new DeleteEntryUseCase(
          h.store,
          new Map([["posts", postsSchema()]]),
        ),
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
    const res = await dispatcher.dispatch(jsonRpcReq("tools/list"), mcpContext());
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
    expect(mediaTool?.description).toContain("post-cover upload rules");
    expect(mediaTool?.description).toContain("choose exactly one mime per slot from this live policy");
    expect(mediaTool?.description).toContain("Do NOT default to JPEG");
    expect(mediaTool?.description).toContain("not always JPEG");
    expect(mediaTool?.description).toContain("maxBytes is a hard safety cap");
    expect(mediaTool?.description).toContain("ask the user in chat before uploading whether to optimize");
    expect(mediaTool?.description).toContain("harness blocks HTTP PUT requests");
    expect(mediaTool?.description).toContain("agent/runtime that allows outbound HTTP file uploads");
    expect(mediaTool?.description).toContain("authenticated same-origin Worker routes");
    expect(mediaTool?.description).toContain("for same-origin URLs, the authenticated session");
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
      staffCtx("contributor"),
    );
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const created = JSON.parse(body.result.content[0]!.text) as { id: string };
    expect(await store.get({ id: created.id, collection: "posts" })).toMatchObject({
      data: { title: "From MCP" },
      authorId: "u1",
    });
  });

  it("preserves MCP input and actor context across every lifecycle mutation", async () => {
    const schema = postsSchema();
    const schemas = new Map([[schema.metadata.name, schema]]);
    const procedure = makeProcedure({
      name: "audit-mutation",
      handlerRef: "auditMutation",
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
        },
      },
      output: { type: "object" },
    });
    const trigger = makeLifecycleTrigger({
      name: "mcp-mutation-audit",
      procedure: procedure.metadata.name,
      on: [
        "before_create",
        "after_create",
        "before_update",
        "after_update",
        "before_publish",
        "after_publish",
        "before_delete",
        "after_delete",
      ],
    });
    const triggerIndex = new TriggerIndex([trigger]);
    const registry = new InMemoryHandlerRegistry();
    const beforeCalls: Array<{
      input: unknown;
      hook: string | undefined;
      userId: string | undefined;
      staffRole: string | undefined;
      credentialId: string | null | undefined;
    }> = [];
    registry.register("auditMutation", (input, ctx) => {
      beforeCalls.push({
        input,
        hook: ctx.event?.hook,
        userId: ctx.user?.id,
        staffRole: ctx.staff?.role,
        credentialId: ctx.auth?.credentialId,
      });
      return {};
    });
    const invoke = new InvokeProcedureUseCase(registry);
    const hooks = new RunLifecycleHooksUseCase(
      triggerIndex,
      new Map([[procedure.metadata.name, procedure]]),
      (request) => invoke.execute(request),
    );
    const store = new InMemoryEntryRepository();
    const envelopes: DeferredHookEnvelope[] = [];
    const deferred: DeferredHookDispatcher = {
      enqueue: async (envelope) => {
        envelopes.push(envelope);
      },
    };
    let nextId = 1;
    const idgen: IdGenerator = { next: () => `mcp-lifecycle-${nextId++}` };
    const entries = new LifecycleHookingEntryRepository(
      store,
      triggerIndex,
      hooks,
      idgen,
      deferred,
    );
    const useCases: McpUseCases = {
      getEntry: new GetEntryUseCase(entries),
      createDraft: new CreateDraftUseCase(entries, schemas, { now: () => 1 }, idgen),
      updateDraft: new UpdateDraftUseCase(entries, schemas, { now: () => 2 }),
      requestPublish: new RequestPublishUseCase(entries, schemas, { now: () => 3 }),
      unpublish: new UnpublishUseCase(entries, schemas, { now: () => 4 }),
      archive: new ArchiveUseCase(entries, schemas, { now: () => 5 }),
      deleteEntry: new DeleteEntryUseCase(entries, schemas),
    };
    const dispatcher = new McpJsonRpcDispatcher(useCases, [schema]);
    const ctx = mcpContext("agent-1", "owner", {
      credentialId: "credential-1",
      clientId: "client-1",
      scopes: ["content:write"],
    });
    const call = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const response = await dispatcher.dispatch(
        jsonRpcReq("tools/call", { name, arguments: args }),
        ctx,
      );
      const body = (await response.json()) as {
        result?: { content: Array<{ text: string }> };
        error?: unknown;
      };
      expect(body.error).toBeUndefined();
      return JSON.parse(body.result!.content[0]!.text) as Record<string, unknown>;
    };

    const created = await call("create_draft_posts", { title: "Created" });
    const id = created["id"] as string;
    await call("update_draft_posts", {
      id,
      expected_version: created["version"],
      title: "Updated",
    });
    await call("request_publish", { collection: "posts", id });
    await call("unpublish_entry", { collection: "posts", id });
    await call("archive_entry", { collection: "posts", id });
    await call("delete_entry", { collection: "posts", id });

    expect(beforeCalls.map(({ hook, input }) => ({ hook, input }))).toEqual([
      { hook: "before_create", input: { title: "Created" } },
      { hook: "before_update", input: { title: "Updated" } },
      { hook: "before_publish", input: { id } },
      { hook: "before_update", input: { id } },
      { hook: "before_update", input: { id } },
      { hook: "before_delete", input: { id } },
    ]);
    expect(
      beforeCalls.every(
        (call) =>
          call.userId === "agent-1" &&
          call.staffRole === "owner" &&
          call.credentialId === "credential-1",
      ),
    ).toBe(true);
    expect(envelopes.map((envelope) => envelope.hook)).toEqual([
      "after_create",
      "after_update",
      "after_publish",
      "after_update",
      "after_update",
      "after_delete",
    ]);
    expect(
      envelopes.every(
        (envelope) =>
          envelope.ctxSnapshot?.userId === "agent-1" &&
          envelope.ctxSnapshot.staffRole === "owner" &&
          envelope.ctxSnapshot.auth?.credentialId === "credential-1" &&
          !("originalInput" in envelope),
      ),
    ).toBe(true);
  });

  it("tools/call request_publish flips draft → published", async () => {
    const { dispatcher, store } = buildHarness();
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
        arguments: { collection: created.collection, id: created.id },
      }),
      staffCtx(),
    );
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const result = JSON.parse(body.result.content[0]!.text) as { status: string };
    expect(result.status).toBe("published");
  });

  it("tools/call unpublish_entry flips published → draft", async () => {
    const { dispatcher, store } = buildHarness();
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
        arguments: { collection: created.collection, id: created.id },
      }),
      staffCtx(),
    );
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const result = JSON.parse(body.result.content[0]!.text) as { status: string };
    expect(result.status).toBe("draft");
  });

  it("generic staff tools follow the Admin rank table", async () => {
    const { dispatcher, store } = buildHarness();
    const draft = await store.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: { title: "x" },
      authorId: "u1",
      now: 0,
    });
    const contributorCreate = await dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "create_draft_posts",
        arguments: { title: "Contributor draft" },
      }),
      staffCtx("contributor"),
    );
    expect(
      ((await contributorCreate.json()) as { error?: unknown }).error,
    ).toBeUndefined();

    for (const name of ["request_publish", "unpublish_entry", "archive_entry", "delete_entry"]) {
      const denied = await dispatcher.dispatch(
        jsonRpcReq("tools/call", { name, arguments: { collection: draft.collection, id: draft.id } }),
        staffCtx("contributor"),
      );
      const body = (await denied.json()) as { error?: { data?: { code?: string } } };
      expect(body.error?.data?.code).toBe("AUTH_DENIED");
    }
    expect(await store.get({ id: draft.id, collection: draft.collection })).toMatchObject({ id: draft.id, status: "draft" });

    const operational = buildHarness([operationalPostsSchema()]);
    const recordDenied = await operational.dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "create_record_posts",
        arguments: { title: "Live" },
      }),
      staffCtx("contributor"),
    );
    expect(
      ((await recordDenied.json()) as { error?: { data?: { code?: string } } }).error?.data?.code,
    ).toBe("AUTH_DENIED");

    const mediaDispatcher = new McpJsonRpcDispatcher(
      {
        ...minimalUseCases(),
        getEntry: new GetEntryUseCase(store),
        media: {
          createUpload: { execute: async () => ({ leaked: true }) } as never,
          commitUpload: { execute: async () => ({ leaked: true }) } as never,
          purposes: [{ name: "post-cover", required: ["image/jpeg"], maxBytes: { "image/jpeg": 1 } }],
        },
      },
      [postsSchema()],
    );
    const mediaDenied = await mediaDispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "create_media_upload",
        arguments: {
          filename: "cover.jpg",
          purpose: "post-cover",
          variants: [{ mimeType: "image/jpeg", byteSize: 1, role: "primary" }],
        },
      }),
      staffCtx("contributor"),
    );
    expect(
      ((await mediaDenied.json()) as { error?: { data?: { code?: string } } }).error?.data?.code,
    ).toBe("AUTH_DENIED");
  });

  it("tools/call request_publish rejects orphan translated children", async () => {
    const { dispatcher } = buildHarness(translatedSchemas());
    const createdRes = await dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "create_draft_post_translations",
        arguments: { slug: "ghost", locale: "en", title: "Ghost", body: "Missing parent" },
      }),
      staffCtx("contributor"),
    );
    const createdBody = (await createdRes.json()) as { result: { content: { text: string }[] } };
    const created = JSON.parse(createdBody.result.content[0]!.text) as { id: string };

    const publishRes = await dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "request_publish",
        arguments: { collection: "post-translations", id: created.id },
      }),
      staffCtx(),
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

  it("unknown tool is the SDK's invalid-params error", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "ghost_tool", arguments: {} }),
      mcpContext(),
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });

  it("malformed arguments are an INPUT_VALIDATION_FAILED diagnostic, not a transport error", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "request_publish", arguments: { collection: "posts" } }),
      staffCtx(),
    );
    const body = (await res.json()) as { error: { code: number; data: { code: string; path: string } } };
    expect(body.error.code).toBe(-32000);
    expect(body.error.data).toMatchObject({
      code: "INPUT_VALIDATION_FAILED",
      path: "MCP request_publish#/arguments/id",
    });
  });

  it("a Procedure capability without a bound Trigger invoker is an unknown tool", async () => {
    const procedure = makeProcedure({ name: "echo" });
    const dispatcher = new McpJsonRpcDispatcher(minimalUseCases(), [postsSchema()], {
      capabilities: [procedureCapability(procedure)],
    });
    const res = await dispatcher.dispatch(jsonRpcReq("tools/call", { name: "echo", arguments: {} }), staffCtx());
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });

  it("create_draft_<unknown> is an unknown tool", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "create_draft_ghost",
        arguments: {},
      }),
      mcpContext(),
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
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
      { ...minimalUseCases(), invokeTrigger: triggerInvoker(procedure, invokeProcedure) },
      [],
      { surface: "staff", capabilities: [procedureCapability(procedure)] },
    );
    const list = (await (
      await dispatcher.dispatch(jsonRpcReq("tools/list"), mcpContext())
    ).json()) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toContain("restock_sku");

    const callRes = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "restock_sku", arguments: { msg: "hi" } }),
      mcpContext("u1", "owner"),
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

  it("preserves service failure recovery facts without exposing the cause", async () => {
    const procedure = makeProcedure({ name: "send-message" });
    const registry = new InMemoryHandlerRegistry();
    let sends = 0;
    registry.register("echoHandler", () => {
      sends++;
      throw new DiagnosticError(runtimeDiagnostic({
        code: "OUTCOME_UNKNOWN", severity: "error", path: "email",
        message: "Delivery acknowledgement unavailable.",
        failure: { outcome: "unknown", retry: "reconcile", resource: "email" },
      }), { cause: new Error("private-provider-response") });
    });
    const dispatcher = new McpJsonRpcDispatcher(
      { ...minimalUseCases(), invokeTrigger: triggerInvoker(procedure, new InvokeProcedureUseCase(registry)) },
      [], { surface: "public", capabilities: [procedureCapability(procedure, "public")] },
    );
    const response = await dispatcher.dispatch(jsonRpcReq("tools/call", {
      name: "send_message", arguments: { msg: "hello" },
    }), mcpContext());
    const body = await response.json() as { error: { data: { code: string; failure: unknown } } };
    expect(body.error.data.code).toBe("OUTCOME_UNKNOWN");
    expect(body.error.data.failure).toEqual({ outcome: "unknown", retry: "reconcile", resource: "email" });
    expect(JSON.stringify(body)).not.toContain("private-provider-response");
    expect(sends).toBe(1);
  });

  it("Procedure-MCP trigger on public surface: tool appears alongside Views, not staff tools (#281)", async () => {
    const procedure = makeProcedure({ name: "lookup-price" });
    const registry = new InMemoryHandlerRegistry();
    registry.register("echoHandler", () => ({ ok: true }));
    const invokeProcedure = new InvokeProcedureUseCase(registry);
    const dispatcher = new McpJsonRpcDispatcher(
      {
        ...minimalUseCases(),
        invokeTrigger: triggerInvoker(procedure, invokeProcedure),
        executeView: { execute: async () => ({ ok: true, result: { rows: [], page: 1, show: 20, hasMore: false } }) } as never,
      },
      [postsSchema()],
      {
        surface: "public",
        capabilities: [viewCapability(recentPostsView()), procedureCapability(procedure, "public")],
      },
    );
    const list = (await (
      await dispatcher.dispatch(jsonRpcReq("tools/list"), mcpContext())
    ).json()) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toContain("lookup_price");
    expect(names).toContain("query_view_recent_posts");
    expect(names).not.toContain("create_draft_posts");
    expect(names).not.toContain("list_entries");

    const guessedStaffCall = await dispatcher.dispatch(
      jsonRpcReq("tools/call", {
        name: "create_draft_posts",
        arguments: { title: "Bypass" },
      }),
      mcpContext(),
    );
    const guessedBody = (await guessedStaffCall.json()) as { error: { code: number } };
    expect(guessedBody.error.code).toBe(-32602);
  });

  it("Procedure-MCP trigger: requires.auth.all enforces the predicate, returning AUTH_DENIED for missing staff (#281)", async () => {
    const procedure = makeProcedure({
      name: "restock-sku",
      authPredicates: [{ "ctx.staff": ["owner"] }],
    });
    const registry = new InMemoryHandlerRegistry();
    registry.register("echoHandler", () => ({ ok: true }));
    const dispatcher = new McpJsonRpcDispatcher(
      { ...minimalUseCases(), invokeTrigger: triggerInvoker(procedure, new InvokeProcedureUseCase(registry)) },
      [],
      { surface: "staff", capabilities: [procedureCapability(procedure)] },
    );
    // Bearer authenticated but no staff role: the structured runtime
    // diagnostic is surfaced as JSON-RPC error data.
    const res = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "restock_sku", arguments: { msg: "x" } }),
      mcpContext(),
    );
    const body = (await res.json()) as {
      error?: { data?: { code?: string } };
    };
    expect(body.error?.data?.code).toBe("AUTH_DENIED");
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
        invokeTrigger: triggerInvoker(procedure, new InvokeProcedureUseCase(new InMemoryHandlerRegistry())),
      },
      [postsSchema()],
      {
        surface: "public",
        capabilities: [viewCapability(recentPostsView()), procedureCapability(procedure, "public")],
      },
    );
    const res = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "query_view_recent_posts", arguments: {} }),
      mcpContext(),
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
      rows: unknown[];
    };
    expect(inner.rows).toEqual([]);
  });

  it("Procedure-MCP trigger on public surface still enforces requires.auth.all: ctx.staff (#281)", async () => {
    // A Procedure surfaced as public-MCP but auth-gated on ctx.staff
    // can still be invoked by a staff bearer (and is denied for
    // bearer-only callers). This pins the contract that surface
    // discriminates DISCOVERY, not auth — auth always evaluates the
    // adapter-normalized HandlerContext via the use case.
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
      { ...minimalUseCases(), invokeTrigger: triggerInvoker(procedure, new InvokeProcedureUseCase(registry)) },
      [],
      { surface: "public", capabilities: [procedureCapability(procedure, "public")] },
    );

    // Bearer without staff: denied.
    const deniedRes = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "lookup_price", arguments: { msg: "x" } }),
      mcpContext(),
    );
    const denied = (await deniedRes.json()) as {
      error?: { data?: { code?: string } };
    };
    expect(denied.error?.data?.code).toBe("AUTH_DENIED");
    expect(calls).toBe(0);

    // Bearer with staff: allowed (handler runs).
    const allowedRes = await dispatcher.dispatch(
      jsonRpcReq("tools/call", { name: "lookup_price", arguments: { msg: "x" } }, 2),
      mcpContext("u1", "owner"),
    );
    const allowed = (await allowedRes.json()) as { result: { content: { text: string }[] } };
    const allowedInner = JSON.parse(allowed.result.content[0]!.text) as { ok: boolean };
    expect(allowedInner.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("Procedure tool name uses kebab→snake mangling (#281)", async () => {
    const procedure = makeProcedure({ name: "snapshot-inventory" });
    const dispatcher = new McpJsonRpcDispatcher(
      {
        ...minimalUseCases(),
        invokeTrigger: triggerInvoker(procedure, new InvokeProcedureUseCase(new InMemoryHandlerRegistry())),
      },
      [],
      { surface: "staff", capabilities: [procedureCapability(procedure)] },
    );
    const list = (await (
      await dispatcher.dispatch(jsonRpcReq("tools/list"), mcpContext())
    ).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toContain("snapshot_inventory");
  });

  it("rejects non-POST methods", async () => {
    const { dispatcher } = buildHarness();
    const res = await dispatcher.dispatch(
      new Request("https://example.com/mcp", { method: "PUT" }),
      mcpContext(),
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
        lifecycle: "publishing" as const,
      },
    },
  ];
}

describe("McpJsonRpcDispatcher — tools/call audit sink", () => {
  function auditedDispatcher(
    audit: { record: (event: unknown) => void | Promise<void> },
    executeView: NonNullable<McpUseCases["executeView"]>["execute"],
  ) {
    const store = new InMemoryEntryRepository();
    const schemas = new Map([["posts", postsSchema()]]);
    const view = recentPostsView();
    const correlatedView = {
      ...view,
      spec: {
        ...view.spec,
        params: {
          type: "object" as const,
          properties: { requestKey: { type: "string" as const, "x-mcp-hint": "idempotency-key" as const } },
        },
      },
    };
    return new McpJsonRpcDispatcher(
      {
        getEntry: new GetEntryUseCase(store),
        createDraft: new CreateDraftUseCase(store, schemas, { now: () => 0 }, { next: () => "x" }),
        updateDraft: new UpdateDraftUseCase(store, schemas, { now: () => 0 }),
        requestPublish: new RequestPublishUseCase(store, schemas, { now: () => 0 }),
        unpublish: new UnpublishUseCase(store, schemas, { now: () => 0 }),
        archive: new ArchiveUseCase(store, schemas, { now: () => 0 }),
        deleteEntry: new DeleteEntryUseCase(store, schemas),
        executeView: { execute: executeView },
      },
      [postsSchema()],
      { surface: "public", capabilities: [viewCapability(correlatedView)], audit },
    );
  }

  it("records one event per call with the outcome, off the response path", async () => {
    const events: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const audit = { record: async (event: unknown) => { await gate; events.push(event); } };
    let fail = false;
    const dispatcher = auditedDispatcher(audit, async () => fail
      ? { ok: false, diagnostic: runtimeDiagnostic({ code: "UNAUTHENTICATED", severity: "error", path: "view", message: "Sign in." }) }
      : { ok: true, result: { items: [] } });
    const deferred: Promise<unknown>[] = [];
    const ctx: HandlerContext = { ...mcpContext("u1", null, { clientId: "claude" }), waitUntil: (p) => { deferred.push(p); } };

    const ok = await dispatcher.dispatch(jsonRpcReq("tools/call", { name: "query_view_recent_posts", arguments: { requestKey: "op-1" } }), ctx);
    fail = true;
    const denied = await dispatcher.dispatch(jsonRpcReq("tools/call", { name: "query_view_recent_posts", arguments: {} }), ctx);
    expect(ok.status).toBe(200);
    // A dynamic identity failure for an identified caller is a tool result
    // (ADR-0029 D1); only the static anonymous pre-check answers HTTP 401.
    expect(denied.status).toBe(200);
    expect(((await denied.json()) as { error?: { data?: { code?: string } } }).error?.data?.code).toBe("UNAUTHENTICATED");
    // Both responses were sent while the sink was still blocked.
    expect(events).toEqual([]);
    expect(deferred).toHaveLength(2);
    release();
    await Promise.all(deferred);
    expect(events).toEqual([
      expect.objectContaining({ surface: "public", callerId: "u1", clientId: "claude", credential: "oauth", tool: "query_view_recent_posts", operationId: "op-1", outcome: "ok" }),
      expect.objectContaining({ tool: "query_view_recent_posts", operationId: null, outcome: "UNAUTHENTICATED" }),
    ]);
    for (const event of events as { at: number; durationMs: number }[]) {
      expect(event.at).toBeGreaterThan(0);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("never turns a failing sink into a tool error", async () => {
    const dispatcher = auditedDispatcher(
      { record: () => { throw new Error("dataset down"); } },
      async () => ({ ok: true, result: { items: [] } }),
    );
    const res = await dispatcher.dispatch(jsonRpcReq("tools/call", { name: "query_view_recent_posts", arguments: {} }), mcpContext());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: unknown }).result).toBeDefined();
  });

  it("records probes for tools that do not exist", async () => {
    const events: unknown[] = [];
    const dispatcher = auditedDispatcher({ record: (e) => { events.push(e); } }, async () => ({ ok: true, result: {} }));
    const res = await dispatcher.dispatch(jsonRpcReq("tools/call", { name: "nope", arguments: { operationId: "probe-1" } }), mcpContext());
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([expect.objectContaining({ tool: "nope", operationId: "probe-1", outcome: "UNKNOWN_TOOL" })]);
  });
});
