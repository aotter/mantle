import { describe, expect, it, vi } from "vitest";
import type {
  AssetServer,
  DatabaseDriver,
  DeferredHookEnvelope,
  CmsRuntime,
} from "@aotter/mantle-runtime";
import { createCmsRuntime } from "@aotter/mantle-runtime";
import type { LifecycleHook } from "@aotter/mantle-spec";
import {
  WorkersQueueHookDispatcher,
  createQueueHandler,
} from "../src/bindings/WorkersQueueHookDispatcher.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import {
  makeLifecycleTrigger,
  makeProcedure,
  postsSchema,
} from "../../../mantle-runtime/test/fakes/manifests.js";
import { StubAssetServer } from "./fakes/runtime-bindings.js";

interface CapturedSend<T> {
  body: T;
  options?: unknown;
}

function fakeQueue<T>(): Queue<T> & { captured: CapturedSend<T>[] } {
  const captured: CapturedSend<T>[] = [];
  const queue = {
    captured,
    send: async (body: T, options?: unknown) => {
      captured.push({ body, options });
    },
    sendBatch: async (messages: ReadonlyArray<{ body: T }>) => {
      for (const m of messages) captured.push({ body: m.body });
    },
  } as unknown as Queue<T> & { captured: CapturedSend<T>[] };
  return queue;
}

interface FakeMessage<T> {
  body: T;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function fakeBatch<T>(envelopes: T[]): {
  batch: MessageBatch<T>;
  messages: FakeMessage<T>[];
  retryAll: ReturnType<typeof vi.fn>;
} {
  const messages: FakeMessage<T>[] = envelopes.map((body) => ({
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  const retryAll = vi.fn();
  const batch = {
    queue: "mantle-internal",
    messages: messages.map((m, i) => ({
      id: `msg-${i}`,
      timestamp: new Date(),
      body: m.body,
      attempts: 1,
      ack: m.ack,
      retry: m.retry,
    })),
    ackAll: vi.fn(),
    retryAll,
  } as unknown as MessageBatch<T>;
  return { batch, messages, retryAll };
}

const sampleEnvelope: DeferredHookEnvelope = {
  version: 1,
  eventId: "event-1",
  triggerNames: ["publish-audit"],
  hook: "after_publish",
  schema: "posts",
  entry: {
    id: "post-1",
    collection: "posts",
    status: "published",
    version: 2,
    data: { title: "Hi" },
    authorId: null,
    createdAt: 0,
    updatedAt: 0,
  },
  ctxSnapshot: null,
};

function hookProcedure(name: string) {
  return makeProcedure({
    name,
    handlerRef: name,
    input: { type: "object" },
    output: { type: "object" },
  });
}

function lifecycleTrigger(name: string, procedure: string, on: LifecycleHook) {
  return makeLifecycleTrigger({ name, procedure, on: [on] });
}

describe("WorkersQueueHookDispatcher#enqueue", () => {
  it("forwards the envelope through queue.send", async () => {
    const queue = fakeQueue<DeferredHookEnvelope>();
    const dispatcher = new WorkersQueueHookDispatcher(queue);
    await dispatcher.enqueue(sampleEnvelope);
    expect(queue.captured).toEqual([{ body: sampleEnvelope, options: { contentType: "json" } }]);
  });

  it("propagates queue.send rejections so the runtime ladder downgrades", async () => {
    const queue = {
      send: async () => {
        throw new Error("queue 5xx");
      },
      sendBatch: async () => {},
    } as unknown as Queue<DeferredHookEnvelope>;
    const dispatcher = new WorkersQueueHookDispatcher(queue);
    await expect(dispatcher.enqueue(sampleEnvelope)).rejects.toThrow("queue 5xx");
  });
});

describe("createQueueHandler", () => {
  it("ack()s each message after runDeferredHook.execute resolves", async () => {
    const consumed: { envelope: DeferredHookEnvelope; env: unknown }[] = [];
    const cmsRef = {
      get: async (): Promise<CmsRuntime> =>
        ({
          runDeferredHook: {
            execute: async (request: { envelope: DeferredHookEnvelope; env: unknown }) => {
              consumed.push({ envelope: request.envelope, env: request.env });
            },
          },
        }) as unknown as CmsRuntime,
    };
    const handler = createQueueHandler<{ tag: string }>(cmsRef);
    const { batch, messages } = fakeBatch<DeferredHookEnvelope>([sampleEnvelope, sampleEnvelope]);
    await handler(batch, { tag: "env" });
    expect(consumed).toHaveLength(2);
    expect(consumed[0]?.env).toEqual({ tag: "env" });
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
  });

  it("retryAll()s without invoking per-message ack/retry when runtime boot fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cmsRef = {
      get: async (): Promise<CmsRuntime> => {
        throw new Error("d1 unreachable");
      },
    };
    const handler = createQueueHandler<unknown>(cmsRef);
    const { batch, messages, retryAll } = fakeBatch([sampleEnvelope, sampleEnvelope]);
    await handler(batch, {});
    expect(retryAll).toHaveBeenCalledOnce();
    // Per-message ack/retry MUST NOT have been called — the loop never started.
    for (const message of messages) {
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
    }
    errSpy.mockRestore();
  });

  it("retry()s the message and continues the batch when the hook throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let callCount = 0;
    const cmsRef = {
      get: async (): Promise<CmsRuntime> =>
        ({
          runDeferredHook: {
            execute: async () => {
              callCount++;
              if (callCount === 1) throw new Error("hook blew up");
            },
          },
        }) as unknown as CmsRuntime,
    };
    const handler = createQueueHandler<unknown>(cmsRef);
    const { batch, messages } = fakeBatch<DeferredHookEnvelope>([sampleEnvelope, sampleEnvelope]);
    await handler(batch, {});
    expect(messages[0]?.retry).toHaveBeenCalledOnce();
    expect(messages[0]?.ack).not.toHaveBeenCalled();
    expect(messages[1]?.ack).toHaveBeenCalledOnce();
    expect(messages[1]?.retry).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("bounds a configured batch to five concurrent hook executions", async () => {
    let active = 0;
    let maxActive = 0;
    const cmsRef = {
      get: async (): Promise<CmsRuntime> => ({
        runDeferredHook: {
          execute: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await Promise.resolve();
            active--;
          },
        },
      }) as unknown as CmsRuntime,
    };
    const handler = createQueueHandler<unknown>(cmsRef);
    const { batch, messages } = fakeBatch(Array.from({ length: 11 }, () => sampleEnvelope));
    await handler(batch, {});
    expect(maxActive).toBe(5);
    expect(messages.every((message) => message.ack.mock.calls.length === 1)).toBe(true);
  });

  it("integrates real runtime failure propagation, retry, and stable replay identity", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let failMiddle = true;
    const seen: string[] = [];
    const names = ["010-first", "020-middle", "030-last"] as const;
    const runtime = createCmsRuntime({
      manifests: [
        hookProcedure("first"),
        hookProcedure("middle"),
        hookProcedure("last"),
        lifecycleTrigger(names[0], "first", "after_publish"),
        lifecycleTrigger(names[1], "middle", "after_publish"),
        lifecycleTrigger(names[2], "last", "after_publish"),
      ],
      handlers: {
        first: (_input, ctx) => {
          seen.push(`${ctx.event?.id}:${ctx.event?.trigger}`);
          return {};
        },
        middle: (_input, ctx) => {
          seen.push(`${ctx.event?.id}:${ctx.event?.trigger}`);
          if (failMiddle) throw new Error("transient");
          return {};
        },
        last: (_input, ctx) => {
          seen.push(`${ctx.event?.id}:${ctx.event?.trigger}`);
          return {};
        },
      },
      db: {} as DatabaseDriver,
      assets: {} as AssetServer,
    });
    const handler = createQueueHandler<unknown>({ get: async () => runtime });
    const envelope = { ...sampleEnvelope, eventId: "event-stable", triggerNames: names };

    const malformed = fakeBatch<unknown>([
      null,
      { ...envelope, version: 2 },
    ]);
    await handler(malformed.batch, {});
    for (const message of malformed.messages) {
      expect(message.retry).toHaveBeenCalledOnce();
      expect(message.ack).not.toHaveBeenCalled();
    }
    expect(seen).toEqual([]);

    const first = fakeBatch([envelope]);
    await handler(first.batch, {});
    expect(first.messages[0]?.retry).toHaveBeenCalledOnce();
    expect(first.messages[0]?.ack).not.toHaveBeenCalled();
    expect(seen).toEqual(names.map((name) => `event-stable:${name}`));

    failMiddle = false;
    const replay = fakeBatch([envelope]);
    await handler(replay.batch, {});
    expect(replay.messages[0]?.ack).toHaveBeenCalledOnce();
    expect(replay.messages[0]?.retry).not.toHaveBeenCalled();
    expect(seen.slice(3)).toEqual(seen.slice(0, 3));
    errSpy.mockRestore();
  });

  it("integrates queue rejection, mutation fallback, and stable replay identity", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const captured: DeferredHookEnvelope[] = [];
    const rejectingQueue = {
      send: async (body: DeferredHookEnvelope) => {
        captured.push(body);
        throw new Error("ambiguous queue failure");
      },
      sendBatch: async () => {},
    } as unknown as Queue<DeferredHookEnvelope>;
    const deferredHookDispatcher = new WorkersQueueHookDispatcher(rejectingQueue);
    const seen: string[] = [];
    let nextId = 1;
    const runtime = createCmsRuntime({
      manifests: [
        postsSchema(),
        hookProcedure("create-audit"),
        lifecycleTrigger("create-audit-trigger", "create-audit", "after_create"),
      ],
      handlers: {
        "create-audit": (_input, ctx) => {
          seen.push(`${ctx.event?.id}:${ctx.event?.trigger}`);
          return {};
        },
      },
      db: new InMemoryDatabase(),
      assets: new StubAssetServer(),
      deferredHookDispatcher,
      clock: { now: () => 1 },
      idgen: { next: () => `id-${nextId++}` },
    });

    await runtime.createDraft.execute({
      collection: "posts",
      data: { title: "Fallback" },
      authorId: "author-1",
      ctx: {
        user: { id: "author-1" },
        staff: null,
        env: {},
      },
    });

    expect(captured).toHaveLength(1);
    expect(seen).toHaveLength(1);
    await runtime.runDeferredHook.execute({ envelope: captured[0], env: {} });
    expect(seen).toEqual([seen[0], seen[0]]);
    errSpy.mockRestore();
  });
});

describe("WorkersQueueHookDispatcher envelope limits", () => {
  it("rejects non-JSON data before queue.send", async () => {
    const queue = fakeQueue<DeferredHookEnvelope>();
    const dispatcher = new WorkersQueueHookDispatcher(queue);
    const invalid = {
      ...sampleEnvelope,
      entry: { ...sampleEnvelope.entry, data: { bad: undefined } },
    } as unknown as DeferredHookEnvelope;
    await expect(dispatcher.enqueue(invalid)).rejects.toThrow("not JSON-safe");

    const cyclicData: Record<string, unknown> = {};
    cyclicData["self"] = cyclicData;
    await expect(dispatcher.enqueue({
      ...sampleEnvelope,
      entry: { ...sampleEnvelope.entry, data: cyclicData },
    })).rejects.toThrow("not JSON-safe");
    expect(queue.captured).toEqual([]);
  });

  it("reserves metadata headroom under Cloudflare's decimal 128 KB limit", async () => {
    const queue = fakeQueue<DeferredHookEnvelope>();
    const dispatcher = new WorkersQueueHookDispatcher(queue);
    const oversized: DeferredHookEnvelope = {
      ...sampleEnvelope,
      entry: {
        ...sampleEnvelope.entry,
        data: { payload: "x".repeat(127_000) },
      },
    };
    await expect(dispatcher.enqueue(oversized)).rejects.toThrow("requires less than 127000");
    expect(queue.captured).toEqual([]);
  });
});
