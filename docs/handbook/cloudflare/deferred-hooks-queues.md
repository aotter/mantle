---
description: Move after_* lifecycle Triggers onto Cloudflare Queues with at-least-once delivery, idempotent handlers and a DLQ.
---
# Deferred hooks with Queues

`after_create`, `after_update`, `after_delete` and `after_publish` lifecycle Triggers run inline by default. Binding a Cloudflare Queue moves them off the request path. This page covers the guarantees, the setup, the Worker wiring and how to write handlers that survive replay.

## When to defer

Defer hooks that must not add request latency and that tolerate a short delay: notifications, projections, upstream API calls. Keep synchronous `before_*` hooks for validation and abuse prevention; they may read request-only input such as a CAPTCHA token, which deferred envelopes never retain.

## Guarantees

- The entry write commits first. D1 and the Queue do not share a transaction, so a Worker failure between them can lose the enqueue.
- Delivery is at-least-once. A message can run more than once.
- A rejected or ambiguous `Queue.send()` falls back to `ctx.waitUntil` (or inline when unavailable) with the same event identity. That fallback is best-effort.
- A consumer runs every captured Trigger before acknowledging; a later failure can replay an earlier success.
- Malformed, oversized, removed-Trigger and persistently failing messages are retried and then land in the dead-letter queue. Without a DLQ, Cloudflare discards them after `max_retries`.

Handlers must therefore be idempotent. Mantle does not promise exactly-once execution.

## The v1 envelope

```ts
interface DeferredHookEnvelope {
  version: 1;
  eventId: string;
  triggerNames: readonly string[];
  hook: "after_create" | "after_update" | "after_delete" | "after_publish";
  schema: string;
  entry: EntryRow;
  ctxSnapshot: CtxSnapshot | null;
}
```

Each handler receives the persisted `entry.data` as input and `ctx.event = { id, trigger, hook, schema, entry }`. Use `${ctx.event.id}:${ctx.event.trigger}` as the idempotency key; it is stable across fallback, retries and replay. `ctxSnapshot` holds normalized actor and credential metadata, never cookies, tokens or API keys.

Cloudflare's 128 KB message limit is decimal and includes platform metadata. The dispatcher rejects non-JSON-safe envelopes and any encoded envelope of 127,000 bytes or more before calling `Queue.send`. Keep entry payloads well below that.

## Setup

```sh
pnpm wrangler queues create mantle-internal
pnpm wrangler queues create mantle-internal-dlq
```

```jsonc
"queues": {
  "producers": [{ "binding": "MANTLE_INTERNAL_QUEUE", "queue": "mantle-internal" }],
  "consumers": [{
    "queue": "mantle-internal",
    "max_batch_size": 10,
    "max_batch_timeout": 5,
    "max_retries": 5,
    "retry_delay": 60,
    "dead_letter_queue": "mantle-internal-dlq"
  }]
}
```

These are adapter settings, not manifest grammar. See [Trigger](../reference/trigger.md) for the `lifecycle` source shape.

## Worker wiring

```ts
import type { DeferredHookEnvelope } from "@aotter/mantle/runtime";
import {
  WorkersQueueHookDispatcher,
  createMantleWorker,
  createQueueHandler,
  type MantleCloudflareEnv,
} from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

interface Env extends MantleCloudflareEnv {
  readonly MANTLE_INTERNAL_QUEUE: Queue<DeferredHookEnvelope>;
}

const worker = createMantleWorker<Env>({
  plan,
  handlers,
  bindings: (env, conventional) => ({
    ...conventional,
    deferredHookDispatcher: new WorkersQueueHookDispatcher(env.MANTLE_INTERNAL_QUEUE),
  }),
});

export default {
  fetch: worker.fetch,
  queue(batch, env) {
    return createQueueHandler<Env>({ get: () => worker.getRuntime(env) })(batch, env);
  },
} satisfies ExportedHandler<Env>;
```

The same Worker is producer and consumer. Opt-in adds only the dispatcher binding and the `queue` export; Auth, MCP, cache and runtime assembly stay on the standard path.

## Multiplexing application queues

Route on `batch.queue` when the Worker also consumes its own queues:

```ts
queue(batch, env, ctx) {
  const mantleQueue = createQueueHandler<Env>({ get: () => worker.getRuntime(env) });
  switch (batch.queue) {
    case "mantle-internal": return mantleQueue(batch, env);
    case "billing-jobs": return consumeBilling(batch, env, ctx);
    default:
      batch.retryAll();
      console.error(`No consumer for queue '${batch.queue}'`);
  }
}
```

Application consumers own their own acknowledgement. A common pattern is to `bindMantle(await worker.getRuntime(env))` and call a Procedure, then `ack()` on success, `retry()` on `INTERNAL_ERROR` or `CONFLICT`, and `ack()` on other diagnostics so a poison message does not loop. See [Bindings](./bindings.md#queues).

## Consumer semantics

- At most five messages run concurrently within a delivered batch, even if `max_batch_size` is higher.
- Runtime boot failure calls `batch.retryAll()` so per-message attempt counters advance and `max_retries` and the DLQ apply.
- Each message is acknowledged exactly once after every captured Trigger succeeds; any failure calls `retry()` on that message only.

## An idempotent D1 handler

Make the event key a unique database key:

```sql
CREATE TABLE notification_jobs (
  idempotency_key TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

```ts
import type { HandlerContext } from "@aotter/mantle/runtime";

export async function enqueueNotification(input: Record<string, unknown>, ctx: HandlerContext) {
  if (!ctx.event?.entry) throw new Error("lifecycle entry event required");
  const key = `${ctx.event.id}:${ctx.event.trigger}`;
  await (ctx.env as Env).DB.prepare(
    `INSERT OR IGNORE INTO notification_jobs (idempotency_key, entry_id, payload, created_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(key, ctx.event.entry.id, JSON.stringify(input), Date.now()).run();
  return { ok: true };
}
```

For an upstream API, send the same key as `Idempotency-Key` and throw on a non-OK response so the Queue retries. Core adds no outbox, job registry or provider retry wrapper; those remain application-owned.

## The removed-Trigger footgun

`triggerNames` is captured when the mutation runs. Renaming or removing a captured Trigger makes every older message fail validation at dispatch and eventually reach the DLQ; it never silently changes meaning. Drain the queue before removing a deferred Trigger, and inspect the DLQ before raising `max_retries`.

## Verify

In the SDK checkout the contract test is:

```sh
pnpm --filter @aotter/mantle-cloudflare test -- mantle-internal-queue.test.ts
```

For a site, run `wrangler dev`, submit a mutation that has an `after_*` Trigger, and read the consumer log. Make one handler fail once and confirm the replay carries the same `ctx.event.id` and `ctx.event.trigger`.

## Source
- [`docs/deferred-lifecycle-queues.md`](../../../docs/deferred-lifecycle-queues.md)
- [`packages/adapters/cloudflare/src/bindings/WorkersQueueHookDispatcher.ts`](../../../packages/adapters/cloudflare/src/bindings/WorkersQueueHookDispatcher.ts)
- [`packages/adapters/cloudflare/src/mount/cmsConfig.ts`](../../../packages/adapters/cloudflare/src/mount/cmsConfig.ts)
- [`packages/adapters/cloudflare/README.md`](../../../packages/adapters/cloudflare/README.md)
- Retired-starter pattern: [`overlays/transaction/src/index.ts`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/transaction/src/index.ts)
