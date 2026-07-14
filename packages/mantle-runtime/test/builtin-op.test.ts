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
    lifecycle: "simple",
  },
};

function builtinProcedure(opts: {
  name: string;
  op: "create" | "update" | "upsert" | "delete";
  schema: string;
  inputProperties?: Record<string, unknown>;
}): ProcedureManifest {
  return makeProcedure({
    name: opts.name,
    input: { type: "object", properties: opts.inputProperties ?? { data: { type: "object" } } },
    output: { type: "object" },
    handler: { kind: "builtin", op: opts.op, schema: opts.schema },
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
  const store = new InMemoryEntryRepository();
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
    },
    schemas,
    clock,
    idgen,
  );
  const invoke = new InvokeProcedureUseCase(registry, invokeBuiltin);
  const hookRunner = new RunLifecycleHooksUseCase(triggerIndex, proceduresByName, (req) =>
    invoke.execute(req),
  );
  entries = new LifecycleHookingEntryRepository(store, triggerIndex, hookRunner);

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
  it("before_create hook sees ctx.event.originalInput including side-channel fields", async () => {
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
