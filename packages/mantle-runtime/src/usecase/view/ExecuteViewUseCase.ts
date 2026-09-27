import {
  DiagnosticError,
  firstZodIssueAsJsonPointer,
  jsonSchemaToZod,
  makeDiagnostic,
  readJsonPointer,
  runtimeDiagnostic,
  type Diagnostic,
  type SchemaManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";
import type { ZodType } from "zod";
import type {
  ViewQueryExecutor,
  ViewQueryOptions,
  ViewQueryResult,
} from "../../domain/port/ViewQueryExecutor.js";
import { evaluateAuthAll } from "../../domain/service/AuthPredicateEvaluator.js";
import type { RuntimeViewPlan } from "../../domain/service/RuntimePlanCompiler.js";
import type { ExecuteViewRequest } from "../dto/view/ExecuteViewRequest.js";
import type { InvokeProcedureResponse } from "../dto/procedure/index.js";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import type { StoreSelect, StoreSelectResult, StoreWhere } from "../../domain/model/Store.js";

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
    private readonly select?: (query: StoreSelect, ctx: HandlerContext | undefined) => Promise<StoreSelectResult>,
    private readonly now: () => number = Date.now,
    private readonly schemas: ReadonlyMap<string, SchemaManifest> = new Map(),
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
      if (view.spec.select) {
        if (!this.select) throw new DiagnosticError(runtimeDiagnostic({
          code: "RESOURCE_UNAVAILABLE", severity: "error", path: viewPath,
          message: "This storage adapter cannot run Store selects.",
        }));
        const query = bindStoreViewSelect(view, planned, request.options, validatedParams, request.ctx, viewPath, this.now, this.schemas);
        const limit = query.limit ?? 50;
        const selected = await this.select(query, request.ctx);
        return { ok: true, result: {
          rows: selected.rows as R[], page: 1, show: limit, hasMore: selected.nextCursor !== undefined,
          ...(selected.nextCursor ? { nextCursor: selected.nextCursor } : {}),
        } };
      }
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

/** Bind an authored select without transport authorization; the index harness uses the same query shape. */
export function bindStoreViewSelect(
  view: ViewManifest,
  planned: RuntimeViewPlan | undefined,
  options: ViewQueryOptions | undefined,
  params: Readonly<Record<string, unknown>>,
  ctx: HandlerContext | undefined,
  path: string,
  now: () => number,
  schemas: ReadonlyMap<string, SchemaManifest>,
): StoreSelect {
  const authored = view.spec.select;
  if (!authored) throw new Error(`View '${view.metadata.name}' has no Store select.`);
  if ((options?.page ?? 1) !== 1 || options?.search?.term || options?.filters?.length) {
    throw new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path,
      message: "Store-backed Views require limit/cursor pagination and do not yet support Admin search or filters." }));
  }
  const cursorFields = ["id", Object.keys(authored.orderBy ?? {})[0] ?? "updatedAt"];
  if (view.spec.surface === "public" && authored.columns && cursorFields.some((field) => !authored.columns!.includes(field))) {
    throw new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path,
      message: "Public View must project the id and sort field carried by its pagination cursor." }));
  }
  const limit = Math.min(options?.limit ?? options?.show ?? authored.limit ?? 50, authored.limit ?? 500);
  const authoredWhere = authored.where ? resolveViewWhere(authored.where, params, ctx, path, now, schemas, authored.from, view.spec.surface === "public") : undefined;
  const where = planned?.query.kind === "store" && planned.query.publishedOnly
    ? authoredWhere ? { and: [authoredWhere, { status: "published" }] } : { status: "published" }
    : authoredWhere;
  return {
    from: authored.from,
    ...(authored.columns ? { columns: authored.columns } : {}),
    ...(where ? { where } : {}),
    ...(authored.orderBy ? { orderBy: authored.orderBy } : {}),
    limit,
    ...(options?.cursor ? { cursor: options.cursor } : {}),
  };
}

function resolveViewWhere(where: Readonly<Record<string, unknown>>, params: unknown, ctx: HandlerContext | undefined, path: string, now: () => number, schemas: ReadonlyMap<string, SchemaManifest>, from: string, publicView: boolean): StoreWhere {
  let nodes = 0;
  const comparisons = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "like", "in", "notIn", "isNull"]);
  const resolve = (value: unknown, depth: number, column?: string, schemaName = from, subquery = false): unknown => {
    if (++nodes > 256 || depth > 16) throw new DiagnosticError(runtimeDiagnostic({
      code: "INPUT_VALIDATION_FAILED", severity: "error", path,
      message: "View select.where exceeds its query budget.",
    }));
    if (typeof value === "string" && value.startsWith("$")) {
      if (value === "$ctx.user.id") {
        if (!ctx?.user?.id) throw new DiagnosticError(runtimeDiagnostic({ code: "UNAUTHENTICATED", severity: "error", path, message: "View requires a caller identity." }));
        return ctx.user.id;
      }
      if (value === "$now") {
        const property = schemas.get(schemaName)?.spec.schema.properties?.[column ?? ""];
        return property?.format === "date-time" ? new Date(now()).toISOString() : now();
      }
      if (value.startsWith("$input.")) {
        const name = value.slice(7);
        if (params && typeof params === "object" && Object.hasOwn(params, name)) {
          const input = (params as Record<string, unknown>)[name];
          if (input === null || ["string", "number", "boolean"].includes(typeof input)) return input;
        }
      }
      throw new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path, message: `Unknown View value reference '${value}'.` }));
    }
    if (Array.isArray(value)) return value.map((item) => resolve(item, depth + 1, column, schemaName));
    if (value && typeof value === "object") {
      if (Object.keys(value).length === 1 && Object.hasOwn(value, "$literal")) return (value as Record<string, unknown>)["$literal"];
      const record = value as Record<string, unknown>;
      if (subquery && typeof record["from"] === "string" && typeof record["select"] === "string") {
        const authored = record["where"] === undefined ? undefined : resolve(record["where"], depth + 1, undefined, record["from"]);
        const published = publicView && (schemas.get(record["from"])?.spec.lifecycle ?? "publishing") === "publishing";
        return {
          select: record["select"], from: record["from"],
          ...(published ? { where: authored ? { and: [authored, { status: "published" }] } : { status: "published" } } : authored ? { where: authored } : {}),
        };
      }
      return Object.fromEntries(Object.entries(record).map(([key, item]) => [key,
        resolve(item, depth + 1, comparisons.has(key) ? column : ["and", "or", "not"].includes(key) ? undefined : key, schemaName, key === "in" || key === "notIn"),
      ]));
    }
    return value;
  };
  return resolve(where, 0) as StoreWhere;
}
