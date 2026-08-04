import {
  firstZodIssueAsJsonPointer,
  jsonSchemaToZod,
  makeDiagnostic,
  readJsonPointer,
  runtimeDiagnostic,
  type Diagnostic,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { ZodType } from "zod";
import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import { evaluateAuthAll } from "../../domain/service/AuthPredicateEvaluator.js";
import { compileView } from "../../domain/service/ViewSqlCompiler.js";
import type { ExecuteViewRequest } from "../dto/view/ExecuteViewRequest.js";
import type { InvokeProcedureResponse } from "../dto/procedure/index.js";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";

/**
 * Compile a View manifest and run it against `DatabaseDriver`. The
 * REST adapters coerce query strings and MCP passes typed JSON; this use
 * case validates the converged param map against `View.spec.params` after
 * static auth and before an optional guard.
 */

export interface ViewQueryResult<R = Record<string, unknown>> {
  readonly rows: readonly R[];
  readonly page: number;
  readonly show: number;
  /** True when `rows.length === show` — there *might* be more on the
   *  next page. False guarantees no more. v0.1.0 takes the cheap
   *  path: no count query, no limit+1 probe. ADR-0012. */
  readonly hasMore: boolean;
}

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
    private readonly db: DatabaseDriver,
    private readonly invokeGuard?: InvokeViewGuard,
    private readonly schemasByName: ReadonlyMap<string, SchemaManifest> = new Map(),
  ) {}

  async execute<R = Record<string, unknown>>(
    request: ExecuteViewRequest,
  ): Promise<ExecuteViewResponse<R>> {
    const viewPath = request.pathPrefix ?? `manifest:View/${request.view.metadata.name}`;

    // Auth — closed predicate vocabulary same as Procedure. When the
    // View has no `requires.auth.all`, evaluateAuthAll returns null.
    const requires = request.view.spec.requires;
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
    if (request.view.spec.params) {
      let validator = this.paramsCache.get(request.view.metadata.name);
      if (!validator) {
        validator = jsonSchemaToZod(request.view.spec.params);
        this.paramsCache.set(request.view.metadata.name, validator);
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

    const schema = this.schemasByName.get(request.view.spec.from);
    let compiled;
    try {
      compiled = compileView(
        request.view,
        {
          ...request.options,
          params: validatedParams,
        },
        schema,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INTERNAL_ERROR",
          severity: "error",
          path: viewPath,
          expected: "View compiles to valid SQL",
          message: `View compile failed: ${msg}`,
        }),
      };
    }

    try {
      const rows = await this.db
        .prepare(compiled.sql)
        .bind(...compiled.params)
        .all<R>();
      const normalizedRows = normalizeBooleanFields(rows, request.view.spec.fields, schema);
      return {
        ok: true,
        result: {
          rows: normalizedRows,
          page: compiled.effectivePage,
          show: compiled.effectiveShow,
          hasMore: normalizedRows.length === compiled.effectiveShow,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INTERNAL_ERROR",
          severity: "error",
          path: viewPath,
          expected: "SQL executes without error",
          message: `View SQL execution failed: ${msg}`,
        }),
      };
    }
  }
}

function normalizeBooleanFields<R>(
  rows: readonly R[],
  fields: readonly string[] | undefined,
  schema: SchemaManifest | undefined,
): readonly R[] {
  const properties = schema?.spec.schema.properties;
  const booleanFields = fields?.filter((field) => isBooleanProperty(properties?.[field])) ?? [];
  if (booleanFields.length === 0) return rows;

  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const normalized = { ...row } as Record<string, unknown>;
    for (const field of booleanFields) {
      if (normalized[field] === 0) normalized[field] = false;
      if (normalized[field] === 1) normalized[field] = true;
    }
    return normalized as R;
  });
}

function isBooleanProperty(property: SchemaManifest["spec"]["schema"] | undefined): boolean {
  const types = Array.isArray(property?.type) ? property.type : [property?.type];
  return types.includes("boolean") && types.every((type) => type === "boolean" || type === "null");
}
