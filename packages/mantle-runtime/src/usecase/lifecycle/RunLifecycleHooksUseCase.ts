import {
  DiagnosticError,
  runtimeDiagnostic,
  type LifecycleHook,
  type ProcedureManifest,
  type TriggerManifest,
} from "@aotter/mantle-spec";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { HandlerContext, HandlerLifecycleEvent } from "../../domain/model/HandlerContext.js";
import type { TriggerIndex } from "../../domain/service/TriggerIndex.js";
import type {
  InvokeProcedureRequest,
  InvokeProcedureResponse,
} from "../dto/procedure/index.js";

export type InvokeProcedureFn = (
  request: InvokeProcedureRequest,
) => Promise<InvokeProcedureResponse>;

export interface RunLifecycleHookRequest {
  /** One event id is shared by every captured Trigger. */
  readonly eventId: string;
  /** Ordered Trigger names captured before dispatch. */
  readonly triggerNames: readonly string[];
  readonly delivery: "inline" | "deferred";
  readonly hook: LifecycleHook;
  readonly schema: string;
  /** Pre-mutation row for `before_*`; persisted row for `after_*`.
   *  `null` only on `before_create`. */
  readonly entry: EntryRow | null;
  readonly ctx: HandlerContext;
  /** Pre-projection caller input. Used only by `before_*` hooks. */
  readonly originalInput?: unknown;
}

/**
 * Runs one captured lifecycle event. Inline `continue` failures are
 * logged and swallowed so the mutation result stands. Deferred runs
 * still execute every captured Trigger, then throw an aggregate so
 * the delivery adapter retries the event.
 */
export class RunLifecycleHooksUseCase {
  constructor(
    private readonly triggers: TriggerIndex,
    private readonly proceduresByName: ReadonlyMap<string, ProcedureManifest>,
    private readonly invoke: InvokeProcedureFn,
  ) {}

  async run(request: RunLifecycleHookRequest): Promise<void> {
    const matching = this.resolveCapturedTriggers(request);
    const isBefore = request.hook.startsWith("before_");
    const failures: unknown[] = [];

    for (const trigger of matching) {
      try {
        await this.runOne(trigger, request, isBefore);
      } catch (error) {
        if (request.delivery === "deferred") {
          failures.push(error);
          continue;
        }
        if (errorPolicy(trigger, isBefore) === "abort") throw error;
        console.error("[lifecycle] hook failed; continuing", {
          eventId: request.eventId,
          trigger: trigger.metadata.name,
          hook: request.hook,
          schema: request.schema,
          error,
        });
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Deferred lifecycle event '${request.eventId}' failed in ${failures.length} Trigger(s).`,
      );
    }
  }

  private resolveCapturedTriggers(
    request: RunLifecycleHookRequest,
  ): readonly TriggerManifest[] {
    const available = new Map(
      this.triggers
        .forHook(request.schema, request.hook)
        .map((trigger) => [trigger.metadata.name, trigger]),
    );
    return request.triggerNames.map((name) => {
      const trigger = available.get(name);
      if (!trigger) {
        throw new DiagnosticError(
          runtimeDiagnostic({
            code: "INPUT_VALIDATION_FAILED",
            severity: "error",
            path: `lifecycle:event/${request.eventId}/triggerNames`,
            value: name,
            expected: "name of a current Trigger for this schema and hook",
            message: `Lifecycle event '${request.eventId}' references unavailable Trigger '${name}'.`,
          }),
        );
      }
      return trigger;
    });
  }

  private async runOne(
    trigger: TriggerManifest,
    request: RunLifecycleHookRequest,
    isBefore: boolean,
  ): Promise<void> {
    const procedure = this.proceduresByName.get(trigger.spec.target.procedure);
    if (!procedure) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "TRIGGER_TARGET_PROCEDURE_UNKNOWN",
          severity: "error",
          path: `manifest:Trigger/${trigger.metadata.name}#/spec/target/procedure`,
          value: trigger.spec.target.procedure,
          expected: "name of a declared Procedure",
          message: `Lifecycle Trigger '${trigger.metadata.name}' targets unknown Procedure '${trigger.spec.target.procedure}'.`,
        }),
      );
    }

    const event: HandlerLifecycleEvent = {
      id: request.eventId,
      trigger: trigger.metadata.name,
      hook: request.hook,
      schema: request.schema,
      entry: request.entry,
    };
    const input = isBefore
      ? request.originalInput ?? request.entry?.data ?? {}
      : request.entry?.data ?? {};
    const result = await this.invoke({
      procedure,
      input,
      ctx: { ...request.ctx, event },
      pathPrefix: `lifecycle:Trigger/${trigger.metadata.name}->${procedure.metadata.name}`,
    });
    if (!result.ok) throw new DiagnosticError(result.diagnostic);
  }
}

function errorPolicy(
  trigger: TriggerManifest,
  isBefore: boolean,
): "abort" | "continue" {
  const declared = trigger.spec.source.kind === "lifecycle"
    ? trigger.spec.source.errorPolicy
    : undefined;
  return declared ?? (isBefore ? "abort" : "continue");
}
