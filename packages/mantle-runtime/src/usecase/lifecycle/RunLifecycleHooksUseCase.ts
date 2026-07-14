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

/**
 * Resolves matching Triggers via `TriggerIndex`, dispatches each
 * to its target Procedure through the injected invoker (so input
 * validation, auth, output validation all reuse the shared pipeline),
 * and applies per-Trigger `errorPolicy`.
 *
 * The invoker is taken as a function rather than a concrete class so
 * this use case does NOT import from a sibling under `usecase/` —
 * `usecase → usecase` coupling would bypass the port boundary.
 * Assembly root passes `(req) => invokeProcedure.execute(req)`.
 *
 * Defaults from the parser-locked grammar (POC ADR-0014):
 *   - before_*: errorPolicy default `abort` — handler failure throws
 *     a `DiagnosticError` and the chokepoint decorator cancels the
 *     mutation.
 *   - after_*: errorPolicy default `continue` — handler failure is
 *     logged via `console.error` and swallowed; the mutation already
 *     succeeded. Author override (`errorPolicy: continue` on a
 *     before_* hook) is honored.
 *
 * `Trigger.errorPolicy: 'abort'` on after_* is parser-rejected, so the
 * use case never has to reconcile that combination.
 */
export type InvokeProcedureFn = (
  request: InvokeProcedureRequest,
) => Promise<InvokeProcedureResponse>;

export interface RunLifecycleHookRequest {
  readonly hook: LifecycleHook;
  readonly schema: string;
  /** Pre-mutation row for `before_*` hooks; persisted post-mutation
   * row for `after_*`. `null` only on `before_create`. */
  readonly entry: EntryRow | null;
  readonly ctx: HandlerContext;
  /** Pre-projection input, including side-channel fields when present. */
  readonly originalInput?: unknown;
}

export class RunLifecycleHooksUseCase {
  constructor(
    private readonly triggers: TriggerIndex,
    private readonly proceduresByName: ReadonlyMap<string, ProcedureManifest>,
    private readonly invoke: InvokeProcedureFn,
  ) {}

  async run(request: RunLifecycleHookRequest): Promise<void> {
    const matching = this.triggers.forHook(request.schema, request.hook);
    if (matching.length === 0) return;

    const isBefore = request.hook.startsWith("before_");
    for (const trigger of matching) {
      await this.runOne(trigger, request, isBefore);
    }
  }

  private async runOne(
    trigger: TriggerManifest,
    request: RunLifecycleHookRequest,
    isBefore: boolean,
  ): Promise<void> {
    const procedure = this.proceduresByName.get(trigger.spec.target.procedure);
    if (!procedure) {
      // Boot validator should have caught this; defense-in-depth.
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
      hook: request.hook,
      schema: request.schema,
      entry: request.entry,
    };
    const ctxWithEvent: HandlerContext = { ...request.ctx, event };

    const declared = trigger.spec.source.kind === "lifecycle"
      ? trigger.spec.source.errorPolicy
      : undefined;
    const policy = declared ?? (isBefore ? "abort" : "continue");

    const input = request.originalInput ?? request.entry?.data ?? {};
    let result: InvokeProcedureResponse;
    try {
      result = await this.invoke({
        procedure,
        input,
        ctx: ctxWithEvent,
        pathPrefix: `lifecycle:Trigger/${trigger.metadata.name}->${procedure.metadata.name}`,
      });
    } catch (err) {
      if (policy === "abort") throw err;
      console.error(`[lifecycle] after_* hook ${trigger.metadata.name} threw`, err);
      return;
    }
    if (result.ok) return;
    if (policy === "abort") {
      throw new DiagnosticError(result.diagnostic);
    }
    console.error(
      `[lifecycle] hook ${trigger.metadata.name} returned diagnostic`,
      result.diagnostic,
    );
  }
}
