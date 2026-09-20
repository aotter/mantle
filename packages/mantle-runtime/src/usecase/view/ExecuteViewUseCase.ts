import {
  DiagnosticError,
  firstZodIssueAsJsonPointer,
  jsonSchemaToZod,
  makeDiagnostic,
  readJsonPointer,
  runtimeDiagnostic,
  type Diagnostic,
} from "@aotter/mantle-spec";
import type { ZodType } from "zod";
import type {
  ViewQueryExecutor,
  ViewQueryResult,
} from "../../domain/port/ViewQueryExecutor.js";
import { evaluateAuthAll } from "../../domain/service/AuthPredicateEvaluator.js";
import type { RuntimeViewPlan } from "../../domain/service/RuntimePlanCompiler.js";
import type { ExecuteViewRequest } from "../dto/view/ExecuteViewRequest.js";
import type { InvokeProcedureResponse } from "../dto/procedure/index.js";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";

/**
 * Authorize and bind request values to a prepared View query. REST
 * adapters coerce query strings and MCP passes typed JSON; this use
 * case validates the converged param map against `View.spec.params` after
 * static auth and before an optional guard.
 */

export type ExecuteViewResponse<R = Record<string, unknown>> =
  | { readonly ok: true; readonly result: ViewQueryResult<R> }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

export type InvokeViewGuard = (request: {
  readonly procedure: string;
  readonly input: Record<string, unknown>;
  readonly ctx: HandlerContext;
  readonly pathPrefix: string;
}) => Promise<InvokeProcedureResponse>;

export class ExecuteViewUseCase {
  private readonly paramsCache = new Map<string, ZodType>();

  constructor(
    private readonly queries: ViewQueryExecutor,
    private readonly invokeGuard?: InvokeViewGuard,
    private readonly views: Readonly<Record<string, RuntimeViewPlan>> = Object.create(null),
  ) {}

  async execute<R = Record<string, unknown>>(
    request: ExecuteViewRequest,
  ): Promise<ExecuteViewResponse<R>> {
    const planned = this.views[request.view.metadata.name];
    const view = planned?.manifest ?? request.view;
    const viewPath = request.pathPrefix ?? `manifest:View/${view.metadata.name}`;

    // Auth — closed predicate vocabulary same as Procedure. When the
    // View has no `requires.auth.all`, evaluateAuthAll returns null.
    const requires = view.spec.requires;
    if (requires?.auth?.all && requires.auth.all.length > 0) {
      if (!request.ctx) {
        return {
          ok: false,
          diagnostic: makeDiagnostic({
            code: "UNAUTHENTICATED",
            phase: "runtime",
            severity: "error",
            path: `${viewPath}#/requires/auth`,
            expected: "caller identity (ctx) supplied by the adapter for an auth-gated View",
          }),
        };
      }
      const denial = evaluateAuthAll(requires, request.ctx, viewPath, "runtime");
      if (denial) return { ok: false, diagnostic: denial };
    }

    // Validate the adapter-coerced map after static auth so protected
    // Views do not expose parameter-schema details to unauthorized
    // callers. MCP sends already-typed JSON; REST passes coerced query
    // values. Both converge here before the dynamic guard.
    let validatedParams = request.options?.params ?? {};
    if (view.spec.params) {
      let validator = this.paramsCache.get(view.metadata.name);
      if (!validator) {
        validator = jsonSchemaToZod(view.spec.params);
        this.paramsCache.set(view.metadata.name, validator);
      }
      const parsed = validator.safeParse(validatedParams);
      if (!parsed.success) {
        const { instancePath, message } = firstZodIssueAsJsonPointer(parsed.error);
        return {
          ok: false,
          diagnostic: makeDiagnostic({
            code: "INPUT_VALIDATION_FAILED",
            phase: "runtime",
            severity: "error",
            path: `${viewPath}#/params${instancePath}`,
            value: readJsonPointer(validatedParams, instancePath),
            expected: message,
          }),
        };
      }
      validatedParams = parsed.data as Record<string, unknown>;
    }

    const guardName = requires?.guard?.procedure;
    if (guardName) {
      if (!request.ctx) {
        return {
          ok: false,
          diagnostic: makeDiagnostic({
            code: "UNAUTHENTICATED",
            phase: "runtime",
            severity: "error",
            path: `${viewPath}#/requires/guard`,
            expected: "caller context supplied by the adapter for a guarded View",
          }),
        };
      }
      if (!this.invokeGuard) {
        return {
          ok: false,
          diagnostic: makeDiagnostic({
            code: "GUARD_PROCEDURE_UNKNOWN",
            phase: "runtime",
            severity: "error",
            path: `${viewPath}#/requires/guard/procedure`,
            value: guardName,
            expected: "guard invoker wired into the runtime",
          }),
        };
      }
      const guarded = await this.invokeGuard({
        procedure: guardName,
        input: validatedParams,
        ctx: request.ctx,
        pathPrefix: `${viewPath}#/requires/guard/${guardName}`,
      });
      if (!guarded.ok) return guarded;
    }

    try {
      const result = await this.queries.execute<R>({
        view: view.metadata.name,
        ...request.options,
        params: validatedParams,
        ctxUserId: request.ctx?.user?.id,
      });
      return { ok: true, result };
    } catch (err) {
      if (err instanceof DiagnosticError) {
        return { ok: false, diagnostic: err.diagnostic };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INTERNAL_ERROR",
          severity: "error",
          path: viewPath,
          expected: "prepared View query executes successfully",
          message: `View query failed: ${msg}`,
        }),
      };
    }
  }
}
