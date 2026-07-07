import { partitionManifests } from "../domain/service/ManifestParser.js";
import { resolveLocalizedText } from "../domain/model/ManifestGrammar.js";
import type {
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
    const { views, procedures, triggers } = partitionManifests(request.manifests);
    const procByName = new Map(procedures.map((p) => [p.metadata.name, p]));
    const paths: Record<string, Record<string, unknown>> = {};

    for (const t of triggers) {
      const src = t.spec.source;
      if (src.kind !== "http") continue;
      const proc = procByName.get(t.spec.target.procedure);
      if (!proc) continue;
      const path = src.path;
      paths[path] ??= {};
      paths[path]![src.method.toLowerCase()] = httpOperation(t, proc);
    }

    for (const v of views) {
      const path = `/api/views/${v.metadata.name}`;
      paths[path] ??= {};
      paths[path]!["get"] = viewOperation(v);
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
          securitySchemes: {
            // Bearer for Procedure invocation paths (HTTP Triggers
            // sit on the MCP-adjacent surface that the OAuth provider
            // validates bearer tokens for).
            bearer: { type: "http", scheme: "bearer" },
            // Cookie for View REST paths — the Cloudflare adapter's
            // `/api/views/*` resolves identity via `auth.getSession`
            // (Better Auth cookie). Default to the secure production
            // cookie name (Better Auth adds `__Secure-` prefix when
            // baseURL is HTTPS); callers on a non-secure deployment
            // pass `sessionCookieName: "better-auth.session_token"`.
            cookieAuth: {
              type: "apiKey",
              in: "cookie",
              name: request.sessionCookieName ?? DEFAULT_SESSION_COOKIE_NAME,
            },
          },
        },
      },
    };
  }

  static run(request: EmitOpenapiRequest): EmitOpenapiResponse {
    return new EmitOpenapiUseCase().execute(request);
  }
}

function httpOperation(t: TriggerManifest, p: ProcedureManifest): Record<string, unknown> {
  const method = t.spec.source.kind === "http" ? t.spec.source.method : "POST";
  const op: Record<string, unknown> = {
    operationId: `${method.toLowerCase()}_${p.metadata.name.replace(/[^a-z0-9]+/gi, "_")}`,
    summary: `Trigger ${t.metadata.name}`,
    requestBody: {
      required: true,
      content: { "application/json": { schema: collapseSchemaDescriptions(p.spec.input) } },
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
  if (p.spec.requires?.auth?.all && p.spec.requires.auth.all.length > 0) {
    op["security"] = [{ bearer: [] }];
  }
  return op;
}

function viewOperation(v: ViewManifest): Record<string, unknown> {
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
  // When `requires.auth.all` is set, emit cookie-session security +
  // 401/403 responses. Views ride the `/api/views/*` REST surface
  // which the Cloudflare adapter gates via Better Auth session cookie
  // (NOT bearer — bearer is for Procedure HTTP Triggers which sit on
  // the OAuth-validated MCP surface).
  if (v.spec.requires?.auth?.all && v.spec.requires.auth.all.length > 0) {
    op["security"] = [{ cookieAuth: [] }];
    responses["401"] = {
      description: "Authentication required",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
    };
    responses["403"] = {
      description: "Auth predicate not satisfied",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
    };
  }
  return op;
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
  const { description, properties, items, ...rest } = schema;
  const resolvedDescription = description === undefined ? null : resolveLocalizedText(description, "en");
  return {
    ...rest,
    ...(resolvedDescription !== null ? { description: resolvedDescription } : {}),
    ...(properties
      ? {
          properties: Object.fromEntries(
            Object.entries(properties).map(([name, propSchema]) => [name, collapseSchemaDescriptions(propSchema)]),
          ),
        }
      : {}),
    ...(items ? { items: collapseSchemaDescriptions(items) } : {}),
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
      message: { type: "string" },
      value: {},
      expected: { type: "string" },
      suggestion: { type: "string" },
    },
  };
}
