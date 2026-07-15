import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import type { RunDeferredHookRequest } from "../dto/lifecycle/index.js";
import type { RunLifecycleHooksUseCase } from "./RunLifecycleHooksUseCase.js";

/**
 * Consume side of the deferred after-hook path. Adapter queue
 * consumers (CF Workers `queue(batch, env)` for Workers Queues, etc.)
 * deserialize each `DeferredHookEnvelope` and call this use case with
 * a fresh per-invocation `env` binding bag.
 *
 * Reconstructs a `HandlerContext` mirroring the original firing
 * context's identity (user / staff snapshot from the envelope), with
 * `env` filled by the consume invocation. `waitUntil` is intentionally
 * absent — the consume invocation owns its own request lifetime, and
 * chaining another fire-and-forget here would just reintroduce the
 * durability gap the deferred path closes.
 *
 * Errors from the underlying hook surface per the Trigger's
 * `errorPolicy`. The adapter is expected to translate a throw into
 * the platform's retry signal (e.g. `message.retry()` on CF Queues)
 * so the hook eventually succeeds or hits the dead-letter queue.
 */
export class RunDeferredHookUseCase {
  constructor(private readonly hooks: Pick<RunLifecycleHooksUseCase, "run">) {}

  async execute(request: RunDeferredHookRequest): Promise<void> {
    const { envelope, env } = request;
    const ctx: HandlerContext = {
      user: envelope.ctxSnapshot?.userId
        ? { id: envelope.ctxSnapshot.userId }
        : null,
      staff:
        envelope.ctxSnapshot?.staffId && envelope.ctxSnapshot.staffRole
          ? { id: envelope.ctxSnapshot.staffId, role: envelope.ctxSnapshot.staffRole }
          : null,
      auth: envelope.ctxSnapshot?.auth ?? undefined,
      env,
    };
    await this.hooks.run({
      hook: envelope.hook,
      schema: envelope.schema,
      entry: envelope.entry,
      ctx,
      originalInput: envelope.originalInput,
    });
  }
}
