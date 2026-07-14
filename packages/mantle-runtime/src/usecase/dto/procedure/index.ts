import type {
  Diagnostic,
  ProcedureManifest,
} from "@aotter/mantle-spec";
import type { HandlerContext } from "../../../domain/model/HandlerContext.js";

/**
 * Procedure-dispatch DTOs. `InvokeProcedureUseCase` is the entry point
 * for both `handler.kind: ref` and `handler.kind: builtin` Procedures
 * (it routes by kind); `InvokeBuiltinUseCase` is the collaborator the
 * router delegates to for the builtin op execution path.
 *
 * `InvokeFailure` (the thrown carrier handlers use to surface a
 * structured Diagnostic) lives next to the use case class — it's a
 * runtime value, not a DTO type.
 */
export interface InvokeProcedureRequest {
  readonly procedure: ProcedureManifest;
  readonly input: unknown;
  readonly ctx: HandlerContext;
  /** Path-locator prefix for `Diagnostic.path`. The HTTP mount passes
   *  e.g. `POST /api/contact`; the test harness passes
   *  `manifest:Procedure/<name>`. */
  readonly pathPrefix?: string;
}

export type InvokeProcedureResponse<O = unknown> =
  | { readonly ok: true; readonly data: O }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

export interface InvokeBuiltinRequest {
  readonly procedure: ProcedureManifest;
  /** Procedure input that has already cleared zod validation. */
  readonly validatedInput: Record<string, unknown>;
  readonly ctx: HandlerContext;
}
