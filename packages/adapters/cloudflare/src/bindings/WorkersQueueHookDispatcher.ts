import type {
  MantleRuntime,
  DeferredHookDispatcher,
  DeferredHookEnvelope,
} from "@aotter/mantle-runtime";

// Cloudflare's 128 KB limit is decimal and includes roughly 100 bytes
// of platform metadata. Reserve a full 1 KB so accepted envelopes stay
// below the provider limit rather than failing only at queue.send.
const MAX_ENVELOPE_BYTES = 127_000;
const MAX_CONCURRENCY = 5;

/**
 * `DeferredHookDispatcher` impl backed by a Cloudflare Workers Queue
 * binding. Producer side: serialises each `DeferredHookEnvelope` and
 * sends it explicitly as JSON. The runtime decorator handles a
 * rejection with its best-effort fallback. Queue acceptance is not
 * atomic with the preceding D1 mutation.
 *
 * Per ADR-0011 only this adapter package may import the CF binding
 * type. The runtime sees only the `DeferredHookDispatcher` port.
 */
export class WorkersQueueHookDispatcher implements DeferredHookDispatcher {
  constructor(private readonly queue: Queue<DeferredHookEnvelope>) {}

  async enqueue(envelope: DeferredHookEnvelope): Promise<void> {
    // `EntryRow.locale?` may be present with value `undefined` in a
    // repository object. JSON transport omits that optional field;
    // normalize only this declared optional before the strict
    // JSON-safe check so undefined values inside entry.data still
    // fail instead of disappearing silently.
    const { locale, ...entryWithoutLocale } = envelope.entry;
    const wireEnvelope = locale === undefined
      ? { ...envelope, entry: entryWithoutLocale }
      : envelope;
    let json: string;
    try {
      json = JSON.stringify(wireEnvelope, (_key, value: unknown) => {
        if (
          value === undefined ||
          typeof value === "function" ||
          typeof value === "symbol" ||
          typeof value === "bigint"
        ) {
          throw new TypeError("value is not JSON-safe");
        }
        return value;
      });
    } catch (cause) {
      throw new Error(
        `Deferred lifecycle envelope '${envelope.eventId}' is not JSON-safe.`,
        { cause },
      );
    }
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes >= MAX_ENVELOPE_BYTES) {
      throw new Error(
        `Deferred lifecycle envelope '${envelope.eventId}' is ${bytes} bytes; this adapter requires less than ${MAX_ENVELOPE_BYTES} to leave room under Cloudflare's 128 KB message limit.`,
      );
    }
    await this.queue.send(wireEnvelope, { contentType: "json" });
  }
}

/**
 * Build the `queue(batch, env, ctx)` Workers handler that consumes
 * `mantle-internal` messages and re-fires each `after_*` hook through
 * the runtime. Consumers wire this alongside `fetch` in their default
 * Worker export:
 *
 * ```ts
 * export default {
 *   fetch: app.fetch,
 *   queue: createQueueHandler(cms),
 * } satisfies ExportedHandler<Env>;
 * ```
 *
 * Per-message ack / retry: any validation or handler failure retries
 * the message; success acks. CF Queues then applies the consumer's
 * retry delay, max_retries, and DLQ configuration.
 */
export function createQueueHandler<Env>(
  cmsRef: { get(): Promise<MantleRuntime> },
): (batch: MessageBatch<unknown>, env: Env) => Promise<void> {
  return async (batch, env) => {
    let cms: MantleRuntime;
    try {
      cms = await cmsRef.get();
    } catch (err) {
      // Boot failed (D1 unreachable, manifest invalid, …). Use
      // batch.retryAll so each message's per-message attempt counter
      // increments — letting wrangler's max_retries / DLQ rules
      // engage instead of looping forever at the batch level.
      batch.retryAll();
      console.error("[mantle-internal] runtime boot failed; retrying batch", err);
      return;
    }
    // Bound fan-out even when a consumer raises max_batch_size.
    for (let offset = 0; offset < batch.messages.length; offset += MAX_CONCURRENCY) {
      const chunk = batch.messages.slice(offset, offset + MAX_CONCURRENCY);
      await Promise.all(
        chunk.map(async (message) => {
          try {
            await cms.runDeferredHook({ envelope: message.body, env });
            message.ack();
          } catch (err) {
            message.retry();
            console.error("[mantle-internal] deferred lifecycle consume failed; retrying", {
              messageId: message.id,
              attempts: message.attempts,
              error: err,
            });
          }
        }),
      );
    }
  };
}
