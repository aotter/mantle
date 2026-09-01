import { describe, expect, it } from "vitest";
import type {
  ProcedureManifest,
  SchemaManifest,
} from "@aotter/mantle-spec";
import type { Clock } from "../src/domain/port/Clock.js";
import type { IdGenerator } from "../src/domain/port/IdGenerator.js";
import { InMemoryHandlerRegistry } from "../src/domain/port/HandlerRegistry.js";
import { TriggerIndex } from "../src/domain/service/TriggerIndex.js";
import { LifecycleHookingEntryRepository } from "../src/infrastructure/persistence/LifecycleHookingEntryRepository.js";
import { InvokeBuiltinUseCase } from "../src/usecase/procedure/InvokeBuiltinUseCase.js";
import { InvokeProcedureUseCase } from "../src/usecase/procedure/InvokeProcedureUseCase.js";
import { RunLifecycleHooksUseCase } from "../src/usecase/lifecycle/RunLifecycleHooksUseCase.js";
import { EntryUniqueConflict } from "../src/domain/model/EntryRow.js";
import { InMemoryEntryRepository } from "./fakes/in-memory-store.js";
import { makeLifecycleTrigger, makeProcedure } from "./fakes/manifests.js";

const NOW = 1_700_000_000_000;
const clock: Clock = { now: () => NOW };

function nthIdGen(prefix = "id"): IdGenerator {
  let n = 0;
  return { next: () => `${prefix}-${++n}` };
}

const postsSchemaWithBindings: SchemaManifest = {
  apiVersion: "cms.mantle.aotter.net/v1",
  kind: "Schema",
  metadata: { name: "posts" },
  spec: {
    title: "Posts",
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        authorId: { type: "string", "x-mantle-bind": "ctx.user" },
        createdAt: { type: "number", "x-mantle-bind": "now" },
      },
    },
    lifecycle: "publishing",
  },
};

const siteSettingsSchema: SchemaManifest = {
  apiVersion: "cms.mantle.aotter.net/v1",
  kind: "Schema",
  metadata: { name: "site-settings" },
  spec: {
    title: "Site Settings",
    schema: {
      type: "object",
      properties: {
        siteKey: { type: "string" },
        variant: { type: "string" },
        theme: { type: "string" },
        title: { type: "string" },
        authorId: { type: "string", "x-mantle-bind": "ctx.user" },
        createdAt: { type: "number", "x-mantle-bind": "now" },
      },
    },
    uniqueIndexes: [["siteKey"], ["siteKey", "variant"]],
    lifecycle: "publishing",
  },
};

const compositeOnlySchema: SchemaManifest = {
  apiVersion: "cms.mantle.aotter.net/v1",
  kind: "Schema",
  metadata: { name: "composite-settings" },
  spec: {
    title: "Composite Settings",
    schema: {
      type: "object",
      properties: {
        siteKey: { type: "string" },
        variant: { type: "string" },
        theme: { type: "string" },
        title: { type: "string" },
      },
    },
    uniqueIndexes: [["siteKey", "variant"]],
    lifecycle: "publishing",
  },
};

function builtinProcedure(opts: {
  name: string;
  op: "create" | "update" | "upsert" | "delete" | "archive";
  schema: string;
  inputProperties?: Record<string, unknown>;
  required?: string[];
  match?: string[];
}): ProcedureManifest {
  return makeProcedure({
    name: opts.name,
    input: {
      type: "object",
      properties: opts.inputProperties ?? { data: { type: "object" } },
      ...(opts.required ? { required: opts.required } : {}),
    },
    output: { type: "object" },
    handler: { kind: "builtin", op: opts.op, schema: opts.schema, match: opts.match },
  });
}

interface Harness {
  store: InMemoryEntryRepository;
  invoke: InvokeProcedureUseCase;
  schemas: ReadonlyMap<string, SchemaManifest>;
}

function harness(opts: {
  schemas?: SchemaManifest[];
  triggers?: Parameters<typeof makeLifecycleTrigger>[0][];
  procedures?: ProcedureManifest[];
  handlers?: Record<string, (input: unknown, ctx: unknown) => unknown>;
} = {}): Harness {
  const schemas = new Map(
    (opts.schemas ?? [postsSchemaWithBindings]).map((s) => [s.metadata.name, s]),
  );
  const proceduresByName = new Map((opts.procedures ?? []).map((p) => [p.metadata.name, p]));
  const triggers = (opts.triggers ?? []).map(makeLifecycleTrigger);
  const triggerIndex = new TriggerIndex(triggers);
  const registry = new InMemoryHandlerRegistry();
  for (const [ref, fn] of Object.entries(opts.handlers ?? {})) {
    registry.register(
      ref,
      fn as unknown as Parameters<InMemoryHandlerRegistry["register"]>[1],
    );
  }
  const store = new InMemoryEntryRepository(schemas);
  const idgen = nthIdGen("post");

  let entries: import("../src/domain/port/EntryRepository.js").EntryRepository;
  const invokeBuiltin = new InvokeBuiltinUseCase(
    {
      create: (a) => entries.create(a),
      get: (id) => entries.get(id),
      update: (a) => entries.update(a),
      delete: (a) => entries.delete(a),
      transitionStatus: (a) => entries.transitionStatus(a),
      list: (a) => entries.list(a),
      findByDataField: (a) => entries.findByDataField(a),
      findByDataFields: (a) => entries.findByDataFields(a),
    },
    schemas,
    clock,
    idgen,
  );
  const invoke = new InvokeProcedureUseCase(registry, invokeBuiltin);
  const hookRunner = new RunLifecycleHooksUseCase(triggerIndex, proceduresByName, (req) =>
    invoke.execute(req),
  );
  entries = new LifecycleHookingEntryRepository(store, triggerIndex, hookRunner, idgen);

  return { store, invoke, schemas };
}

const createPostFullInput = builtinProcedure({
  name: "createPost",
  op: "create",
  schema: "posts",
  inputProperties: {
    title: { type: "string" },
    body: { type: "string" },
    authorId: { type: "string" },
    createdAt: { type: "number" },
    recaptchaToken: { type: "string" },
  },
});

describe("InvokeBuiltinUseCase — create", () => {
  it("projects input ∩ Schema.properties and stamps x-mantle-bind", async () => {
    const h = harness();
    const result = await h.invoke.execute({
      procedure: createPostFullInput,
      input: {
        title: "Hello",
        body: "World",
        recaptchaToken: "side-channel-only", // not in Schema.properties
      },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data as { id: string; data: Record<string, unknown> };
    expect(row.data).toEqual({
      title: "Hello",
      body: "World",
      authorId: "u-1", // server-stamped
      createdAt: NOW, // server-stamped
    });
    expect("recaptchaToken" in row.data).toBe(false);
  });

  it("server-stamping wins over caller-supplied x-mantle-bind values", async () => {
    const h = harness();
    const result = await h.invoke.execute({
      procedure: createPostFullInput,
      input: {
        title: "x",
        authorId: "spoofed-by-caller",
        createdAt: 0,
      },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data as { data: Record<string, unknown> };
    expect(row.data["authorId"]).toBe("u-1");
    expect(row.data["createdAt"]).toBe(NOW);
  });

  it("anonymous ctx → x-mantle-bind: ctx.user stamps null", async () => {
    const h = harness();
    const result = await h.invoke.execute({
      procedure: createPostFullInput,
      input: { title: "anon" },
      ctx: { user: null, staff: null, env: {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { data: { authorId: unknown } }).data.authorId).toBeNull();
  });

  it("creates lifecycle: operational operational records live", async () => {
    const schema = {
      ...postsSchemaWithBindings,
      spec: { ...postsSchemaWithBindings.spec, lifecycle: "operational" as const },
    };
    const h = harness({ schemas: [schema] });
    const result = await h.invoke.execute({
      procedure: createPostFullInput,
      input: { title: "Submission" },
      ctx: { user: null, staff: null, env: {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { status: string }).status).toBe("published");
  });
});

describe("InvokeBuiltinUseCase — update / delete / upsert", () => {
  it("update requires id + expectedVersion in input and bumps version", async () => {
    const h = harness();
    const created = await h.invoke.execute({
      procedure: builtinProcedure({ name: "createPost", op: "create", schema: "posts" }),
      input: { title: "v1" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    if (!created.ok) throw new Error("create failed");
    const row = created.data as { id: string; version: number };

    const updated = await h.invoke.execute({
      procedure: builtinProcedure({
        name: "updatePost",
        op: "update",
        schema: "posts",
        inputProperties: {
          id: { type: "string" },
          expectedVersion: { type: "number" },
          title: { type: "string" },
        },
      }),
      input: { id: row.id, expectedVersion: row.version, title: "v2" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect((updated.data as { version: number }).version).toBe(row.version + 1);
    expect((updated.data as { data: { title: string } }).data.title).toBe("v2");
  });

  it("update PATCHES: omitted fields + author binding survive (regression #390)", async () => {
    const h = harness();
    const created = await h.invoke.execute({
      procedure: createPostFullInput,
      input: { title: "v1", body: "original body" },
      ctx: { user: { id: "user-A" }, staff: null, env: {} },
    });
    if (!created.ok) throw new Error("create failed");
    const row = created.data as { id: string; version: number };

    // User B updates ONLY the title. Pre-#390 this routed through the
    // create projector: `body` would be wiped and `authorId` re-stamped
    // to user-B. The PATCH path must preserve both.
    const updated = await h.invoke.execute({
      procedure: builtinProcedure({
        name: "updatePost",
        op: "update",
        schema: "posts",
        inputProperties: {
          id: { type: "string" },
          expectedVersion: { type: "number" },
          title: { type: "string" },
        },
      }),
      input: { id: row.id, expectedVersion: row.version, title: "v2" },
      ctx: { user: { id: "user-B" }, staff: null, env: {} },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const data = (updated.data as { data: Record<string, unknown> }).data;
    expect(data["title"]).toBe("v2");
    expect(data["body"]).toBe("original body"); // not wiped
    expect(data["authorId"]).toBe("user-A"); // not re-stamped to user-B
  });

  it("update on unknown id returns NOT_FOUND (regression #390)", async () => {
    const h = harness();
    const result = await h.invoke.execute({
      procedure: builtinProcedure({
        name: "updatePost",
        op: "update",
        schema: "posts",
        inputProperties: {
          id: { type: "string" },
          expectedVersion: { type: "number" },
          title: { type: "string" },
        },
      }),
      input: { id: "ghost", expectedVersion: 1, title: "x" },
      ctx: { user: { id: "user-A" }, staff: null, env: {} },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("NOT_FOUND");
  });

  it("delete returns { removed: true }", async () => {
    const h = harness();
    const created = await h.invoke.execute({
      procedure: builtinProcedure({ name: "createPost", op: "create", schema: "posts" }),
      input: { title: "doomed" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    if (!created.ok) throw new Error("create failed");
    const row = created.data as { id: string };

    const deleted = await h.invoke.execute({
      procedure: builtinProcedure({
        name: "deletePost",
        op: "delete",
        schema: "posts",
        inputProperties: { id: { type: "string" } },
      }),
      input: { id: row.id },
      ctx: { user: null, staff: null, env: {} },
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.data).toEqual({ removed: true });
  });

  it("delete rejects published content until it is unpublished", async () => {
    const h = harness();
    const created = await h.invoke.execute({
      procedure: builtinProcedure({ name: "createPost", op: "create", schema: "posts" }),
      input: { title: "live" },
      ctx: { user: null, staff: null, env: {} },
    });
    if (!created.ok) throw new Error("create failed");
    const row = created.data as { id: string };
    await h.store.transitionStatus({
      id: row.id,
      collection: "posts",
      to: "published",
      expectedStatus: "draft",
      expectedVersion: 1,
      now: NOW + 1,
    });

    const deleted = await h.invoke.execute({
      procedure: builtinProcedure({
        name: "deletePost",
        op: "delete",
        schema: "posts",
        inputProperties: { id: { type: "string" } },
      }),
      input: { id: row.id },
      ctx: { user: null, staff: null, env: {} },
    });
    expect(deleted).toMatchObject({ ok: false, diagnostic: { code: "CONFLICT" } });
    expect(await h.store.get(row.id)).not.toBeNull();
  });

  it("delete cannot cross the Procedure's bound collection", async () => {
    const comments: SchemaManifest = {
      ...postsSchemaWithBindings,
      metadata: { name: "comments" },
      spec: { ...postsSchemaWithBindings.spec, title: "Comments" },
    };
    const h = harness({ schemas: [postsSchemaWithBindings, comments] });
    await h.store.create({
      id: "shared-id",
      collection: "comments",
      status: "draft",
      data: {},
      authorId: null,
      now: NOW,
    });

    const deleted = await h.invoke.execute({
      procedure: builtinProcedure({
        name: "deletePost",
        op: "delete",
        schema: "posts",
        inputProperties: { id: { type: "string" } },
      }),
      input: { id: "shared-id" },
      ctx: { user: null, staff: null, env: {} },
    });
    expect(deleted).toMatchObject({ ok: false, diagnostic: { code: "NOT_FOUND" } });
    expect(await h.store.get("shared-id")).not.toBeNull();
  });

  it("delete removes lifecycle: operational records even though they are published", async () => {
    const schema: SchemaManifest = {
      ...postsSchemaWithBindings,
      spec: { ...postsSchemaWithBindings.spec, lifecycle: "operational" },
    };
    const h = harness({ schemas: [schema] });
    const created = await h.invoke.execute({
      procedure: builtinProcedure({ name: "createPost", op: "create", schema: "posts" }),
      input: { title: "submission" },
      ctx: { user: null, staff: null, env: {} },
    });
    if (!created.ok) throw new Error("create failed");
    const row = created.data as { id: string; status: string };
    expect(row.status).toBe("published");

    const deleted = await h.invoke.execute({
      procedure: builtinProcedure({
        name: "deletePost",
        op: "delete",
        schema: "posts",
        inputProperties: { id: { type: "string" } },
      }),
      input: { id: row.id },
      ctx: { user: null, staff: null, env: {} },
    });
    expect(deleted).toMatchObject({ ok: true, data: { removed: true } });
  });

  it("archive flips status to archived and bumps version", async () => {
    const h = harness();
    const created = await h.invoke.execute({
      procedure: createPostFullInput,
      input: { title: "stale" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    if (!created.ok) throw new Error("create failed");
    const row = created.data as { id: string; version: number };

    const archived = await h.invoke.execute({
      procedure: builtinProcedure({
        name: "archivePost",
        op: "archive",
        schema: "posts",
        inputProperties: {
          id: { type: "string" },
          expectedVersion: { type: "number" },
        },
      }),
      input: { id: row.id, expectedVersion: row.version },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect((archived.data as { status: string }).status).toBe("archived");
    expect((archived.data as { version: number }).version).toBe(row.version + 1);
  });

  it("archive on already-archived returns CONFLICT via canTransition (#210 PR12 H4)", async () => {
    const h = harness();
    const created = await h.invoke.execute({
      procedure: builtinProcedure({ name: "createPost", op: "create", schema: "posts" }),
      input: { title: "doomed" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    if (!created.ok) throw new Error("create failed");
    const row = created.data as { id: string; version: number };
    const first = await h.invoke.execute({
      procedure: builtinProcedure({
        name: "archivePost",
        op: "archive",
        schema: "posts",
        inputProperties: { id: { type: "string" }, expectedVersion: { type: "number" } },
      }),
      input: { id: row.id, expectedVersion: row.version },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(first.ok).toBe(true);
    // Second archive: row is already archived; canTransition rejects.
    const second = await h.invoke.execute({
      procedure: builtinProcedure({
        name: "archivePost",
        op: "archive",
        schema: "posts",
        inputProperties: { id: { type: "string" }, expectedVersion: { type: "number" } },
      }),
      input: { id: row.id, expectedVersion: row.version + 1 },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.diagnostic.code).toBe("CONFLICT");
  });

  it("upsert: with unknown id falls through to create", async () => {
    const h = harness();
    const result = await h.invoke.execute({
      procedure: builtinProcedure({
        name: "upsertPost",
        op: "upsert",
        schema: "posts",
        inputProperties: {
          id: { type: "string" },
          title: { type: "string" },
        },
      }),
      input: { id: "ghost", title: "phantom" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { id: string }).id).toBe("post-1");
  });
});

describe("InvokeBuiltinUseCase — lifecycle hook integration", () => {
  it("before_create hook input includes side-channel fields", async () => {
    let captured: unknown = null;
    const h = harness({
      procedures: [
        makeProcedure({
          name: "captchaCheck",
          handlerRef: "captchaCheck",
          // Hook procedures declare which input fields they want to
          // read. zod strips unknowns, so the side-channel field is
          // listed here just like any normal procedure input.
          input: {
            type: "object",
            properties: {
              title: { type: "string" },
              recaptchaToken: { type: "string" },
            },
          },
          output: { type: "object" },
        }),
      ],
      triggers: [
        {
          procedure: "captchaCheck",
          schema: "posts",
          on: ["before_create"],
        },
      ],
      handlers: {
        captchaCheck: (input: unknown) => {
          captured = input;
          return { ok: true };
        },
      },
    });
    const result = await h.invoke.execute({
      procedure: createPostFullInput,
      input: { title: "x", recaptchaToken: "tok-123" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(result.ok).toBe(true);
    expect(captured).toMatchObject({ recaptchaToken: "tok-123", title: "x" });
  });

  it("before_create handler throw aborts the create (CAPTCHA-fail flow)", async () => {
    const h = harness({
      procedures: [
        makeProcedure({
          name: "captchaCheck",
          handlerRef: "captchaCheck",
          input: { type: "object" },
          output: { type: "object" },
        }),
      ],
      triggers: [
        {
          procedure: "captchaCheck",
          schema: "posts",
          on: ["before_create"],
          errorPolicy: "abort",
        },
      ],
      handlers: {
        captchaCheck: () => {
          throw new Error("captcha failed");
        },
      },
    });
    const result = await h.invoke.execute({
      procedure: createPostFullInput,
      input: { title: "x" },
      ctx: { user: null, staff: null, env: {} },
    });
    expect(result.ok).toBe(false);
    const list = await h.store.list({ collection: "posts" });
    expect(list.rows).toHaveLength(0);
  });
});

describe("InvokeBuiltinUseCase — matched upsert", () => {
  const upsertByKey = builtinProcedure({
    name: "upsertSettingByKey",
    op: "upsert",
    schema: "site-settings",
    match: ["siteKey"],
    inputProperties: {
      siteKey: { type: "string" },
      theme: { type: "string" },
      title: { type: "string" },
    },
    required: ["siteKey", "theme"],
  });

  const upsertByComposite = builtinProcedure({
    name: "upsertCompositeSetting",
    op: "upsert",
    schema: "composite-settings",
    match: ["siteKey", "variant"],
    inputProperties: {
      siteKey: { type: "string" },
      variant: { type: "string" },
      theme: { type: "string" },
      title: { type: "string" },
    },
    required: ["siteKey", "variant"],
  });

  it("matched upsert creates when no row matches", async () => {
    const h = harness({ schemas: [siteSettingsSchema] });
    const result = await h.invoke.execute({
      procedure: upsertByKey,
      input: { siteKey: "main", theme: "dark", title: "Main Site" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data as { id: string; version: number; data: Record<string, unknown> };
    expect(row.version).toBe(1);
    expect(row.data).toMatchObject({
      siteKey: "main",
      theme: "dark",
      title: "Main Site",
      authorId: "u-1",
      createdAt: NOW,
    });
    const list = await h.store.list({ collection: "site-settings" });
    expect(list.rows).toHaveLength(1);
  });

  it("matched upsert patches the matching row without creating a second row", async () => {
    const h = harness({ schemas: [siteSettingsSchema] });
    const created = await h.invoke.execute({
      procedure: upsertByKey,
      input: { siteKey: "main", theme: "dark", title: "Main Site" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const createdRow = created.data as { id: string; version: number };

    const updated = await h.invoke.execute({
      procedure: upsertByKey,
      input: { siteKey: "main", theme: "light" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const updatedRow = updated.data as { id: string; version: number; data: Record<string, unknown> };
    expect(updatedRow.id).toBe(createdRow.id);
    expect(updatedRow.version).toBe(2);
    expect(updatedRow.data["theme"]).toBe("light");

    const list = await h.store.list({ collection: "site-settings" });
    expect(list.rows).toHaveLength(1);
  });

  it("composite unique-index matching works in declared order", async () => {
    const h = harness({ schemas: [compositeOnlySchema] });
    const r1 = await h.invoke.execute({
      procedure: upsertByComposite,
      input: { siteKey: "docs", variant: "v1", theme: "dark", title: "Docs V1" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    const r2 = await h.invoke.execute({
      procedure: upsertByComposite,
      input: { siteKey: "docs", variant: "v2", theme: "solarized", title: "Docs V2" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(r1.ok && r2.ok).toBe(true);

    // Update V1 only
    const updateV1 = await h.invoke.execute({
      procedure: upsertByComposite,
      input: { siteKey: "docs", variant: "v1", theme: "light" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(updateV1.ok).toBe(true);
    if (!updateV1.ok) return;
    const v1Row = updateV1.data as { version: number; data: Record<string, unknown> };
    expect(v1Row.version).toBe(2);
    expect(v1Row.data["theme"]).toBe("light");

    // V2 remains version 1 and solarized
    const all = await h.store.list({ collection: "composite-settings" });
    expect(all.rows).toHaveLength(2);
    const v2Row = all.rows.find((r) => r.data["variant"] === "v2");
    expect(v2Row?.version).toBe(1);
    expect(v2Row?.data["theme"]).toBe("solarized");
  });

  it("omitted fields survive the update branch", async () => {
    const h = harness({ schemas: [siteSettingsSchema] });
    await h.invoke.execute({
      procedure: upsertByKey,
      input: { siteKey: "main", theme: "dark", title: "Preserve Me" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });

    const updated = await h.invoke.execute({
      procedure: upsertByKey,
      input: { siteKey: "main", theme: "light" }, // omitted 'title'
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const row = updated.data as { data: Record<string, unknown> };
    expect(row.data["theme"]).toBe("light");
    expect(row.data["title"]).toBe("Preserve Me");
  });

  it("lifecycle hooks fire for matched upsert with original caller input", async () => {
    let beforeUpdateInput: unknown = null;
    let hookCtxUser: unknown = null;
    const h = harness({
      schemas: [siteSettingsSchema],
      procedures: [
        makeProcedure({
          name: "logSettingsUpdate",
          handlerRef: "logSettingsUpdate",
          input: {
            type: "object",
            properties: {
              siteKey: { type: "string" },
              theme: { type: "string" },
            },
          },
          output: { type: "object" },
        }),
      ],
      triggers: [
        {
          procedure: "logSettingsUpdate",
          schema: "site-settings",
          on: ["before_update"],
        },
      ],
      handlers: {
        logSettingsUpdate: (input, ctx) => {
          beforeUpdateInput = input;
          hookCtxUser = (ctx as { user?: { id: string } })?.user?.id;
          return { ok: true };
        },
      },
    });

    await h.invoke.execute({
      procedure: upsertByKey,
      input: { siteKey: "main", theme: "dark", title: "Init" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });

    const callerInput = { siteKey: "main", theme: "light" };
    const res = await h.invoke.execute({
      procedure: upsertByKey,
      input: callerInput,
      ctx: { user: { id: "u-2" }, staff: null, env: {} },
    });
    expect(res.ok).toBe(true);
    // Preserves caller's original input; does not expose synthesized id/expectedVersion
    expect(beforeUpdateInput).toEqual(callerInput);
    expect(hookCtxUser).toBe("u-2");
  });

  it("OCC conflict returns CONFLICT diagnostic and does not retry", async () => {
    const h = harness({ schemas: [siteSettingsSchema] });
    const created = await h.invoke.execute({
      procedure: upsertByKey,
      input: { siteKey: "main", theme: "dark" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    if (!created.ok) throw new Error("create failed");
    const row = created.data as { id: string };

    // Simulate concurrent modification bumping the version in the store to 2
    const current = await h.store.get(row.id);
    if (current) {
      h.store._seed({ ...current, version: 2 });
    }

    // Intercept findByDataFields to simulate returning a snapshot before the concurrent update
    const origFindByDataFields = h.store.findByDataFields.bind(h.store);
    h.store.findByDataFields = async (args) => {
      const found = await origFindByDataFields(args);
      return found ? { ...found, version: 1 } : null;
    };

    const result = await h.invoke.execute({
      procedure: upsertByKey,
      input: { siteKey: "main", theme: "light" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("CONFLICT");
  });

  it("concurrent-create race: atomic unique constraint failure surfaces as CONFLICT diagnostic without duplicates", async () => {
    const h = harness({ schemas: [siteSettingsSchema] });

    // Writer 1 executes matched upsert and creates the row.
    const w1 = await h.invoke.execute({
      procedure: upsertByKey,
      input: { siteKey: "main", theme: "dark" },
      ctx: { user: { id: "u-1" }, staff: null, env: {} },
    });
    expect(w1.ok).toBe(true);

    // Simulate Writer 2 racing: Writer 2 did lookup BEFORE Writer 1 created (so findByDataFields was a miss),
    // and both writers entered the create branch. When Writer 2 reaches entries.create,
    // the repository's atomic unique index enforcement detects the duplicate key and throws EntryUniqueConflict.
    const origFindByDataFields = h.store.findByDataFields.bind(h.store);
    h.store.findByDataFields = async () => null;

    const w2 = await h.invoke.execute({
      procedure: upsertByKey,
      input: { siteKey: "main", theme: "solarized" },
      ctx: { user: { id: "u-2" }, staff: null, env: {} },
    });

    expect(w2.ok).toBe(false);
    if (w2.ok) return;
    expect(w2.diagnostic.code).toBe("CONFLICT");

    // No duplicate row created
    const all = await h.store.list({ collection: "site-settings" });
    expect(all.rows).toHaveLength(1);
    expect(all.rows[0]?.data["theme"]).toBe("dark");
  });

  it("preserves NULL semantics for optional unique index fields in in-memory repository", async () => {
    const optionalUniqueSchema: SchemaManifest = {
      apiVersion: "cms.mantle.aotter.net/v1",
      kind: "Schema",
      metadata: { name: "profiles" },
      spec: {
        title: "Profiles",
        schema: {
          type: "object",
          properties: {
            username: { type: "string" },
            handle: { type: "string" },
          },
          required: ["username"],
        },
        uniqueIndexes: [["handle"]],
        lifecycle: "publishing",
      },
    };

    const h = harness({ schemas: [optionalUniqueSchema] });

    // Two entries omitting the optional unique 'handle' can both be created
    const r1 = await h.store.create({
      id: "p-1",
      collection: "profiles",
      status: "draft",
      data: { username: "alice" },
      authorId: null,
      now: 1,
    });
    const r2 = await h.store.create({
      id: "p-2",
      collection: "profiles",
      status: "draft",
      data: { username: "bob" },
      authorId: null,
      now: 2,
    });
    expect(r1.id).toBe("p-1");
    expect(r2.id).toBe("p-2");

    // Explicit handle duplicate throws EntryUniqueConflict
    await h.store.create({
      id: "p-3",
      collection: "profiles",
      status: "draft",
      data: { username: "charlie", handle: "dev" },
      authorId: null,
      now: 3,
    });

    await expect(
      h.store.create({
        id: "p-4",
        collection: "profiles",
        status: "draft",
        data: { username: "dana", handle: "dev" },
        authorId: null,
        now: 4,
      }),
    ).rejects.toBeInstanceOf(EntryUniqueConflict);
  });
});

