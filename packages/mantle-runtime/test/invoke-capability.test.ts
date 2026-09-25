import type { SchemaManifest, StaffRole } from "@aotter/mantle-spec";
import { describe, expect, it, vi } from "vitest";
import type { HandlerContext } from "../src/domain/model/HandlerContext.js";
import type { Clock } from "../src/domain/port/Clock.js";
import type { IdGenerator } from "../src/domain/port/IdGenerator.js";
import type { ProcedureCallableCapability, ViewCallableCapability } from "../src/domain/service/CallableCapabilityProjector.js";
import { buildCapabilityCatalog } from "../src/domain/service/CapabilityCatalog.js";
import {
  InvokeCapabilityUseCase,
  type CapabilityUseCases,
} from "../src/usecase/capability/InvokeCapabilityUseCase.js";
import {
  ArchiveUseCase,
  CreateDraftUseCase,
  DeleteEntryUseCase,
  GetEntryUseCase,
  RequestPublishUseCase,
  UnpublishUseCase,
  UpdateDraftUseCase,
} from "../src/usecase/content/index.js";
import { InMemoryEntryRepository } from "./fakes/in-memory-store.js";
import { makeProcedure, postsSchema, recentPostsView } from "./fakes/manifests.js";

describe("InvokeCapabilityUseCase", () => {
  it("applies the staff role floor before reading arguments", async () => {
    const { invoker } = harness();
    const denied = await invoker.execute({ name: "request_publish", args: {}, ctx: staff("contributor") });
    expect(denied).toMatchObject({ ok: false, diagnostic: { code: "AUTH_DENIED", path: "request_publish" } });
    expect(await invoker.execute({ name: "create_draft_posts", args: { title: "t" }, ctx: anonymous() }))
      .toMatchObject({ ok: false, diagnostic: { code: "AUTH_DENIED" } });
    expect(await invoker.execute({ name: "create_draft_posts", args: { title: "t" }, ctx: staff("contributor") }))
      .toMatchObject({ ok: true, data: { collection: "posts", data: { title: "t" } } });
    expect(await invoker.execute({ name: "create_record_records", args: { title: "t" }, ctx: staff("contributor") }))
      .toMatchObject({ ok: false, diagnostic: { code: "AUTH_DENIED" } });
  });

  it("reports malformed arguments as INPUT_VALIDATION_FAILED at the argument path", async () => {
    const { invoker } = harness({ media: true });
    const path = "MCP request_publish";
    expect(await invoker.execute({ name: "request_publish", args: { collection: "posts" }, ctx: staff("owner"), path }))
      .toMatchObject({ ok: false, diagnostic: { code: "INPUT_VALIDATION_FAILED", path: `${path}#/arguments/id` } });
    expect(await invoker.execute({ name: "update_draft_posts", args: { id: "x", expected_version: "1" }, ctx: staff("owner") }))
      .toMatchObject({ ok: false, diagnostic: { code: "INPUT_VALIDATION_FAILED", path: "update_draft_posts#/arguments/expected_version" } });
    const variants = [{ mimeType: "image/png", byteSize: 1.5, role: "primary" }];
    expect(await invoker.execute({ name: "create_media_upload", args: { filename: "a.png", purpose: "cover", variants }, ctx: staff("owner") }))
      .toMatchObject({ ok: false, diagnostic: { code: "INPUT_VALIDATION_FAILED", path: "create_media_upload#/arguments/variants/0" } });
  });

  it("strips the entry envelope from authoring data", async () => {
    const { invoker, useCases } = harness();
    const createDraft = vi.spyOn(useCases.createDraft, "execute");
    const created = await invoker.execute({
      name: "create_draft_posts",
      args: { title: "t", id: "forged", expected_version: 9 },
      ctx: staff("owner"),
    });
    expect(created).toMatchObject({ ok: true });
    const entry = (created as { data: { id: string; version: number; data: unknown } }).data;
    expect(entry.id).not.toBe("forged");
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ data: { title: "t" } }));
    const updateDraft = vi.spyOn(useCases.updateDraft, "execute");
    await invoker.execute({
      name: "update_draft_posts",
      args: { id: entry.id, expected_version: entry.version, title: "u" },
      ctx: staff("owner"),
    });
    expect(updateDraft).toHaveBeenCalledWith(expect.objectContaining({
      id: entry.id,
      expectedVersion: entry.version,
      data: { title: "u" },
    }));
  });

  it("keeps publishing transitions to content lifecycles and generic writes off read-only Schemas", async () => {
    const { invoker, useCases } = harness();
    const record = await useCases.createDraft.execute({ collection: "records", data: { title: "r" }, authorId: null, ctx: staff("owner") });
    expect(await invoker.execute({ name: "archive_entry", args: { collection: "records", id: record.id }, ctx: staff("owner") }))
      .toMatchObject({ ok: false, diagnostic: { code: "CONFLICT", expected: "a content lifecycle" } });
    const locked = await useCases.createDraft.execute({ collection: "locked", data: { title: "l" }, authorId: null, ctx: staff("owner") });
    expect(await invoker.execute({ name: "delete_entry", args: { collection: "locked", id: locked.id }, ctx: staff("owner") }))
      .toMatchObject({ ok: false, diagnostic: { code: "CONFLICT", value: "locked" } });
    expect(invoker.catalog.get("update_record_locked")).toBeUndefined();
  });

  it("returns NOT_FOUND for a capability the surface does not serve", async () => {
    const { invoker } = harness({ surface: "public" });
    expect(await invoker.execute({ name: "delete_entry", args: {}, ctx: staff("owner") }))
      .toMatchObject({ ok: false, diagnostic: { code: "NOT_FOUND", value: "delete_entry" } });
  });

  it("routes Procedures and Views and returns their failures as outcomes", async () => {
    const invokeTrigger = vi.fn(async () => ({ ok: false as const, diagnostic: { code: "CONFLICT" } as never }));
    const executeView = vi.fn(async () => ({ ok: true as const, result: { rows: [], page: 2, show: 5, hasMore: false } }));
    const { invoker } = harness({ surface: "public", invokeTrigger, executeView });
    expect(await invoker.execute({ name: "echo", args: { msg: "m" }, ctx: anonymous(), path: "MCP echo" }))
      .toEqual({ ok: false, diagnostic: { code: "CONFLICT" } });
    expect(invokeTrigger).toHaveBeenCalledWith({ trigger: "echo-mcp", input: { msg: "m" }, ctx: anonymous(), pathPrefix: "MCP echo" });
    expect(await invoker.execute({ name: "query_view_recent_posts", args: { tag: "a", page: 2, show: 5 }, ctx: anonymous() }))
      .toMatchObject({ ok: true, data: { page: 2 } });
    expect(executeView).toHaveBeenCalledWith(expect.objectContaining({
      options: { params: { tag: "a" }, page: 2, show: 5 },
      pathPrefix: "query_view_recent_posts",
    }));
  });

  it("drops own __proto__ keys instead of passing them on as data", async () => {
    const { invoker, useCases } = harness();
    const createDraft = vi.spyOn(useCases.createDraft, "execute");
    const args = JSON.parse('{"title":"t","__proto__":{"title":"x"}}') as Record<string, unknown>;
    await invoker.execute({ name: "create_draft_posts", args, ctx: staff("owner") });
    const data = createDraft.mock.calls[0]![0].data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(["title"]);
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  });

  it("serves a capability only when its use case is bound", () => {
    const { invoker } = harness({ surface: "public" });
    expect(invoker.serves("query_view_recent_posts")).toBe(false);
    expect(invoker.serves("echo")).toBe(false);
    expect(harness({ surface: "public", invokeTrigger: vi.fn() }).invoker.serves("echo")).toBe(true);
    expect(harness().invoker.serves("delete_entry")).toBe(true);
    expect(harness().invoker.serves("nope")).toBe(false);
  });

  it("lets unexpected errors escape instead of hiding them in an outcome", async () => {
    const invokeTrigger = vi.fn(async () => { throw new Error("driver exploded"); });
    const { invoker } = harness({ surface: "public", invokeTrigger });
    await expect(invoker.execute({ name: "echo", args: {}, ctx: anonymous() })).rejects.toThrow("driver exploded");
  });
});

describe("buildCapabilityCatalog", () => {
  it("marks identity requirements from the surface and declared auth predicates", () => {
    const guarded = makeProcedure({ name: "guarded", authPredicates: ["ctx.user"] });
    const open = makeProcedure({ name: "open" });
    const publicCatalog = buildCapabilityCatalog([postsSchema()], {
      surface: "public",
      callables: [procedure(guarded, "public"), procedure(open, "public"), view()],
    });
    expect(publicCatalog.get("guarded")?.requiresIdentity).toBe(true);
    expect(publicCatalog.get("open")?.requiresIdentity).toBe(false);
    expect(publicCatalog.get("query_view_recent_posts")?.requiresIdentity).toBe(false);
    const staffCatalog = buildCapabilityCatalog([postsSchema()], { surface: "staff", callables: [procedure(open, "staff")] });
    expect(staffCatalog.capabilities.every((capability) => capability.requiresIdentity)).toBe(true);
  });

  it("resolves the audit correlation argument from the idempotency hint", () => {
    const keyed = makeProcedure({
      name: "keyed",
      input: { type: "object", properties: { requestKey: { type: "string", "x-mcp-hint": "idempotency-key" } } },
    });
    const catalog = buildCapabilityCatalog([], { surface: "staff", callables: [procedure(keyed, "staff")] });
    expect(catalog.get("keyed")).toMatchObject({ operationIdArgument: "requestKey", hints: { idempotent: true } });
  });

  it("freezes every catalog entry deeply so callers cannot mutate shared definitions", () => {
    const catalog = buildCapabilityCatalog([postsSchema()]);
    const publish = catalog.get("request_publish")!;
    expect(Object.isFrozen(publish.inputSchema["required"])).toBe(true);
    expect(Object.isFrozen(publish.hints)).toBe(true);
    expect(() => (publish.inputSchema["required"] as string[]).push("x")).toThrow();
    expect(buildCapabilityCatalog([postsSchema()]).get("request_publish")!.inputSchema["required"]).toEqual(["collection", "id"]);
  });

  it("advertises only the standard projection of a Procedure output", () => {
    const shaped = makeProcedure({ name: "shaped", output: { type: "object", properties: { id: { type: "string", format: "uuid" } } } });
    const bag = makeProcedure({ name: "bag", output: { type: "object", properties: { tags: { type: "array", uniqueItems: true } } } });
    const catalog = buildCapabilityCatalog([], { callables: [procedure(shaped, "staff"), procedure(bag, "staff")] });
    expect(catalog.get("shaped")?.outputSchema).toEqual({ type: "object", properties: { id: { type: "string" } } });
    expect(catalog.get("bag")).not.toHaveProperty("outputSchema");
  });

  it("serves media operations only when purposes are supplied", () => {
    expect(buildCapabilityCatalog([postsSchema()]).get("create_media_upload")).toBeUndefined();
    expect(buildCapabilityCatalog([postsSchema()], { mediaPurposes: [] }).get("create_media_upload"))
      .toMatchObject({ minimumRole: "editor" });
  });
});

function schemas(): SchemaManifest[] {
  const posts = postsSchema();
  const records = { ...posts, metadata: { name: "records" }, spec: { ...posts.spec, lifecycle: "operational" as const } };
  const locked = {
    ...records,
    metadata: { name: "locked" },
    spec: { ...records.spec, schema: { ...records.spec.schema, readOnly: true } },
  };
  return [posts, records, locked];
}

function harness(options: {
  readonly surface?: "staff" | "public";
  readonly media?: boolean;
  readonly invokeTrigger?: CapabilityUseCases["invokeTrigger"]["execute"];
  readonly executeView?: NonNullable<CapabilityUseCases["executeView"]>["execute"];
} = {}) {
  const store = new InMemoryEntryRepository();
  const all = schemas();
  const byName = new Map(all.map((schema) => [schema.metadata.name, schema]));
  let next = 1;
  const clock: Clock = { now: () => 1_000 };
  const idgen: IdGenerator = { next: () => `id-${next++}` };
  const useCases = {
    getEntry: new GetEntryUseCase(store),
    createDraft: new CreateDraftUseCase(store, byName, clock, idgen),
    updateDraft: new UpdateDraftUseCase(store, byName, clock),
    requestPublish: new RequestPublishUseCase(store, byName, clock),
    unpublish: new UnpublishUseCase(store, byName, clock),
    archive: new ArchiveUseCase(store, byName, clock),
    deleteEntry: new DeleteEntryUseCase(store, byName),
    ...(options.invokeTrigger ? { invokeTrigger: { execute: options.invokeTrigger } } : {}),
    ...(options.executeView ? { executeView: { execute: options.executeView } } : {}),
    ...(options.media ? { media: { createUpload: { execute: vi.fn() }, commitUpload: { execute: vi.fn() } } } : {}),
  } as CapabilityUseCases & { createDraft: CreateDraftUseCase; updateDraft: UpdateDraftUseCase };
  const surface = options.surface ?? "staff";
  const catalog = buildCapabilityCatalog(all, {
    surface,
    callables: [procedure(makeProcedure({ name: "echo" }), surface), view()],
    ...(options.media ? { mediaPurposes: [{ name: "cover", required: ["image/png"], maxBytes: { "image/png": 10 } }] } : {}),
  });
  return { invoker: new InvokeCapabilityUseCase(useCases, catalog, all), useCases };
}

function procedure(manifest: ReturnType<typeof makeProcedure>, surface: "staff" | "public"): ProcedureCallableCapability {
  return {
    kind: "procedure",
    name: manifest.metadata.name,
    ownerName: manifest.metadata.name,
    trigger: `${manifest.metadata.name}-mcp`,
    surface,
    description: `Invoke Procedure '${manifest.metadata.name}'.`,
    inputSchema: manifest.spec.input,
    outputSchema: manifest.spec.output,
    manifest,
  };
}

function view(): ViewCallableCapability {
  const manifest = recentPostsView();
  return {
    kind: "view",
    name: "query_view_recent_posts",
    ownerName: manifest.metadata.name,
    surface: "public",
    description: "Query public View 'recent-posts'.",
    inputSchema: { type: "object" },
    manifest: { ...manifest, spec: { ...manifest.spec, surface: "public" } },
  };
}

function staff(role: StaffRole): HandlerContext {
  return { user: { id: "u1" }, staff: { id: "u1", role }, env: {} };
}

function anonymous(): HandlerContext {
  return { user: null, staff: null, env: {} };
}
