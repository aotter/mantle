import type { Context, Hono } from "hono";
import {
  DiagnosticError,
  HTTP_STATUS_BY_CODE,
  MCP_HINT_KEYWORD,
  VIEW_PARAMS_RESERVED,
  isMediaMcpHint,
  redactForWire,
  runtimeDiagnostic,
  type ContentState,
  type Diagnostic,
  type JsonSchema,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import {
  ViewParamCoercionError,
  coerceViewParams,
  evaluateAuthAll,
  matchPath,
  type CmsRuntime,
  type HandlerContext,
} from "@aotter/mantle-runtime";
import { indexHtml } from "@aotter/mantle-admin-ui";
import type { CmsRuntimeRef } from "./bootRuntimeOnce.js";
import { STAFF_ROLE_SET, type StaffRole, type Auth } from "../auth/createAuth.js";
import { AOTTER_FAVICON_SVG } from "../assets/aotterFavicon.js";

const [PAGE_PARAM, SHOW_PARAM] = VIEW_PARAMS_RESERVED;

/** Mount HTTP Triggers + Views + the Better Auth admin surface.
 *  HTTP Trigger bearer-token authentication is delegated to the OAuth
 *  provider lib (via `createMcpApiHandler`) — if a Trigger needs
 *  identity, route it under an MCP `apiHandler` instead of a Hono
 *  catch-all. */
export function mountServerEndpoints(
  app: Hono,
  ref: CmsRuntimeRef,
): void {
  for (const t of ref.manifests) {
    if (t.kind !== "Trigger") continue;
    const source = t.spec.source;
    if (source.kind !== "http") continue;
    const { method, path } = source;
    const honoPath = openApiToHono(path);
    const triggerName = t.metadata.name;
    app.on(method, honoPath, async (c) => {
      const runtime = await ref.get();
      const waitUntil = readWaitUntil(c);
      return handleHttpTrigger(c.req.raw, runtime, ref.auth, triggerName, path, waitUntil);
    });
  }
  for (const v of ref.manifests) {
    if (v.kind !== "View") continue;
    const viewName = v.metadata.name;
    app.get(`/api/views/${viewName}`, async (c) => {
      const runtime = await ref.get();
      const waitUntil = readWaitUntil(c);
      return handleViewRequest(c.req.raw, runtime, viewName, ref.auth, waitUntil);
    });
  }
  mountAdminBetterAuth(app, ref, ref.auth);
}

function mountAdminBetterAuth(app: Hono, ref: CmsRuntimeRef, auth: Auth): void {
  const spa = (): Response =>
    new Response(indexHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  app.get("/favicon.svg", () =>
    new Response(AOTTER_FAVICON_SVG, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    }),
  );

  // Public read-only manifest of registered sign-in methods. The admin
  // SPA hits this on sign-in-page mount so it can render per-method
  // sections without baking the method list into its build. No secrets
  // or sender refs — only the `kind` strings.
  //
  // `Cache-Control: no-store` because the list reflects deploy-time
  // config; if the operator rolls a new method, a CDN-cached response
  // would silently misroute the sign-in UI until the cache expires.
  app.get("/api/auth/methods", () =>
    Response.json({ methods: auth.methods }, {
      headers: { "cache-control": "no-store" },
    }),
  );

  // Better Auth handles the rest of `/api/auth/*` (sign-in, callback,
  // session, magic-link, OTP, OAuth provider routes). Owned by the SDK
  // so consumers don't have to wire — and can't accidentally register a
  // catch-all BEFORE the specific routes above and silently swallow
  // them. Hono matches in registration order; this catch-all sits last.
  app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

  // Well-known OAuth endpoints (RFC 8414 + RFC 9728) used to be
  // forwarded to Better Auth's mcp() plugin here. With the carve-out
  // to @cloudflare/workers-oauth-provider (PR #193), the top-level
  // `OAuthProvider` serves AS metadata and per-resource PRM
  // automatically — adopters wire it via `createOAuthProvider` +
  // `createMcpApiHandler` from the package index. No SDK-level
  // forwarder needed in `mountServerEndpoints`.

  for (const path of [
    "/admin",
    "/admin/",
    "/admin/sign-in",
    "/admin/c/:collection",
    "/admin/c/:collection/:id",
    "/admin/editor",
    "/admin/media",
    "/admin/approvals",
    "/admin/preferences",
    "/admin/settings",
  ]) {
    app.get(path, spa);
  }

  // Pre-derive the collections projection — `ref.manifests` is
  // immutable post-boot, so the filter / Set / mediaFields work doesn't
  // need to repeat per request.
  const schemas = ref.manifests.filter(
    (m): m is SchemaManifest => m.kind === "Schema",
  );
  const collections = schemas
    .filter((s) => !s.spec.translates)
    .map((s) => adminEditorCollection(s, schemas));

  type StaffGateOk = Extract<StaffGate, { kind: "ok" }>;
  const guarded = (
    method: "get" | "post" | "patch" | "delete",
    path: string,
    body: (c: Context, gate: StaffGateOk) => Response | Promise<Response>,
  ): void => {
    app.on(method.toUpperCase(), path, async (c) => {
      const gate = await readStaffGate(c, auth);
      if (gate.kind === "unauth") return adminUnauthenticated(c, path);
      if (gate.kind === "forbidden") return adminNotStaff(c, path, gate.login);
      return body(c, gate);
    });
  };

  guarded("get", "/admin/api/me", (_c, gate) =>
    jsonResponse(200, { login: gate.login, role: gate.role, userId: gate.userId }),
  );

  guarded("get", "/admin/api/collections", () => jsonResponse(200, { collections }));

  guarded("get", "/admin/api/site", async (c) => {
    const runtime = await ref.get();
    const site = await runtime.siteConfig.load();
    const url = new URL(c.req.url);
    return jsonResponse(200, {
      ...site,
      publicUrl: site.origin || url.origin,
      mcpUrl: `${url.origin}/mcp/staff`,
      staffMcpUrl: `${url.origin}/mcp/staff`,
      userMcpUrl: `${url.origin}/mcp`,
    });
  });

  guarded("get", "/admin/api/site-settings", async () =>
    runUseCase("GET /admin/api/site-settings", async () => {
      const runtime = await ref.get();
      const site = await runtime.siteConfig.load();
      const extra = await readSiteSettings(runtime);
      return { ...site, ...extra };
    }),
  );

  guarded("patch", "/admin/api/site-settings", async (c) =>
    runUseCase("PATCH /admin/api/site-settings", async () => {
      const runtime = await ref.get();
      const body = (await c.req.raw.json().catch(() => ({}))) as Record<string, unknown>;
      await writeSiteSettings(runtime, {
        brand: stringField(body.brand),
        title: stringField(body.title),
        description: stringField(body.description),
        brandIntro: stringField(body.brandIntro),
        serviceIncludes: stringField(body.serviceIncludes),
      });
      const site = await runtime.siteConfig.load();
      const extra = await readSiteSettings(runtime);
      return { ...site, ...extra };
    }),
  );

  guarded("get", "/admin/api/entries", async (c) => {
    const collection = c.req.query("collection");
    if (!collection) {
      return jsonResponse(400, {
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          severity: "error",
          path: "GET /admin/api/entries",
          expected: "?collection=<name> query parameter",
          message: "Missing `collection` query parameter.",
        }),
      });
    }
    const runtime = await ref.get();
    const rawLimit = c.req.query("limit");
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : NaN;
    const statusQuery = c.req.query("status");
    // Admin pagination needs the cursored shape — `executePage` returns
    // `{ rows, nextCursor? }`. `execute()` is the flat-array variant
    // for app code.
    const result = await runtime.listEntries.executePage({
      collection,
      status: statusQuery && statusQuery !== "all" ? (statusQuery as ContentState) : undefined,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 99,
      cursor: c.req.query("cursor") ?? undefined,
    });
    const items = result.rows.map(adminListItem);
    return jsonResponse(200, { items, next_cursor: result.nextCursor ?? null });
  });

  guarded("get", "/admin/api/entries/:id", async (c) =>
    runUseCase(`GET /admin/api/entries/${c.req.param("id")}`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const row = await runtime.getEntry.execute({ id });
      return entryEditorPayload(runtime, adminRowFromRuntime(row), schemas);
    }),
  );

  guarded("post", "/admin/api/entries", async (c, gate) =>
    runUseCase("POST /admin/api/entries", async () => {
      const runtime = await ref.get();
      const body = (await c.req.raw.json().catch(() => ({}))) as {
        collection?: unknown;
        data?: unknown;
      };
      if (typeof body.collection !== "string" || !body.collection) {
        throw new DiagnosticError(
          runtimeDiagnostic({
            code: "INPUT_VALIDATION_FAILED",
            severity: "error",
            path: "POST /admin/api/entries#/collection",
            expected: "non-empty string",
            message: "A non-empty `collection` is required.",
          }),
        );
      }
      const row = await runtime.createDraft.execute({
        collection: body.collection,
        data: objectField(body.data),
        authorId: gate.userId,
        ctx: adminHandlerContext(c, gate),
        originalInput: body,
      });
      return entryEditorPayload(runtime, adminRowFromRuntime(row), schemas);
    }),
  );

  guarded("patch", "/admin/api/entries/:id", async (c, gate) =>
    runUseCase(`PATCH /admin/api/entries/${c.req.param("id")}`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const body = (await c.req.raw.json().catch(() => ({}))) as {
        data?: unknown;
        expectedVersion?: unknown;
      };
      const updated = await runtime.updateDraft.execute({
        id,
        expectedVersion: expectedVersionField(body.expectedVersion, `PATCH /admin/api/entries/${id}#/expectedVersion`),
        data: objectField(body.data),
        ctx: adminHandlerContext(c, gate),
        originalInput: body,
      });
      return entryEditorPayload(runtime, adminRowFromRuntime(updated), schemas);
    }),
  );

  guarded("post", "/admin/api/entries/:id/publish", async (c, gate) =>
    runUseCase(`POST /admin/api/entries/${c.req.param("id")}/publish`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const body = await c.req.raw.json().catch(() => ({}));
      const row = await runtime.requestPublish.execute({
        id,
        ctx: adminHandlerContext(c, gate),
        originalInput: body,
      });
      return entryEditorPayload(runtime, adminRowFromRuntime(row), schemas);
    }),
  );

  guarded("post", "/admin/api/entries/:id/unpublish", async (c, gate) =>
    runUseCase(`POST /admin/api/entries/${c.req.param("id")}/unpublish`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const body = await c.req.raw.json().catch(() => ({}));
      const row = await runtime.unpublish.execute({
        id,
        ctx: adminHandlerContext(c, gate),
        originalInput: body,
      });
      return entryEditorPayload(runtime, adminRowFromRuntime(row), schemas);
    }),
  );

  guarded("delete", "/admin/api/entries/:id", async (c, gate) =>
    runUseCase(`DELETE /admin/api/entries/${c.req.param("id")}`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const body = await c.req.raw.json().catch(() => ({}));
      return runtime.deleteEntry.execute({
        id,
        ctx: adminHandlerContext(c, gate),
        originalInput: body,
      });
    }),
  );

  // Two-step multi-variant direct-upload flow (#272):
  //   POST /uploads (variants manifest) → caller PUTs every variant
  //   directly to R2 S3 (Worker bypassed) → POST /uploads/:groupId/commit.
  const MEDIA_UPLOADS_PATH = "/admin/api/media/uploads";
  const MEDIA_COMMIT_PATH = "/admin/api/media/uploads/:uploadGroupId/commit";

  guarded("post", MEDIA_UPLOADS_PATH, async (c) => {
    const runtime = await ref.get();
    const media = runtime.media;
    if (!media) return mediaNotConfiguredResponse(`POST ${MEDIA_UPLOADS_PATH}`);
    const body = (await c.req.raw.json().catch(() => ({}))) as {
      filename?: unknown;
      purpose?: unknown;
      variants?: unknown;
      alt?: unknown;
      caption?: unknown;
    };
    if (
      typeof body.filename !== "string" ||
      typeof body.purpose !== "string" ||
      !Array.isArray(body.variants)
    ) {
      return jsonResponse(400, {
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          severity: "error",
          path: `POST ${MEDIA_UPLOADS_PATH}`,
          expected:
            "{ filename: string, purpose: string, variants: [{ mimeType, byteSize, role }, ...] }",
        }),
      });
    }
    const variants: Array<{ mimeType: string; byteSize: number; role: "primary" | "alternate" | "fallback" }> = [];
    for (const raw of body.variants) {
      if (raw === null || typeof raw !== "object") {
        return jsonResponse(400, {
          ok: false,
          diagnostic: runtimeDiagnostic({
            code: "INPUT_VALIDATION_FAILED",
            severity: "error",
            path: `POST ${MEDIA_UPLOADS_PATH}`,
            expected: "variants[] entries are objects with { mimeType, byteSize, role }",
          }),
        });
      }
      const v = raw as Record<string, unknown>;
      const mimeType = v["mimeType"];
      const byteSize = v["byteSize"];
      const role = v["role"];
      if (
        typeof mimeType !== "string" ||
        typeof byteSize !== "number" ||
        !Number.isSafeInteger(byteSize) ||
        byteSize <= 0 ||
        (role !== "primary" && role !== "alternate" && role !== "fallback")
      ) {
        return jsonResponse(400, {
          ok: false,
          diagnostic: runtimeDiagnostic({
            code: "INPUT_VALIDATION_FAILED",
            severity: "error",
            path: `POST ${MEDIA_UPLOADS_PATH}`,
            expected:
              "each variant: { mimeType: string, byteSize: positive integer, role: 'primary'|'alternate'|'fallback' }",
          }),
        });
      }
      variants.push({ mimeType, byteSize, role });
    }
    const { filename, purpose } = body;
    return runUseCase(`POST ${MEDIA_UPLOADS_PATH}`, () =>
      media.createUpload.execute({
        filename,
        purpose,
        variants,
        alt: typeof body.alt === "string" ? body.alt : undefined,
        caption: typeof body.caption === "string" ? body.caption : undefined,
      }),
    );
  });

  guarded("post", MEDIA_COMMIT_PATH, async (c) => {
    const runtime = await ref.get();
    const media = runtime.media;
    if (!media) return mediaNotConfiguredResponse(`POST ${MEDIA_COMMIT_PATH}`);
    // Hono only invokes this handler when the route matched, so the
    // path param is always present at runtime.
    const uploadGroupId = c.req.param("uploadGroupId")!;
    const body = (await c.req.raw.json().catch(() => ({}))) as {
      alt?: unknown;
      caption?: unknown;
    };
    return runUseCase(`POST ${MEDIA_COMMIT_PATH}`, () =>
      media.commitUpload.execute({
        uploadGroupId,
        alt: typeof body.alt === "string" ? body.alt : undefined,
        caption: typeof body.caption === "string" ? body.caption : undefined,
      }),
    );
  });
}

function adminEntryTitle(data: Record<string, unknown>): unknown {
  if (typeof data.title === "string" && data.title) return data.title;
  if (typeof data.slug === "string" && data.slug) return data.slug;
  if (typeof data.skuCode === "string" && data.skuCode) return data.skuCode;
  if (typeof data.orderId === "string" && data.orderId) return data.orderId;
  return null;
}

function adminListItem(row: AdminEntryRow): {
  id: string;
  collection: string;
  locale: string | null;
  status: string;
  version: number;
  title: unknown;
  updated_at: number;
} {
  return {
    id: row.id,
    collection: row.collection,
    locale: row.locale ?? null,
    status: row.status,
    version: row.version,
    title: adminEntryTitle(row.data),
    updated_at: row.updatedAt,
  };
}

type AdminEntryRow = {
  readonly id: string;
  readonly collection: string;
  readonly status: ContentState;
  readonly version: number;
  readonly data: Record<string, unknown>;
  readonly locale?: string;
  readonly authorId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type AdminEntryDbRow = {
  readonly id: string;
  readonly collection: string;
  readonly status: string;
  readonly version: number;
  readonly data: string;
  readonly author_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

async function entryEditorPayload(
  runtime: CmsRuntime,
  row: AdminEntryRow,
  schemas: SchemaManifest[],
): Promise<AdminEntryEditorPayload> {
  const schema = schemas.find((s) => s.metadata.name === row.collection);
  if (!schema) {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "NOT_FOUND",
        severity: "error",
        path: `admin/editor/${row.collection}`,
        value: row.collection,
        expected: "declared Schema manifest",
        message: `Schema '${row.collection}' was not found.`,
      }),
    );
  }
  const related = await relatedEntrySections(runtime, schema, row, schemas);
  return {
    collection: adminEditorCollection(schema, schemas),
    entry: adminEditorEntry(row),
    related,
  };
}

type AdminEditorCollection = {
  readonly name: string;
  readonly title: string;
  readonly description: string | null;
  readonly lifecycle: "simple" | "editorial";
  readonly hasTranslations: boolean;
  readonly localized: boolean;
  readonly translates: SchemaManifest["spec"]["translates"] | null;
  readonly schema: JsonSchema;
  readonly uiSchema: Record<string, unknown> | null;
  readonly mediaFields: Array<{ name: string; hint: string }>;
};

type AdminEditorEntry = {
  readonly id: string;
  readonly collection: string;
  readonly locale: string | null;
  readonly status: ContentState;
  readonly version: number;
  readonly data: Record<string, unknown>;
  readonly updated_at: number;
};

type AdminEntryEditorPayload = {
  readonly collection: AdminEditorCollection;
  readonly entry: AdminEditorEntry;
  readonly related: AdminRelatedEntrySection[];
};

type AdminRelatedEntrySection = {
  readonly collection: AdminEditorCollection;
  readonly relationship: {
    readonly kind: "translation" | "field";
    readonly parentField: string;
    readonly childField: string;
    readonly parentValue: string | number | boolean;
  };
  readonly entries: AdminEditorEntry[];
};

function adminEditorCollection(
  schema: SchemaManifest,
  schemas: SchemaManifest[],
): AdminEditorCollection {
  return {
    name: schema.metadata.name,
    title: schema.spec.title,
    description: schema.spec.description ?? null,
    lifecycle: schema.spec.lifecycle ?? "simple",
    hasTranslations: schemas.some((candidate) => candidate.spec.translates?.parent === schema.metadata.name),
    localized: schema.spec.localized ?? Boolean(schema.spec.translates),
    translates: schema.spec.translates ?? null,
    schema: schema.spec.schema,
    uiSchema: schema.spec.uiSchema ?? null,
    mediaFields: mediaFieldsForCollection(schema, schemas),
  };
}

function adminEditorEntry(row: AdminEntryRow): AdminEditorEntry {
  return {
    id: row.id,
    collection: row.collection,
    locale: row.locale ?? null,
    status: row.status,
    version: row.version,
    data: row.data,
    updated_at: row.updatedAt,
  };
}

async function relatedEntrySections(
  runtime: CmsRuntime,
  parentSchema: SchemaManifest,
  parentRow: AdminEntryRow,
  schemas: SchemaManifest[],
): Promise<AdminRelatedEntrySection[]> {
  const relationships = discoverChildRelationships(parentSchema, parentRow, schemas);
  const sections: AdminRelatedEntrySection[] = [];
  for (const relationship of relationships) {
    const childSchema = schemas.find((schema) => schema.metadata.name === relationship.collection);
    if (!childSchema) continue;
    const entries = await entriesByDataValue(
      runtime,
      relationship.collection,
      relationship.childField,
      relationship.parentValue,
    );
    sections.push({
      collection: adminEditorCollection(childSchema, schemas),
      relationship: {
        kind: relationship.kind,
        parentField: relationship.parentField,
        childField: relationship.childField,
        parentValue: relationship.parentValue,
      },
      entries: entries.map(adminEditorEntry),
    });
  }
  return sections;
}

type DiscoveredRelationship = {
  readonly collection: string;
  readonly kind: "translation" | "field";
  readonly parentField: string;
  readonly childField: string;
  readonly parentValue: string | number | boolean;
};

function discoverChildRelationships(
  parentSchema: SchemaManifest,
  parentRow: AdminEntryRow,
  schemas: SchemaManifest[],
): DiscoveredRelationship[] {
  const parentName = parentSchema.metadata.name;
  const parentProps = parentSchema.spec.schema.properties ?? {};
  const relationships: DiscoveredRelationship[] = [];
  const seen = new Set<string>();
  const add = (
    childSchema: SchemaManifest,
    kind: "translation" | "field",
    parentField: string,
    childField: string,
  ): void => {
    const parentValue = primitiveJoinValue(parentRow.data[parentField]);
    if (parentValue == null) return;
    const key = `${childSchema.metadata.name}:${kind}:${parentField}:${childField}:${String(parentValue)}`;
    if (seen.has(key)) return;
    seen.add(key);
    relationships.push({
      collection: childSchema.metadata.name,
      kind,
      parentField,
      childField,
      parentValue,
    });
  };

  for (const childSchema of schemas) {
    if (childSchema.metadata.name === parentName) continue;
    const childProps = childSchema.spec.schema.properties ?? {};
    const translates = childSchema.spec.translates;
    if (translates?.parent === parentName) {
      add(childSchema, "translation", translates.on, translates.on);
      continue;
    }

    for (const [parentField] of Object.entries(parentProps)) {
      if (!isLikelyJoinField(parentField)) continue;
      if (!Object.prototype.hasOwnProperty.call(childProps, parentField)) continue;
      add(childSchema, "field", parentField, parentField);
    }

    for (const [childField] of Object.entries(childProps)) {
      const parentField = conventionalParentField(parentName, childField, parentProps);
      if (parentField) add(childSchema, "field", parentField, childField);
    }
  }

  return relationships;
}

function isLikelyJoinField(field: string): boolean {
  return /^(id|slug|sku|skuCode|code|key)$/i.test(field);
}

function conventionalParentField(
  parentCollectionName: string,
  childField: string,
  parentProps: Readonly<Record<string, JsonSchema>>,
): string | null {
  const bases = new Set([
    camelCaseIdentifier(parentCollectionName),
    singularizeIdentifier(camelCaseIdentifier(parentCollectionName)),
  ]);
  const candidates = ["slug", "id", "sku", "code"].filter((field) =>
    Object.prototype.hasOwnProperty.call(parentProps, field),
  );
  for (const base of bases) {
    for (const parentField of candidates) {
      if (childField === `${base}${capitalizeIdentifier(parentField)}`) return parentField;
    }
  }
  return null;
}

function primitiveJoinValue(value: unknown): string | number | boolean | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function camelCaseIdentifier(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part, index) => {
      const lower = part.charAt(0).toLowerCase() + part.slice(1);
      return index === 0 ? lower : capitalizeIdentifier(lower);
    })
    .join("");
}

function singularizeIdentifier(value: string): string {
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ses")) return value.slice(0, -2);
  if (value.endsWith("s") && value.length > 1) return value.slice(0, -1);
  return value;
}

function capitalizeIdentifier(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function entriesByDataValue(
  runtime: CmsRuntime,
  collection: string,
  field: string,
  value: string | number | boolean,
): Promise<AdminEntryRow[]> {
  const rows = await runtime.db
    .prepare(
      `SELECT id, collection, status, version, data, author_id, created_at, updated_at
       FROM entries
       WHERE collection = ? AND json_extract(data, ?) = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT 50`,
    )
    .bind(collection, `$.${field}`, value)
    .all<AdminEntryDbRow>();
  return rows.map(adminRowFromDb);
}

async function readSiteSettings(runtime: CmsRuntime): Promise<{
  brandIntro: string;
  serviceIncludes: string;
}> {
  const rows = await runtime.db
    .prepare(`SELECT key, value FROM site_config WHERE key IN ('brandIntro', 'serviceIncludes')`)
    .all<{ key: string; value: string }>();
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    brandIntro: map.get("brandIntro") ?? "",
    serviceIncludes: map.get("serviceIncludes") ?? "",
  };
}

async function writeSiteSettings(
  runtime: CmsRuntime,
  values: {
    brand?: string;
    title?: string;
    description?: string;
    brandIntro?: string;
    serviceIncludes?: string;
  },
): Promise<void> {
  const stmts = Object.entries(values)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) =>
      runtime.db
        .prepare(`INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .bind(key, value),
    );
  if (stmts.length > 0) await runtime.db.batch(stmts);
}

function adminRowFromDb(row: AdminEntryDbRow): AdminEntryRow {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  const locale = typeof data.locale === "string" ? data.locale : undefined;
  return {
    id: row.id,
    collection: row.collection,
    status: row.status as ContentState,
    version: row.version,
    data,
    locale,
    authorId: row.author_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function adminRowFromRuntime(row: AdminEntryRow): AdminEntryRow {
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    version: row.version,
    data: row.data,
    locale: row.locale,
    authorId: row.authorId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function expectedVersionField(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new DiagnosticError(
    runtimeDiagnostic({
      code: "INPUT_VALIDATION_FAILED",
      severity: "error",
      path,
      expected: "non-negative integer",
      message: "`expectedVersion` is required for draft updates.",
    }),
  );
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type StaffGate =
  | { kind: "unauth" }
  | { kind: "forbidden"; login: string | null }
  | {
      kind: "ok";
      userId: string;
      login: string | null;
      role: StaffRole;
    };

function adminHandlerContext(c: Context, gate: Extract<StaffGate, { kind: "ok" }>): HandlerContext {
  const waitUntil = readWaitUntil(c);
  return {
    user: { id: gate.userId },
    staff: { id: gate.userId, role: gate.role },
    env: {},
    ...(waitUntil ? { waitUntil } : {}),
  };
}

async function readStaffGate(c: Context, auth: Auth): Promise<StaffGate> {
  const session = await auth.getSession(c.req.raw);
  if (!session) return { kind: "unauth" };
  const role = session.user.role ?? null;
  const login = session.user.githubLogin ?? null;
  if (!role || !STAFF_ROLE_SET.has(role)) {
    return { kind: "forbidden", login };
  }
  return {
    kind: "ok",
    userId: session.user.id,
    login,
    role: role as StaffRole,
  };
}

async function handleHttpTrigger(
  req: Request,
  runtime: CmsRuntime,
  auth: Auth,
  triggerName: string,
  triggerPath: string,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
): Promise<Response> {
  const trigger = runtime.triggersByName.get(triggerName);
  if (!trigger) {
    return jsonError({ status: 500, code: "INTERNAL_ERROR", message: `Trigger '${triggerName}' missing post-boot.` });
  }
  const procName = trigger.spec.target.procedure;
  const procedure = runtime.proceduresByName.get(procName);
  if (!procedure) {
    return jsonError({ status: 500, code: "INTERNAL_ERROR", message: `Procedure '${procName}' missing post-boot.` });
  }

  const url = new URL(req.url);
  const params = matchPath(triggerPath, url.pathname) ?? {};
  const body = await readBody(req);
  // Spread order matters: URL path params are authoritative for the
  // resource identifier (a `DELETE /entries/{id}` body MUST NOT spoof
  // `id`). Body fields fill in non-path inputs only.
  const input = { ...body, ...params };

  const triggerPathPrefix = `${req.method} ${triggerPath}`;
  const ctx = await buildCallerContext(req, auth, waitUntil);

  // Mirror the View handler's 401-vs-403 discipline (see
  // `handleViewRequest`). An auth-gated Procedure called with no
  // session is UNAUTHENTICATED (401); a session whose role fails the
  // predicate is AUTH_DENIED (403). InvokeProcedureUseCase collapses
  // both into AUTH_DENIED if we pass `{ user: null, staff: null }`
  // as ctx, so we pre-check here.
  if (procedure.spec.requires?.auth && !ctx) {
    return jsonResponse(401, {
      ok: false,
      diagnostic: runtimeDiagnostic({
        code: "UNAUTHENTICATED",
        severity: "error",
        path: triggerPathPrefix,
        expected: "authenticated session",
        message: `Procedure '${procName}' requires authentication.`,
      }),
    });
  }

  const wu = waitUntil ? { waitUntil } : {};
  const invokeCtx: HandlerContext = ctx ?? { user: null, staff: null, env: {}, ...wu };

  const result = await runtime.invokeProcedure.execute({
    procedure,
    input,
    ctx: invokeCtx,
    pathPrefix: triggerPathPrefix,
  });

  if (result.ok) {
    return jsonResponse(200, { ok: true, data: result.data });
  }
  const status = HTTP_STATUS_BY_CODE[result.diagnostic.code] ?? 500;
  return jsonResponse(status, { ok: false, diagnostic: result.diagnostic });
}

async function handleViewRequest(
  req: Request,
  runtime: CmsRuntime,
  viewName: string,
  auth: Auth,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
): Promise<Response> {
  const view = runtime.viewsByName.get(viewName);
  if (!view) {
    return jsonError({ status: 500, code: "INTERNAL_ERROR", message: `View '${viewName}' missing post-boot.` });
  }

  const viewPath = `GET /api/views/${viewName}`;

  // Resolve caller identity FIRST and evaluate `requires.auth.all`
  // BEFORE param coercion. Two reasons:
  //   (1) a param-coercion 400 against an auth-gated View would leak
  //       the View's parameter contract to an unauthorized caller —
  //       this matters for both anonymous probes AND authenticated
  //       users without the required role.
  //   (2) the UNAUTHENTICATED branch in ExecuteViewUseCase only fires
  //       when ctx is undefined, so passing a guest ctx for no-session
  //       would collapse 401 and 403 into the same AUTH_DENIED.
  const ctx = await buildCallerContext(req, auth, waitUntil);
  if (view.spec.requires?.auth) {
    if (!ctx) {
      return jsonResponse(401, {
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "UNAUTHENTICATED",
          severity: "error",
          path: viewPath,
          expected: "authenticated session",
          message: `View '${viewName}' requires authentication.`,
        }),
      });
    }
    const denial = evaluateAuthAll(view.spec.requires, ctx, viewPath, "runtime");
    if (denial) {
      return jsonResponse(HTTP_STATUS_BY_CODE[denial.code] ?? 403, {
        ok: false,
        diagnostic: denial,
      });
    }
  }

  const url = new URL(req.url);
  const page = parsePositiveInt(url.searchParams.get(PAGE_PARAM));
  const show = parsePositiveInt(url.searchParams.get(SHOW_PARAM));

  let params: Record<string, unknown>;
  try {
    params = coerceViewParams(view, url.searchParams);
  } catch (err) {
    if (err instanceof ViewParamCoercionError) {
      return jsonResponse(400, {
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          severity: "error",
          path: viewPath,
          expected: "query string conforms to View.spec.params",
          message: err.message,
        }),
      });
    }
    throw err;
  }

  const result = await runtime.executeView.execute({
    view,
    pathPrefix: viewPath,
    options: { params, page, show },
    ctx,
  });

  if (result.ok) {
    return jsonResponse(200, { ok: true, data: result.result });
  }
  const status = HTTP_STATUS_BY_CODE[result.diagnostic.code] ?? 500;
  return jsonResponse(status, { ok: false, diagnostic: result.diagnostic });
}

/**
 * Resolve caller identity for a View or HTTP-Trigger request from the
 * Better Auth cookie session. Returns `undefined` when there is no
 * session so callers can distinguish 401 (no session) from 403
 * (session but wrong role) — `ExecuteViewUseCase` and the
 * `handleHttpTrigger` pre-check both rely on this signal.
 *
 * Used by both `handleViewRequest` and `handleHttpTrigger` so the
 * two HTTP surfaces resolve identity identically.
 *
 * Note: this resolves cookie sessions only. OAuth bearer tokens
 * (issued by `createOAuthProvider` for MCP callers) are NOT verified
 * here — bearer-authenticated identity belongs on the MCP surface,
 * not the HTTP Trigger surface, so a bearer-only caller hitting an
 * auth-gated Trigger will land at the 401 branch in
 * `handleHttpTrigger`. Procedures that need to be agent-callable
 * should be reached via `/mcp` or `/mcp/staff` (see #281).
 */
async function buildCallerContext(
  req: Request,
  auth: Auth,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
): Promise<HandlerContext | undefined> {
  const session = await auth.getSession(req);
  if (!session) return undefined;
  const wu = waitUntil ? { waitUntil } : {};
  const role = await auth.getUserRole(session.user.id);
  const staff = role && STAFF_ROLE_SET.has(role)
    ? { id: session.user.id, role: role as StaffRole }
    : null;
  return { user: { id: session.user.id }, staff, env: {}, ...wu };
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "DELETE" || req.method === "HEAD") {
    return {};
  }
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("json")) return {};
  try {
    const parsed = await req.json<Record<string, unknown>>();
    return parsed ?? {};
  } catch {
    return {};
  }
}

function openApiToHono(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

/**
 * Hono's `c.executionCtx` getter THROWS when the underlying request
 * was dispatched without an `ExecutionContext` (test harness via
 * `app.request(...)`, non-Workers runtimes). Treat the throw as
 * "no waitUntil available" and fall back to inline-await downstream.
 */
function readWaitUntil(c: Context): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return ctx.waitUntil.bind(ctx);
  } catch {
    return undefined;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mediaFieldsForCollection(
  schema: SchemaManifest,
  schemas: readonly SchemaManifest[],
): Array<{ name: string; hint: string }> {
  const related = [
    schema,
    ...schemas.filter((s) => s.spec.translates?.parent === schema.metadata.name),
  ];
  const out: Array<{ name: string; hint: string }> = [];
  for (const s of related) {
    out.push(...mediaFieldsForSchema(s));
  }
  return out;
}

function mediaFieldsForSchema(schema: SchemaManifest): Array<{ name: string; hint: string }> {
  const props =
    (schema.spec.schema as { properties?: Record<string, unknown> }).properties ?? {};
  const out: Array<{ name: string; hint: string }> = [];
  for (const [name, prop] of Object.entries(props)) {
    if (typeof prop !== "object" || prop === null) continue;
    const hint = (prop as Record<string, unknown>)[MCP_HINT_KEYWORD];
    if (!isMediaMcpHint(hint)) continue;
    out.push({ name, hint });
  }
  return out;
}

function adminUnauthenticated(c: Context, path: string): Response {
  return jsonResponse(401, {
    ok: false,
    diagnostic: runtimeDiagnostic({
      code: "UNAUTHENTICATED",
      severity: "error",
      path: `${c.req.method} ${path}`,
      expected: "active session cookie",
      message: "Not signed in. Sign in via /admin/sign-in first.",
    }),
  });
}

// Distinct from UNAUTHENTICATED so the SPA can render an "access
// denied" view for users who DID sign in but lack a staff row,
// instead of bouncing them back to /admin/sign-in (which the OAuth
// re-auth then silently fast-forwards through, producing a visible
// 5-step redirect chain that looks like an infinite loop).
function adminNotStaff(c: Context, path: string, login: string | null): Response {
  return jsonResponse(403, {
    ok: false,
    login,
    diagnostic: runtimeDiagnostic({
      code: "AUTH_DENIED",
      severity: "error",
      path: `${c.req.method} ${path}`,
      expected: "staff role for the signed-in user",
      message:
        "Signed in, but this account isn't on the admin staff list. Contact a site owner to be added.",
    }),
  });
}

function jsonError(args: { status: number; code: string; message: string }): Response {
  const diagnostic: Partial<Diagnostic> = {
    code: args.code as Diagnostic["code"],
    severity: "error",
    phase: "runtime",
    path: "mount/http",
    message: args.message,
  };
  return jsonResponse(args.status, { ok: false, diagnostic });
}

async function runUseCase<T>(opPath: string, fn: () => Promise<T>): Promise<Response> {
  try {
    const result = await fn();
    return jsonResponse(200, result);
  } catch (e) {
    if (e instanceof DiagnosticError) {
      const status = HTTP_STATUS_BY_CODE[e.diagnostic.code] ?? 500;
      return jsonResponse(status, { ok: false, diagnostic: redactForWire(e.diagnostic) });
    }
    // Don't leak raw exception strings on the wire — R2 / D1 / aws4fetch
    // errors can carry bucket names, account IDs, or query fragments.
    console.error(`[runUseCase ${opPath}] unhandled error`, e);
    return jsonResponse(500, {
      ok: false,
      diagnostic: runtimeDiagnostic({
        code: "INTERNAL_ERROR",
        severity: "error",
        path: opPath,
        message: "An internal error occurred.",
      }),
    });
  }
}

function mediaNotConfiguredResponse(path: string): Response {
  return jsonResponse(501, {
    ok: false,
    diagnostic: runtimeDiagnostic({
      code: "MEDIA_NOT_CONFIGURED",
      severity: "error",
      path,
      message:
        "Media uploads are not enabled on this deployment. Bind a `mediaStorage` adapter in `createCmsRuntime` to enable.",
    }),
  });
}

export type { CmsRuntimeRef };
