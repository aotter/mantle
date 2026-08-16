# Deferred lifecycle hooks on Cloudflare Queues

Mantle can opt `after_*` lifecycle Triggers into a Cloudflare Queue. This is
useful for notifications and projections that should not add request latency,
but it is not an exactly-once transaction boundary.

## Contract

- The entry write commits before Queue delivery. D1 and Queue do not share a
  transaction, so a Worker failure can still occur in that gap.
- A resolved `Queue.send()` means Cloudflare accepted the message. Consumption
  is at-least-once; a message can run more than once.
- A rejected or ambiguous send falls back with the same event identity through
  `ctx.waitUntil`, or inline when `waitUntil` is unavailable. `waitUntil` is
  best-effort and does not close the D1-to-Queue gap.
- A consumer acknowledges a message only after every captured Trigger
  succeeds. It runs all captured Triggers before surfacing failures, so a later
  failure can replay an earlier success.
- Malformed, unsupported, removed-Trigger, and persistently failing messages
  are retried and then sent to the configured dead-letter queue (DLQ). Without
  a DLQ, Cloudflare discards them after `max_retries`.

Deferred handlers must therefore be idempotent. Mantle does not promise
exactly-once execution.

## Version 1 event

The strict v1 envelope contains:

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

`triggerNames` is captured when the entry mutation runs. A later deployment
does not add a new Trigger to an old event. Removing or renaming a captured
Trigger makes that old message fail validation at dispatch and eventually
reach the DLQ instead of silently changing its meaning.

Each handler receives persisted `entry.data` as its input and:

```ts
ctx.event = {
  id: envelope.eventId,
  trigger: currentTriggerName,
  hook: envelope.hook,
  schema: envelope.schema,
  entry: envelope.entry,
};
```

Use `${ctx.event.id}:${ctx.event.trigger}` as the handler's idempotency key.
The same key survives enqueue fallback, Queue retries, and replay. Synchronous
`before_*` hooks may still receive pre-projection request input such as a
CAPTCHA token; deferred `after_*` envelopes never retain that input. The
identity snapshot contains normalized actor and credential metadata, never raw
cookies, tokens, or API keys.

Cloudflare's 128 KB limit is decimal and includes platform metadata. The
adapter therefore rejects non-JSON envelopes and encoded envelopes at or above
127,000 bytes before calling `Queue.send`, leaving at least 1 KB of headroom.
Keep entry payloads smaller than that supported limit.

## Cloudflare opt-in

Create the internal queue and its DLQ:

```sh
pnpm wrangler queues create mantle-internal
pnpm wrangler queues create mantle-internal-dlq
```

Add both producer and consumer bindings. These are adapter settings, not Mantle
manifest grammar:

```toml
[[queues.producers]]
binding = "MANTLE_INTERNAL_QUEUE"
queue = "mantle-internal"

[[queues.consumers]]
queue = "mantle-internal"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 5
retry_delay = 60
dead_letter_queue = "mantle-internal-dlq"
```

Wire the producer into `CmsConfig.bindings` and export the consumer alongside
the existing HTTP/OAuth handler. The same Worker may be both producer and
consumer:

```ts
import type { DeferredHookEnvelope } from "@aotter/mantle/runtime";
import {
  AssetsAssetServer,
  D1DatabaseDriver,
  WorkersQueueHookDispatcher,
  createCmsRef,
  createQueueHandler,
  createOAuthProvider,
} from "@aotter/mantle/cloudflare";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MANTLE_INTERNAL_QUEUE: Queue<DeferredHookEnvelope>;
}

function buildWorker(env: Env) {
  const cms = createCmsRef({
    manifests,
    handlers,
    auth: createSiteAuth(env),
    bindings: {
      db: new D1DatabaseDriver(env.DB),
      adminAssets: new AssetsAssetServer(env.ASSETS),
      deferredHookDispatcher: new WorkersQueueHookDispatcher(
        env.MANTLE_INTERNAL_QUEUE,
      ),
    },
  });

  const http = createOAuthProvider<Env>({
    defaultHandler: createSiteHttpHandler(cms),
    apiHandlers: createSiteMcpHandlers(cms),
  });

  return { http, consumeMantle: createQueueHandler<Env>(cms) };
}

let built: ReturnType<typeof buildWorker> | undefined;
const worker = (env: Env) => built ??= buildWorker(env);

export default {
  fetch(request, env, ctx) {
    return worker(env).http.fetch(request, env, ctx);
  },
  queue(batch, env) {
    return worker(env).consumeMantle(batch, env);
  },
} satisfies ExportedHandler<Env>;
```

`createSiteAuth`, `createSiteHttpHandler`, and `createSiteMcpHandlers` above
stand for the site's existing adapter assembly; Queue opt-in adds only the
dispatcher binding and `queue` export.

## Idempotent handlers

For a D1-owned effect, make the event/Trigger key a unique database key. This
example records a site-owned notification job exactly once even when the
lifecycle handler is replayed:

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

async function enqueueNotification(
  input: Record<string, unknown>,
  ctx: HandlerContext,
) {
  if (!ctx.event?.entry) throw new Error("lifecycle entry event required");
  const key = `${ctx.event.id}:${ctx.event.trigger}`;
  await (ctx.env as Env).DB.prepare(
    `INSERT OR IGNORE INTO notification_jobs
       (idempotency_key, entry_id, payload, created_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(key, ctx.event.entry.id, JSON.stringify(input), Date.now()).run();
  return { ok: true };
}
```

For an upstream API that supports idempotency, send the same stable key and
throw on failure so Queue retries it:

```ts
const key = `${ctx.event!.id}:${ctx.event!.trigger}`;
const response = await fetch("https://api.example.com/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Idempotency-Key": key,
  },
  body: JSON.stringify(input),
});
if (!response.ok) throw new Error(`message provider returned ${response.status}`);
```

Core intentionally does not add a business outbox, payment state machine,
provider retry wrapper, or generic job registry. Those remain site-owned.

## Multiplexing site queues

One Worker can consume the Mantle queue and site-owned queues without a Core
registry. Route on `batch.queue` in the Worker entry:

```ts
const mantleQueue = createQueueHandler<Env>(cms);

export default {
  fetch: http.fetch.bind(http),
  queue(batch, env, ctx) {
    switch (batch.queue) {
      case "mantle-internal":
        return mantleQueue(batch, env);
      case "billing-jobs":
        return consumeBilling(batch, env, ctx);
      default:
        batch.retryAll();
        console.error(`No consumer for queue '${batch.queue}'`);
        return;
    }
  },
} satisfies ExportedHandler<Env>;
```

The Mantle consumer processes at most five messages concurrently within each
delivered batch even if `max_batch_size` is raised. It calls `retryAll()` when
runtime boot fails, `retry()` for one failed event, and `ack()` exactly once
after success.

## Verification and operations

Run the integrated contract test:

```sh
pnpm --filter @aotter/mantle-cloudflare test -- mantle-internal-queue.test.ts
```

It covers real runtime failure propagation, all-Trigger execution, stable
replay identity, per-message ack/retry, malformed bodies, size/JSON rejection,
runtime boot failure, and the five-message concurrency bound.

For a site integration, run `wrangler dev`, submit a mutation with an
`after_*` Trigger, and verify the consumer log. Make one handler fail once and
confirm its first delivery is retried and the replay sees the same
`ctx.event.id` and `ctx.event.trigger`. Inspect the DLQ before increasing
`max_retries`; poison messages otherwise hide as repeated retries.

### Upgrading from the unversioned envelope

Version 1 intentionally rejects the old unversioned envelope and the old
`originalInput` field. Before deploying this release to a Worker that already
uses `mantle-internal`, stop old producers and drain the queue (including any
in-flight retries), or explicitly move the remaining messages to an operator
workflow. Deploying v1 with legacy messages still queued will retry those
messages and eventually place them in the DLQ.
