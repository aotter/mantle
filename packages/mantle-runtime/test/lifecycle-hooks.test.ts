import { describe, expect, it, vi } from "vitest";
import {
  DiagnosticError,
  type ProcedureManifest,
} from "@aotter/mantle-spec";
import type { Clock } from "../src/domain/port/Clock.js";
import type {
  DeferredHookEnvelope,
  DeferredHookDispatcher,
} from "../src/domain/port/DeferredHookDispatcher.js";
import type { IdGenerator } from "../src/domain/port/IdGenerator.js";
import { InMemoryHandlerRegistry } from "../src/domain/port/HandlerRegistry.js";
import { TriggerIndex } from "../src/domain/service/TriggerIndex.js";
import { LifecycleHookingEntryRepository } from "../src/infrastructure/persistence/LifecycleHookingEntryRepository.js";
import {
  CreateDraftUseCase,
  UpdateDraftUseCase,
  DeleteEntryUseCase,
  RequestPublishUseCase,
} from "../src/usecase/content/index.js";
import {
  RunDeferredHookUseCase,
  RunLifecycleHooksUseCase,
  type RunLifecycleHookRequest,
} from "../src/usecase/lifecycle/index.js";
import { InvokeProcedureUseCase } from "../src/usecase/procedure/InvokeProcedureUseCase.js";
import { InMemoryEntryRepository } from "./fakes/in-memory-store.js";
import {
  makeLifecycleTrigger,
  makeProcedure,
  postsSchema,
} from "./fakes/manifests.js";

const clock: Clock = { now: () => 1_700_000_000_000 };

function harnessIdGenerator(): IdGenerator {
  let call = 0;
  return { next: () => call++ === 0 ? "post-1" : `event-${call - 1}` };
}

interface Harness {
  store: InMemoryEntryRepository;
  hookedRepo: LifecycleHookingEntryRepository;
  registry: InMemoryHandlerRegistry;
  proceduresByName: ReadonlyMap<string, ProcedureManifest>;
  createDraft: CreateDraftUseCase;
  updateDraft: UpdateDraftUseCase;
  deleteEntry: DeleteEntryUseCase;
  requestPublish: RequestPublishUseCase;
  hookRunner: RunLifecycleHooksUseCase;
  calls: string[];
}

function harness(opts: {
  procedures: readonly ProcedureManifest[];
  triggers: readonly Parameters<typeof makeLifecycleTrigger>[0][];
  handlers: Record<string, (input: unknown, ctx: unknown) => unknown>;
  deferred?: DeferredHookDispatcher;
}): Harness {
  const store = new InMemoryEntryRepository();
  const schemas = new Map([[postsSchema().metadata.name, postsSchema()]]);
  const proceduresByName = new Map(opts.procedures.map((p) => [p.metadata.name, p]));
  const registry = new InMemoryHandlerRegistry();
  const calls: string[] = [];
  for (const [ref, fn] of Object.entries(opts.handlers)) {
    registry.register(ref, ((input: unknown, ctx: unknown) => {
      calls.push(ref);
      return fn(input, ctx);
    }) as unknown as Parameters<InMemoryHandlerRegistry["register"]>[1]);
  }
  const triggers = opts.triggers.map(makeLifecycleTrigger);
  const triggerIndex = new TriggerIndex(triggers);
  const idgen = harnessIdGenerator();
  const invoke = new InvokeProcedureUseCase(registry);
  const hookRunner = new RunLifecycleHooksUseCase(triggerIndex, proceduresByName, (req) =>
    invoke.execute(req),
  );
  const hookedRepo = new LifecycleHookingEntryRepository(
    store,
    triggerIndex,
    hookRunner,
    idgen,
    opts.deferred,
  );
  return {
    store,
    hookedRepo,
    registry,
    proceduresByName,
    calls,
    createDraft: new CreateDraftUseCase(hookedRepo, schemas, clock, idgen),
    updateDraft: new UpdateDraftUseCase(hookedRepo, schemas, clock),
    deleteEntry: new DeleteEntryUseCase(hookedRepo, schemas),
    requestPublish: new RequestPublishUseCase(hookedRepo, schemas, clock),
    hookRunner,
  };
}

const captchaProcedure: ProcedureManifest = makeProcedure({
  name: "captchaCheck",
  handlerRef: "captchaCheck",
  input: { type: "object" },
  output: { type: "object" },
});

const slackProcedure: ProcedureManifest = makeProcedure({
  name: "slackNotify",
  handlerRef: "slackNotify",
  input: { type: "object" },
  output: { type: "object" },
});

function deferredEnvelope(
  overrides: Partial<DeferredHookEnvelope> = {},
): DeferredHookEnvelope {
  return {
    version: 1,
    eventId: "event-1",
    triggerNames: ["create-audit"],
    hook: "after_create",
    schema: "posts",
    entry: {
      id: "post-1",
      collection: "posts",
      status: "draft",
      version: 1,
      data: {},
      authorId: null,
      createdAt: 0,
      updatedAt: 0,
    },
    ctxSnapshot: null,
    ...overrides,
  };
}

describe("LifecycleHookingEntryRepository — before_create", () => {
  it("fires before_create then writes when handler returns OK", async () => {
    const h = harness({
      procedures: [captchaProcedure],
      triggers: [
        {
          procedure: "captchaCheck",
          schema: "posts",
          on: ["before_create"],
          errorPolicy: "abort",
        },
      ],
      handlers: { captchaCheck: () => ({ ok: true }) },
    });
    const row = await h.createDraft.execute({
      collection: "posts",
      data: { title: "Hello" },
      authorId: null,
    });
    expect(h.calls).toEqual(["captchaCheck"]);
    expect(row.status).toBe("draft");
    expect(await h.store.get(row.id)).not.toBeNull();
  });

  it("aborts the create when before_create handler throws (errorPolicy default)", async () => {
    const h = harness({
      procedures: [captchaProcedure],
      triggers: [
        {
          procedure: "captchaCheck",
          schema: "posts",
          on: ["before_create"],
        },
      ],
      handlers: {
        captchaCheck: () => {
          throw new Error("captcha failed");
        },
      },
    });
    await expect(
      h.createDraft.execute({
        collection: "posts",
        data: { title: "x" },
        authorId: null,
      }),
    ).rejects.toBeInstanceOf(DiagnosticError);
    // Ensure no row was written.
    const result = await h.store.list({ collection: "posts" });
    expect(result.rows).toHaveLength(0);
  });

  it("does NOT abort when errorPolicy is overridden to 'continue' on a before_* hook", async () => {
    const h = harness({
      procedures: [captchaProcedure],
      triggers: [
        {
          procedure: "captchaCheck",
          schema: "posts",
          on: ["before_create"],
          errorPolicy: "continue",
        },
      ],
      handlers: {
        captchaCheck: () => {
          throw new Error("captcha hiccup");
        },
      },
    });
    const row = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    expect(row.id).toBe("post-1");
  });
});

describe("LifecycleHookingEntryRepository — after_*", () => {
  it("fires after_create after write completes", async () => {
    const h = harness({
      procedures: [slackProcedure],
      triggers: [
        {
          procedure: "slackNotify",
          schema: "posts",
          on: ["after_create"],
        },
      ],
      handlers: { slackNotify: () => ({ ok: true }) },
    });
    await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    expect(h.calls).toEqual(["slackNotify"]);
  });

  it("rides on ctx.waitUntil when adapter populates it", async () => {
    let captured: Promise<unknown> | null = null;
    const h = harness({
      procedures: [slackProcedure],
      triggers: [
        {
          procedure: "slackNotify",
          schema: "posts",
          on: ["after_create"],
        },
      ],
      handlers: { slackNotify: () => ({ ok: true }) },
    });
    await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
      ctx: {
        user: null,
        staff: null,
        env: {},
        waitUntil: (p) => {
          captured = p;
        },
      },
    });
    expect(captured).not.toBeNull();
    await captured;
    expect(h.calls).toEqual(["slackNotify"]);
  });

  it("after_* handler throw is logged and swallowed (errorPolicy continue default)", async () => {
    const h = harness({
      procedures: [slackProcedure],
      triggers: [
        {
          procedure: "slackNotify",
          schema: "posts",
          on: ["after_create"],
        },
      ],
      handlers: {
        slackNotify: () => {
          throw new Error("slack down");
        },
      },
    });
    // No throw expected from the create itself.
    const row = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    expect(row.id).toBe("post-1");
  });
});

describe("LifecycleHookingEntryRepository — publish + delete", () => {
  it("transitionStatus({to: 'published'}) fires before_publish + after_publish", async () => {
    const h = harness({
      procedures: [slackProcedure],
      triggers: [
        {
          procedure: "slackNotify",
          schema: "posts",
          on: ["before_publish", "after_publish"],
        },
      ],
      handlers: { slackNotify: () => ({ ok: true }) },
    });
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    h.calls.length = 0;
    await h.requestPublish.execute({ id: created.id });
    expect(h.calls).toEqual(["slackNotify", "slackNotify"]);
  });

  it("delete fires before_delete + after_delete", async () => {
    const h = harness({
      procedures: [slackProcedure],
      triggers: [
        {
          procedure: "slackNotify",
          schema: "posts",
          on: ["before_delete", "after_delete"],
        },
      ],
      handlers: { slackNotify: () => ({ ok: true }) },
    });
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    h.calls.length = 0;
    await h.deleteEntry.execute({ id: created.id });
    expect(h.calls).toEqual(["slackNotify", "slackNotify"]);
  });

  it("short-circuits when no Trigger watches the collection", async () => {
    const h = harness({
      procedures: [],
      triggers: [],
      handlers: {},
    });
    const row = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    expect(row.id).toBe("post-1");
    expect(h.calls).toEqual([]);
  });

  it("does NOT fire before_* hooks when the row doesn't exist (null-entry guard)", async () => {
    const h = harness({
      procedures: [
        makeProcedure({
          name: "audit",
          handlerRef: "audit",
          input: { type: "object" },
          output: { type: "object" },
        }),
      ],
      triggers: [
        {
          procedure: "audit",
          schema: "posts",
          on: ["before_delete", "before_update"],
        },
      ],
      handlers: {
        audit: () => ({ ok: true }),
      },
    });
    // Direct repo call (bypassing use cases that pre-check NOT_FOUND):
    // simulates the InvokeBuiltinUseCase opDelete path which doesn't
    // pre-verify the row exists.
    await h.hookedRepo.delete({
      id: "ghost",
      collection: "posts",
      expectedStatus: "draft",
      expectedVersion: 1,
    });
    expect(h.calls).toEqual([]);
    // OCC will throw on a ghost update at the inner repo, but the hook
    // must not fire either way — wrap in try/catch.
    await h.hookedRepo
      .update({ id: "ghost", collection: "posts", expectedVersion: 1, data: {}, now: 0 })
      .catch(() => undefined);
    expect(h.calls).toEqual([]);
  });
});

describe("LifecycleHookingEntryRepository — deferred dispatcher (after_*)", () => {
  it("enqueues envelope through dispatcher and skips inline run", async () => {
    const enqueued: DeferredHookEnvelope[] = [];
    const dispatcher: DeferredHookDispatcher = {
      enqueue: async (envelope) => {
        enqueued.push(envelope);
      },
    };
    const h = harness({
      procedures: [slackProcedure, captchaProcedure],
      triggers: [
        {
          name: "030-notify",
          procedure: "slackNotify",
          schema: "posts",
          on: ["after_create"],
        },
        {
          name: "010-audit",
          procedure: "captchaCheck",
          schema: "posts",
          on: ["after_create"],
        },
      ],
      handlers: {
        slackNotify: () => ({ ok: true }),
        captchaCheck: () => ({ ok: true }),
      },
      deferred: dispatcher,
    });
    await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    // Inline handler must NOT have run when dispatcher accepted the envelope.
    expect(h.calls).toEqual([]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.hook).toBe("after_create");
    expect(enqueued[0]?.schema).toBe("posts");
    expect(enqueued[0]?.entry.id).toBe("post-1");
    expect(enqueued[0]?.version).toBe(1);
    expect(enqueued[0]?.eventId).toBe("event-1");
    expect(enqueued[0]?.triggerNames).toEqual(["010-audit", "030-notify"]);
    expect(enqueued[0]).not.toHaveProperty("originalInput");
    // Anonymous create → no ctx snapshot.
    expect(enqueued[0]?.ctxSnapshot).toBeNull();
  });

  it("captures ctxSnapshot from staff actor", async () => {
    const enqueued: DeferredHookEnvelope[] = [];
    const dispatcher: DeferredHookDispatcher = {
      enqueue: async (envelope) => {
        enqueued.push(envelope);
      },
    };
    const h = harness({
      procedures: [slackProcedure],
      triggers: [
        {
          procedure: "slackNotify",
          schema: "posts",
          on: ["after_create"],
        },
      ],
      handlers: { slackNotify: () => ({ ok: true }) },
      deferred: dispatcher,
    });
    await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: "user-1",
      ctx: {
        user: { id: "user-1" },
        staff: { id: "user-1", role: "owner" },
        env: {},
      },
    });
    expect(enqueued[0]?.ctxSnapshot).toEqual({
      userId: "user-1",
      staffId: "user-1",
      staffRole: "owner",
      auth: null,
    });
  });

  it("falls back to ctx.waitUntil when dispatcher rejects", async () => {
    const dispatcher: DeferredHookDispatcher = {
      enqueue: async () => {
        throw new Error("queue 5xx");
      },
    };
    let captured: Promise<unknown> | null = null;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({
      procedures: [slackProcedure],
      triggers: [
        {
          procedure: "slackNotify",
          schema: "posts",
          on: ["after_create"],
        },
      ],
      handlers: { slackNotify: () => ({ ok: true }) },
      deferred: dispatcher,
    });
    await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
      ctx: {
        user: null,
        staff: null,
        env: {},
        waitUntil: (p) => {
          captured = p;
        },
      },
    });
    expect(captured).not.toBeNull();
    await captured;
    expect(h.calls).toEqual(["slackNotify"]);
    expect(errSpy).toHaveBeenCalledWith(
      "[lifecycle] deferred enqueue failed; using best-effort fallback",
      expect.objectContaining({
        eventId: "event-1",
        hook: "after_create",
        schema: "posts",
        entryId: "post-1",
      }),
    );
    errSpy.mockRestore();
  });

  it("falls back to inline-await when dispatcher rejects and waitUntil absent", async () => {
    const dispatcher: DeferredHookDispatcher = {
      enqueue: async () => {
        throw new Error("queue down");
      },
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({
      procedures: [slackProcedure],
      triggers: [
        {
          procedure: "slackNotify",
          schema: "posts",
          on: ["after_create"],
        },
      ],
      handlers: { slackNotify: () => ({ ok: true }) },
      deferred: dispatcher,
    });
    await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    expect(h.calls).toEqual(["slackNotify"]);
    errSpy.mockRestore();
  });

  it("never forwards side-channel input to an after_* hook", async () => {
    let received: unknown;
    const captureProcedure = makeProcedure({
      name: "captureAfter",
      handlerRef: "captureAfter",
      input: {
        type: "object",
        properties: {
          title: { type: "string" },
          recaptchaToken: { type: "string" },
        },
      },
      output: { type: "object" },
    });
    const dispatcher: DeferredHookDispatcher = {
      enqueue: async () => {
        throw new Error("ambiguous send failure");
      },
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({
      procedures: [captureProcedure],
      triggers: [{ procedure: "captureAfter", schema: "posts", on: ["after_create"] }],
      handlers: {
        captureAfter: (input) => {
          received = input;
          return { ok: true };
        },
      },
      deferred: dispatcher,
    });
    await h.createDraft.execute({
      collection: "posts",
      data: { title: "persisted" },
      originalInput: { title: "persisted", recaptchaToken: "secret" },
      authorId: null,
    });
    expect(received).toEqual({ title: "persisted" });
    errSpy.mockRestore();
  });

  it("reuses one event identity across an ambiguous enqueue fallback and replay", async () => {
    let envelope: DeferredHookEnvelope | undefined;
    const identities: string[] = [];
    const dispatcher: DeferredHookDispatcher = {
      enqueue: async (message) => {
        envelope = message;
        throw new Error("send outcome unknown");
      },
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({
      procedures: [slackProcedure],
      triggers: [{ name: "010-notify", procedure: "slackNotify", on: ["after_create"] }],
      handlers: {
        slackNotify: (_input, rawCtx) => {
          const ctx = rawCtx as { event?: { id: string; trigger: string } };
          identities.push(`${ctx.event?.id}:${ctx.event?.trigger}`);
          return { ok: true };
        },
      },
      deferred: dispatcher,
    });
    await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    expect(envelope).toBeDefined();
    await new RunDeferredHookUseCase(h.hookRunner).execute({ envelope, env: {} });
    expect(identities).toEqual(["event-1:010-notify", "event-1:010-notify"]);
    errSpy.mockRestore();
  });

  it("does NOT route before_* hooks through the dispatcher", async () => {
    const enqueued: DeferredHookEnvelope[] = [];
    const dispatcher: DeferredHookDispatcher = {
      enqueue: async (envelope) => {
        enqueued.push(envelope);
      },
    };
    const h = harness({
      procedures: [captchaProcedure],
      triggers: [
        {
          procedure: "captchaCheck",
          schema: "posts",
          on: ["before_create"],
          errorPolicy: "abort",
        },
      ],
      handlers: { captchaCheck: () => ({ ok: true }) },
      deferred: dispatcher,
    });
    await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    expect(h.calls).toEqual(["captchaCheck"]);
    expect(enqueued).toEqual([]);
  });
});

describe("RunDeferredHookUseCase", () => {
  it("rebuilds ctx from snapshot and forwards to hook runner", async () => {
    let received: RunLifecycleHookRequest | null = null;
    const stubRunner = {
      run: async (request: RunLifecycleHookRequest) => {
        received = request;
      },
    };
    const useCase = new RunDeferredHookUseCase(stubRunner);
    const envelope = deferredEnvelope({
      eventId: "event-9",
      triggerNames: ["publish-audit"],
      hook: "after_publish",
      entry: {
        id: "post-9",
        collection: "posts",
        status: "published",
        version: 2,
        data: { title: "Hi" },
        authorId: "user-1",
        createdAt: 1,
        updatedAt: 2,
      },
      ctxSnapshot: {
        userId: "user-1",
        staffId: "user-1",
        staffRole: "editor",
        auth: {
          credential: "oauth",
          credentialId: "grant-1",
          clientId: "client-1",
          scopes: ["mcp"],
        },
      },
    });
    const env = { MANTLE_INTERNAL_QUEUE: "fake" };
    await useCase.execute({ envelope, env });
    expect(received).toEqual({
      eventId: "event-9",
      triggerNames: ["publish-audit"],
      delivery: "deferred",
      hook: "after_publish",
      schema: "posts",
      entry: envelope.entry,
      ctx: {
        user: { id: "user-1" },
        staff: { id: "user-1", role: "editor" },
        auth: {
          credential: "oauth",
          credentialId: "grant-1",
          clientId: "client-1",
          scopes: ["mcp"],
        },
        env,
      },
    });
  });

  it("rebuilds anonymous ctx when snapshot is null", async () => {
    let receivedCtx: { user: unknown; staff: unknown; env: unknown } | null = null;
    const stubRunner = {
      run: async (req: { ctx: { user: unknown; staff: unknown; env: unknown } }) => {
        receivedCtx = req.ctx;
      },
    };
    const useCase = new RunDeferredHookUseCase(stubRunner);
    const envelope = deferredEnvelope();
    await useCase.execute({ envelope, env: {} });
    expect(receivedCtx).toEqual({ user: null, staff: null, env: {} });
  });

  it.each([
    ["missing version", ({ version: _version, ...rest }) => rest],
    ["unsupported version", (value) => ({ ...value, version: 2 })],
    ["before hook", (value) => ({ ...value, hook: "before_create" })],
    ["duplicate trigger", (value) => ({ ...value, triggerNames: ["audit", "audit"] })],
    ["collection mismatch", (value) => ({
      ...value,
      entry: { ...value.entry, collection: "pages" },
    })],
    ["legacy originalInput", (value) => ({ ...value, originalInput: { token: "secret" } })],
    ["non-JSON entry data", (value) => ({
      ...value,
      entry: { ...value.entry, data: { bad: undefined } },
    })],
    ["inconsistent staff snapshot", (value) => ({
      ...value,
      ctxSnapshot: {
        userId: "user-1",
        staffId: "staff-2",
        staffRole: "editor",
        auth: null,
      },
    })],
  ] as const)("rejects malformed envelope: %s", async (_name, mutate) => {
    let called = false;
    const useCase = new RunDeferredHookUseCase({
      run: async () => {
        called = true;
      },
    });
    const base = deferredEnvelope({ triggerNames: ["audit"] });
    await expect(useCase.execute({ envelope: mutate(base), env: {} })).rejects.toMatchObject({
      diagnostic: { code: "INPUT_VALIDATION_FAILED" },
    });
    expect(called).toBe(false);
  });

  it("runs every captured Trigger before surfacing deferred failure, then preserves replay keys", async () => {
    let failMiddle = true;
    const seen: string[] = [];
    const procedures = ["first", "middle", "last"].map((name) =>
      makeProcedure({
        name,
        handlerRef: name,
        input: { type: "object" },
        output: { type: "object" },
      }),
    );
    const h = harness({
      procedures,
      triggers: [
        { name: "010-first", procedure: "first", on: ["after_create"] },
        { name: "020-middle", procedure: "middle", on: ["after_create"] },
        { name: "030-last", procedure: "last", on: ["after_create"] },
      ],
      handlers: Object.fromEntries(procedures.map(({ metadata }) => [
        metadata.name,
        (_input: unknown, rawCtx: unknown) => {
          const ctx = rawCtx as { event: { id: string; trigger: string } };
          seen.push(`${ctx.event.id}:${ctx.event.trigger}`);
          if (metadata.name === "middle" && failMiddle) throw new Error("transient");
          return {};
        },
      ])),
    });
    const envelope = deferredEnvelope({
      eventId: "event-stable",
      triggerNames: ["010-first", "020-middle", "030-last"],
      entry: {
        id: "post-1",
        collection: "posts",
        status: "draft",
        version: 1,
        data: { title: "x" },
        authorId: null,
        createdAt: 0,
        updatedAt: 0,
      },
    });
    const useCase = new RunDeferredHookUseCase(h.hookRunner);
    await expect(useCase.execute({ envelope, env: {} })).rejects.toBeInstanceOf(AggregateError);
    expect(seen).toEqual([
      "event-stable:010-first",
      "event-stable:020-middle",
      "event-stable:030-last",
    ]);

    failMiddle = false;
    await useCase.execute({ envelope, env: {} });
    expect(seen.slice(3)).toEqual(seen.slice(0, 3));
  });

  it("rejects a captured Trigger that no longer exists", async () => {
    const h = harness({ procedures: [], triggers: [], handlers: {} });
    await expect(new RunDeferredHookUseCase(h.hookRunner).execute({
      envelope: deferredEnvelope({
        eventId: "event-old",
        triggerNames: ["removed-trigger"],
      }),
      env: {},
    })).rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
  });
});

describe("LifecycleHookingEntryRepository — multi-trigger ordering", () => {
  it("fires Triggers in alphabetical order by metadata.name", async () => {
    const permissive = { input: { type: "object" }, output: { type: "object" } };
    const h = harness({
      procedures: [
        makeProcedure({ name: "p1", handlerRef: "h1", ...permissive }),
        makeProcedure({ name: "p2", handlerRef: "h2", ...permissive }),
        makeProcedure({ name: "p3", handlerRef: "h3", ...permissive }),
      ],
      triggers: [
        { name: "030-third", procedure: "p3", schema: "posts", on: ["before_create"] },
        { name: "010-first", procedure: "p1", schema: "posts", on: ["before_create"] },
        { name: "020-second", procedure: "p2", schema: "posts", on: ["before_create"] },
      ],
      handlers: {
        h1: () => ({ ok: true }),
        h2: () => ({ ok: true }),
        h3: () => ({ ok: true }),
      },
    });
    await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    expect(h.calls).toEqual(["h1", "h2", "h3"]);
  });
});
