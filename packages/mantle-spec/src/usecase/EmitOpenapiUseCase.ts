import { resolveLocalizedText } from "../domain/model/ManifestGrammar.js";
import type {
  AuthorizationRequirements,
  JsonSchema,
  ProcedureManifest,
  TriggerManifest,
  ViewManifest,
} from "../domain/model/ManifestGrammar.js";
import type { EmitOpenapiRequest } from "./dto/EmitOpenapiRequest.js";
import type { EmitOpenapiResponse } from "./dto/EmitOpenapiResponse.js";

/**
 * Build OpenAPI 3.1 from the v0.1 grammar. Two surfaces covered:
 * HTTP Triggers (POST/PUT/PATCH/DELETE) and View REST routes
 * (GET /api/views/<name>). MCP is out of scope (own protocol).
 *
 * Pure: no I/O. CLI adapter handles file load + stdout.
 */
const DEFAULT_SESSION_COOKIE_NAME = "__Secure-better-auth.session_token";

export class EmitOpenapiUseCase {
  execute(request: EmitOpenapiRequest): EmitOpenapiResponse {
    const views = request.linked.views.map((entry) => entry.manifest);
    const procedures = request.linked.procedures.map((entry) => entry.manifest);
    const triggers = request.linked.triggers.map((entry) => entry.manifest);
    const procByName = new Map(procedures.map((p) => [p.metadata.name, p]));
    const paths: Record<string, Record<string, unknown>> = {};

    for (const t of triggers) {
      const src = t.spec.source;
      if (src.kind !== "http") continue;
      const proc = procByName.get(t.spec.target.procedure);
      if (!proc) continue;
      const path = src.path;
      paths[path] ??= {};
      paths[path]![src.method.toLowerCase()] = httpOperation(t, proc, request);
    }

    for (const v of views) {
      const path = `/api/views/${v.metadata.name}`;
      paths[path] ??= {};
      paths[path]!["get"] = viewOperation(v, request);
    }

    return {
      document: {
        openapi: "3.1.0",
        info: { title: request.title, version: request.version },
        paths,
        components: {
          schemas: {
            Diagnostic: diagnosticSchema(),
            ErrorEnvelope: {
              type: "object",
              required: ["ok", "diagnostic"],
              properties: {
                ok: { const: false },
                diagnostic: { $ref: "#/components/schemas/Diagnostic" },
              },
            },
          },
          securitySchemes: securitySchemes(request),
        },
      },
    };
  }

  static run(request: EmitOpenapiRequest): EmitOpenapiResponse {
    return new EmitOpenapiUseCase().execute(request);
  }
}

function httpOperation(
  t: TriggerManifest,
  p: ProcedureManifest,
  request: EmitOpenapiRequest,
): Record<string, unknown> {
  const source = t.spec.source;
  const method = source.kind === "http" ? source.method : "POST";
  const pathParams = source.kind === "http" ? pathParameterNames(source.path) : [];
  const op: Record<string, unknown> = {
    operationId: `${method.toLowerCase()}_${p.metadata.name.replace(/[^a-z0-9]+/gi, "_")}`,
    summary: `Trigger ${t.metadata.name}`,
    ...(pathParams.length > 0
      ? {
          parameters: pathParams.map((name) => ({
            name,
            in: "path",
            required: true,
            schema: collapseSchemaDescriptions(
              p.spec.input.properties?.[name] ?? { type: "string" },
            ),
          })),
        }
      : {}),
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: requestBodySchema(p.spec.input, pathParams),
        },
      },
    },
    responses: {
      "200": {
        description: "Procedure result",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["ok", "data"],
              properties: { ok: { const: true }, data: collapseSchemaDescriptions(p.spec.output) },
            },
          },
        },
      },
      default: {
        description: "Error envelope",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
      },
    },
  };
  reflectAuthorization(op, op["responses"] as Record<string, unknown>, p.spec.requires, request, `Procedure '${p.metadata.name}'`);
  return op;
}

function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!);
}

/** Project path-bound fields out of the HTTP body without changing the
 * Procedure schema used by runtime validation. */
function requestBodySchema(input: JsonSchema, pathParams: readonly string[]): JsonSchema {
  if (pathParams.length === 0) return collapseSchemaDescriptions(input);
  const pathNames = new Set(pathParams);
  return collapseSchemaDescriptions({
    ...input,
    ...(input.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(input.properties).filter(([name]) => !pathNames.has(name)),
          ),
        }
      : {}),
    ...(input.required
      ? { required: input.required.filter((name) => !pathNames.has(name)) }
      : {}),
  });
}

function viewOperation(v: ViewManifest, request: EmitOpenapiRequest): Record<string, unknown> {
  const params: Array<Record<string, unknown>> = [
    { name: "page", in: "query", schema: { type: "integer", minimum: 1 }, required: false },
    { name: "show", in: "query", schema: { type: "integer", minimum: 1 }, required: false },
  ];
  if (v.spec.params?.properties) {
    const required = new Set(v.spec.params.required ?? []);
    for (const [name, schema] of Object.entries(v.spec.params.properties)) {
      params.push({ name, in: "query", required: required.has(name), schema: collapseSchemaDescriptions(schema) });
    }
  }
  const responses: Record<string, unknown> = {
    "200": {
      description: "View result",
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["ok", "data"],
            properties: {
              ok: { const: true },
              data: {
                type: "object",
                required: ["rows", "page", "show", "hasMore"],
                properties: {
                  rows: {
                    type: "array",
                    items: { type: "object", additionalProperties: true },
                  },
                  page: { type: "integer" },
                  show: { type: "integer" },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
    "400": {
      description: "Invalid query parameter",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
    },
  };
  const op: Record<string, unknown> = {
    operationId: `view_${v.metadata.name.replace(/[^a-z0-9]+/gi, "_")}`,
    summary: `View ${v.metadata.name}`,
    parameters: params,
    responses,
  };
  reflectAuthorization(op, responses, v.spec.requires, request, `View '${v.metadata.name}'`);
  return op;
}

function securitySchemes(request: EmitOpenapiRequest): Record<string, unknown> {
  const configured = request.security;
  const out: Record<string, unknown> = {};
  if (configured?.sessionCookie !== false) {
    out["sessionCookie"] = {
      type: "apiKey",
      in: "cookie",
      name:
        configured?.sessionCookie?.name ??
        request.sessionCookieName ??
        DEFAULT_SESSION_COOKIE_NAME,
    };
  }
  if (configured?.oauthBearer) {
    out["oauthBearer"] = {
      type: "openIdConnect",
      openIdConnectUrl: configured.oauthBearer.openIdConnectUrl,
    };
  }
  if (configured?.apiKey) {
    out["apiKey"] = {
      type: "apiKey",
      in: configured.apiKey.in,
      name: configured.apiKey.name,
    };
  }
  if (configured?.personalToken) {
    out["personalToken"] = {
      type: "http",
      scheme: "bearer",
      ...(configured.personalToken.bearerFormat
        ? { bearerFormat: configured.personalToken.bearerFormat }
        : {}),
    };
  }
  return out;
}

function reflectAuthorization(
  operation: Record<string, unknown>,
  responses: Record<string, unknown>,
  requires: AuthorizationRequirements | undefined,
  request: EmitOpenapiRequest,
  targetLabel: string,
): void {
  const predicates = requires?.auth?.all ?? [];
  const scopes = predicates.flatMap((predicate) =>
    typeof predicate === "object" && "ctx.auth.scope" in predicate
      ? [predicate["ctx.auth.scope"]]
      : [],
  );
  if (predicates.length > 0) {
    const schemes = securitySchemes(request);
    const security: Array<Record<string, readonly string[]>> = [];
    if ("sessionCookie" in schemes) security.push({ sessionCookie: [] });
    if ("oauthBearer" in schemes) security.push({ oauthBearer: scopes });
    if ("apiKey" in schemes) security.push({ apiKey: [] });
    if ("personalToken" in schemes) security.push({ personalToken: [] });
    if (security.length === 0) {
      throw new Error(
        `EmitOpenapiUseCase: ${targetLabel} is protected but no security scheme is configured.`,
      );
    }
    operation["security"] = security;
    operation["x-mantle-auth-predicates"] = predicates;
    if (scopes.length > 0) operation["x-mantle-required-scopes"] = scopes;
    responses["401"] = errorResponse("Authentication required");
    responses["403"] = errorResponse("Verified caller lacks a required role or scope");
  }
  const guard = requires?.guard?.procedure;
  if (guard) {
    operation["x-mantle-guard-procedure"] = guard;
    responses["402"] = errorResponse("Dynamic entitlement guard denied the request");
  }
}

function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorEnvelope" },
      },
    },
  };
}

/**
 * JSON Schema `description` (#453, same shape as property `title` —
 * #443) may be a plain string or a `LocalizedText` locale-map for the
 * admin-UI's benefit. Emitted OpenAPI is plain JSON Schema, so a
 * locale-map `description` has to collapse to one string before it
 * goes on the wire — otherwise the emitted doc isn't valid JSON
 * Schema. Prefers `"en"` (the dev/OpenAPI-doc language per the #453
 * design note), then whichever locale `resolveLocalizedText` finds
 * first. Recurses into `properties`/`items` so nested and array field
 * descriptions collapse too; returns a fresh object rather than
 * mutating the manifest's schema.
 */
function collapseSchemaDescriptions(schema: JsonSchema): JsonSchema {
  const { description, title, properties, items, $defs, oneOf, additionalProperties, ...rest } = schema;
  const resolvedDescription = description === undefined ? null : resolveLocalizedText(description, "en");
  const resolvedTitle = title === undefined ? null : resolveLocalizedText(title, "en");
  return {
    ...rest,
    ...(resolvedDescription !== null ? { description: resolvedDescription } : {}),
    ...(resolvedTitle !== null ? { title: resolvedTitle } : {}),
    ...(properties
      ? {
          properties: Object.fromEntries(
            Object.entries(properties).map(([name, propSchema]) => [name, collapseSchemaDescriptions(propSchema)]),
          ),
        }
      : {}),
    ...(items ? { items: collapseSchemaDescriptions(items) } : {}),
    ...($defs
      ? {
          $defs: Object.fromEntries(
            Object.entries($defs).map(([name, definition]) => [name, collapseSchemaDescriptions(definition)]),
          ),
        }
      : {}),
    ...(oneOf ? { oneOf: oneOf.map(collapseSchemaDescriptions) } : {}),
    ...(typeof additionalProperties === "object"
      ? { additionalProperties: collapseSchemaDescriptions(additionalProperties) }
      : additionalProperties !== undefined
        ? { additionalProperties }
        : {}),
  };
}

function diagnosticSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["code", "phase", "severity", "path", "message"],
    properties: {
      code: { type: "string" },
      phase: { type: "string", enum: ["validate", "test", "boot", "runtime"] },
      severity: { type: "string", enum: ["error", "warning"] },
      path: { type: "string" },
      source: {
        type: "object",
        required: ["sourceId", "documentIndex", "path"],
        properties: {
          sourceId: { type: "string" },
          documentIndex: { type: "integer", minimum: 0 },
          path: { type: "string" },
          span: {
            type: "object",
            required: ["start", "end"],
            properties: {
              start: sourcePositionSchema(),
              end: sourcePositionSchema(),
            },
          },
        },
      },
      message: { type: "string" },
      value: {},
      expected: { type: "string" },
      suggestion: { type: "string" },
    },
  };
}

function sourcePositionSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["line", "column", "offset"],
    properties: {
      line: { type: "integer", minimum: 1 },
      column: { type: "integer", minimum: 1 },
      offset: { type: "integer", minimum: 0 },
    },
  };
}
