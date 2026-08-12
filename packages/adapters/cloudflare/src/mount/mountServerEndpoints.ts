import type { Context, Env, Hono } from "hono";
import {
  DiagnosticError,
  HTTP_STATUS_BY_CODE,
  MANTLE_REF_KEYWORD,
  MCP_HINT_KEYWORD,
  VIEW_PARAMS_RESERVED,
  isMediaMcpHint,
  meetsRole,
  redactForWire,
  runtimeDiagnostic,
  checkSchemaListFilter,
  type ContentState,
  type Diagnostic,
  type Entry,
  type JsonSchema,
  type LocalizedText,
  type Manifest,
  type ProcedureManifest,
  type SchemaManifest,
  type SiteConfig,
  type ViewManifest,
} from "@aotter/mantle-spec";
import {
  ViewParamCoercionError,
  coerceViewParams,
  compilePathMatcher,
  evaluateAuthAll,
  type CmsRuntime,
  type HandlerContext,
  type MediaAsset,
} from "@aotter/mantle-runtime";
import { indexHtml } from "@aotter/mantle-admin-ui";
import type { CmsRuntimeRef } from "./bootRuntimeOnce.js";
import { resolveCaller, resolveUserRole } from "./resolveCaller.js";
import { runMantleUseCase } from "./runMantleUseCase.js";
import { STAFF_ROLE_SET, type StaffRole, type Auth } from "../auth/createAuth.js";
import { rejectCrossOriginMutation } from "../auth/rejectCrossOriginMutation.js";
import { AOTTER_FAVICON_SVG } from "../assets/aotterFavicon.js";

const [PAGE_PARAM, SHOW_PARAM] = VIEW_PARAMS_RESERVED;

/** Mount HTTP Triggers + Views + the Better Auth admin surface.
 *  HTTP Trigger bearer-token authentication is delegated to the OAuth
 *  provider lib (via `createMcpApiHandler`) — if a Trigger needs
 *  identity, route it under an MCP `apiHandler` instead of a Hono
 *  catch-all. */
export function mountServerEndpoints<E extends Env>(
  app: Hono<E>,
  ref: CmsRuntimeRef,
): void {
  for (const t of ref.manifests) {
    if (t.kind !== "Trigger") continue;
    const source = t.spec.source;
    if (source.kind !== "http") continue;
    const { method, path } = source;
    const honoPath = openApiToHono(path);
    const matchTriggerPath = compilePathMatcher(path);
    const triggerName = t.metadata.name;
    app.on(method, honoPath, async (c) => {
      const runtime = await ref.get();
      const waitUntil = readWaitUntil(c);
      return handleHttpTrigger(
        c.req.raw,
        runtime,
        ref,
        triggerName,
        path,
        matchTriggerPath(c.req.path) ?? {},
        c.env,
        waitUntil,
      );
    });
  }
  for (const v of ref.manifests) {
    if (v.kind !== "View") continue;
    // Staff Views (#433) are NOT mounted on the public path — they
    // register under the guarded `/admin/api/views/<name>` route
    // inside `mountAdminBetterAuth` (which owns the staff gate).
    // Public (default) Views keep the public REST surface.
    if (v.spec.surface === "staff") continue;
    const viewName = v.metadata.name;
    app.get(`/api/views/${viewName}`, async (c) => {
      const runtime = await ref.get();
      const waitUntil = readWaitUntil(c);
      return handleViewRequest(c.req.raw, runtime, viewName, ref, c.env, waitUntil, "/api/views");
    });
  }
  mountAdminBetterAuth(app, ref, ref.auth);
}

function mountAdminBetterAuth<E extends Env>(app: Hono<E>, ref: CmsRuntimeRef, auth: Auth): void {
  const authBasePath = auth.basePath;
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
  app.get(`${authBasePath}/methods`, () =>
    Response.json({ methods: auth.methods }, {
      headers: { "cache-control": "no-store" },
    }),
  );

  // Better Auth handles the rest of the configured auth base path
  // (sign-in, callback,
  // session, magic-link, OTP, OAuth provider routes). Owned by the SDK
  // so consumers don't have to wire — and can't accidentally register a
  // catch-all BEFORE the specific routes above and silently swallow
  // them. Hono matches in registration order; this catch-all sits last.
  app.all(`${authBasePath}/*`, (c) => auth.handler(c.req.raw));

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
    "/admin/media",
    "/admin/preferences",
    "/admin/settings",
    "/admin/staff",
    "/admin/ops",
    "/admin/views/:name",
  ]) {
    app.get(path, spa);
  }

  // Pre-derive the collections projection — `ref.manifests` is
  // immutable post-boot, so the filter / Set / mediaFields work doesn't
  // need to repeat per request.
  const schemas = ref.manifests.filter(
    (m): m is SchemaManifest => m.kind === "Schema",
  );
  const schemasByName = new Map(schemas.map((s) => [s.metadata.name, s]));
  const collections = schemas
    .filter((s) => !s.spec.translates)
    .map((s) => adminEditorCollection(s, schemas));

  // Staff-operable Procedures (#426, extended #430 with rowBindings):
  // precompute at mount, same as `collections` above — `ref.manifests`
  // is immutable post-boot.
  const operations = discoverStaffOperations(ref.manifests, schemasByName);
  const operationsByName = new Map(operations.map((op) => [op.name, op]));

  // Views projection (#426) — least-code option: a dedicated
  // `/admin/api/views-manifest` endpoint rather than folding into
  // `/admin/api/site`. Reasoning: `/admin/api/site` payload is
  // site-config-shaped (title/brand/locales/mcp URLs) and consumed by
  // several unrelated views (entry editor, settings) via a shared
  // `SiteInfo` query key; growing it with an unrelated `views: [...]`
  // array would force every one of those call sites to widen their
  // type and would invalidate/refetch on unrelated site-settings
  // changes. A dedicated guarded route mirrors the existing
  // `/admin/api/collections` precedent exactly (same shape of
  // "precompute at mount from ref.manifests, list on GET") and needs
  // no changes to the `SiteInfo` type or its query key.
  // Report-sidebar source (#433): ONLY `surface: staff` Views. Public
  // storefront Views (default surface) auto-mount on the public REST
  // path and must not appear in the admin report sidebar — listing
  // them was noise + broke on param-driven storefront Views (see #433).
  const staffViews = ref.manifests
    .filter((m): m is ViewManifest => m.kind === "View" && m.spec.surface === "staff");
  const viewsManifest = staffViews.map((v) => ({
    name: v.metadata.name,
    title: v.spec.title ?? null,
    from: v.spec.from,
    params: v.spec.params ?? null,
    fields: v.spec.fields ?? null,
  }));

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

  const roleGuarded = (
    method: "get" | "post" | "patch" | "delete",
    path: string,
    minimumRole: StaffRole,
    body: (c: Context, gate: StaffGateOk) => Response | Promise<Response>,
  ): void => {
    guarded(method, path, (c, gate) => {
      if (!meetsRole(gate.role, minimumRole)) {
        return adminInsufficientRole(c, path, minimumRole);
      }
      return body(c, gate);
    });
  };

  guarded("get", "/admin/api/me", (_c, gate) =>
    Response.json({ login: gate.login, role: gate.role, userId: gate.userId, image: gate.image }),
  );

  roleGuarded("get", "/admin/api/staff", "owner", async () =>
    Response.json({ users: await auth.listUsers() }),
  );

  roleGuarded("patch", "/admin/api/staff/:id/role", "owner", async (c, gate) => {
    const userId = c.req.param("id") ?? "";
    const body = (await c.req.raw.json().catch(() => ({}))) as Record<string, unknown>;
    const role = body.role === null ? null : typeof body.role === "string" ? body.role : undefined;
    if (role === undefined || (role !== null && !STAFF_ROLE_SET.has(role))) {
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          severity: "error",
          path: `PATCH /admin/api/staff/:id/role`,
          expected: `body.role in [${[...STAFF_ROLE_SET].join(", ")}] or null`,
          message: "`role` must be a staff role string or null (revoke).",
        }),
      }, { status: 400 });
    }
    // An owner cannot change their own role. Demoting the only owner
    // would lock everyone out of staff management with no SDK-side
    // recovery path (the fix would be a manual D1 UPDATE).
    if (userId === gate.userId) {
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "AUTH_DENIED",
          severity: "error",
          path: `PATCH /admin/api/staff/:id/role`,
          expected: "target user is not the caller",
          message: "You cannot change your own role.",
        }),
      }, { status: 403 });
    }
    const changed = await auth.setUserRole(userId, role as StaffRole | null);
    if (!changed) {
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "NOT_FOUND",
          severity: "error",
          path: `PATCH /admin/api/staff/:id/role`,
          expected: "an existing user id",
          message: "No user matched that id.",
        }),
      }, { status: 404 });
    }
    return Response.json({ ok: true });
  });

  roleGuarded("post", "/admin/api/staff/invitations", "owner", async (c) => {
    const body = (await c.req.raw.json().catch(() => ({}))) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = typeof body.role === "string" ? body.role : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !STAFF_ROLE_SET.has(role)) {
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          severity: "error",
          path: "POST /admin/api/staff/invitations",
          expected: `body.email is an address and body.role in [${[...STAFF_ROLE_SET].join(", ")}]`,
          message: "Invitation needs a valid `email` and a staff `role`.",
        }),
      }, { status: 400 });
    }
    const result = await auth.inviteUser(email, role as StaffRole);
    if (result.kind === "exists") {
      return Response.json({
        ok: false,
        userId: result.id,
        diagnostic: runtimeDiagnostic({
          code: "CONFLICT",
          severity: "error",
          path: "POST /admin/api/staff/invitations",
          expected: "an email without an existing user row",
          message:
            "That email already has an account — adjust its role in the staff list instead.",
        }),
      }, { status: 409 });
    }
    return Response.json({ ok: true, userId: result.id });
  });

  roleGuarded("delete", "/admin/api/staff/invitations/:id", "owner", async (c) => {
    const revoked = await auth.revokeInvite(c.req.param("id") ?? "");
    if (!revoked) {
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "CONFLICT",
          severity: "error",
          path: "DELETE /admin/api/staff/invitations/:id",
          expected: "an invitation nobody has signed in to",
          message:
            "Only never-signed-in invitations can be revoked. For an active user, clear the role instead.",
        }),
      }, { status: 409 });
    }
    return Response.json({ ok: true });
  });

  guarded("get", "/admin/api/collections", () => Response.json({ collections }));

  guarded("get", "/admin/api/views-manifest", () => Response.json({ views: viewsManifest }));

  // Staff Views (#433): mounted behind the staff gate at
  // `/admin/api/views/<name>` — NOT on the public `/api/views/<name>`
  // path (the public mount loop skips `surface: staff`). Reuses the
  // exact same `handleViewRequest` logic and response shape as the
  // public surface; only the gate + path differ.
  for (const v of staffViews) {
    const viewName = v.metadata.name;
    guarded("get", `/admin/api/views/${viewName}`, async (c) => {
      const runtime = await ref.get();
      const waitUntil = readWaitUntil(c);
      return handleViewRequest(
        c.req.raw,
        runtime,
        viewName,
        ref,
        c.env,
        waitUntil,
        "/admin/api/views",
      );
    });
  }

  guarded("get", "/admin/api/operations", (c, gate) =>
    Response.json({
      operations: operations.filter((op) =>
        evaluateAuthAll(
          op.procedure.spec.requires,
          adminHandlerContext(c, gate),
          `GET /admin/api/operations/${op.name}`,
          "runtime",
        ) === null
      ).map((op) => ({
        name: op.name,
        title: op.title,
        description: op.description,
        input: op.input,
        triggers: op.triggers,
        rowBindings: op.rowBindings,
      })),
    }),
  );

  guarded("post", "/admin/api/operations/:name", async (c, gate) => {
    const name = c.req.param("name") ?? "";
    const op = operationsByName.get(name);
    if (!op) {
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "NOT_FOUND",
          severity: "error",
          path: `POST /admin/api/operations/${name}`,
          expected: "a staff-operable Procedure name from GET /admin/api/operations",
          message: `No staff-operable operation named '${name}'.`,
        }),
      }, { status: 404 });
    }
    return runMantleUseCase(`POST /admin/api/operations/${name}`, async () => {
      const runtime = await ref.get();
      const input = (await c.req.raw.json().catch(() => ({}))) as unknown;
      // Reuse the exact use case the staff MCP surface invokes
      // Procedures through (`McpJsonRpcDispatcher.dispatchToolByName`
      // → `runtime.invokeProcedure.execute`) — same auth evaluation,
      // same input/output validation, same handler dispatch. The
      // staff HandlerContext below mirrors the MCP dispatcher's
      // `procCtx` construction 1:1.
      const result = await runtime.invokeProcedure.execute({
        procedure: op.procedure,
        input: objectField(input),
        ctx: adminHandlerContext(c, gate),
        pathPrefix: `POST /admin/api/operations/${name}`,
      });
      if (!result.ok) {
        throw new DiagnosticError(result.diagnostic);
      }
      return { ok: true, output: result.data };
    });
  });

  guarded("get", "/admin/api/site", async (c) => {
    const runtime = await ref.get();
    const site = await runtime.siteConfig.load();
    const url = new URL(c.req.url);
    return Response.json({
      ...site,
      publicUrl: site.origin || url.origin,
      mcpUrl: `${url.origin}/mcp/staff`,
    });
  });

  roleGuarded("get", "/admin/api/site-settings", "owner", async () =>
    runMantleUseCase("GET /admin/api/site-settings", async () => {
      const runtime = await ref.get();
      return adminSiteSettings(await runtime.siteConfig.load());
    }),
  );

  roleGuarded("patch", "/admin/api/site-settings", "owner", async (c) =>
    runMantleUseCase("PATCH /admin/api/site-settings", async () => {
      const runtime = await ref.get();
      const body = (await c.req.raw.json().catch(() => ({}))) as Record<string, unknown>;
      const site = await runtime.updateSiteSettings.execute({
        brand: stringField(body.brand),
        title: stringField(body.title),
        description: stringField(body.description),
        ga4MeasurementId: stringField(body.ga4MeasurementId),
        facebookPixelId: stringField(body.facebookPixelId),
      });
      return adminSiteSettings(site);
    }),
  );

  guarded("get", "/admin/api/entries", async (c) => {
    const collection = c.req.query("collection");
    if (!collection) {
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          severity: "error",
          path: "GET /admin/api/entries",
          expected: "?collection=<name> query parameter",
          message: "Missing `collection` query parameter.",
        }),
      }, { status: 400 });
    }
    const runtime = await ref.get();
    const rawLimit = c.req.query("limit");
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : NaN;
    const statusQuery = c.req.query("status");
    const sortDirection = c.req.query("direction") === "asc" ? "asc" : "desc";
    const filterField = c.req.query("filter_field");
    const filterValue = c.req.query("filter_value");
    if (Boolean(filterField) !== Boolean(filterValue)) {
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          severity: "error",
          path: "GET /admin/api/entries",
          expected: "filter_field and filter_value together",
          message: "List filters require both `filter_field` and `filter_value`.",
        }),
      }, { status: 400 });
    }
    // Admin pagination needs the cursored shape — `executePage` returns
    // `{ rows, nextCursor? }`. `execute()` is the flat-array variant
    // for app code.
    const result = await runtime.listEntries.executePage({
      collection,
      status: statusQuery && statusQuery !== "all" ? (statusQuery as ContentState) : undefined,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 99,
      cursor: c.req.query("cursor") ?? undefined,
      cursorDirection: c.req.query("cursor_direction") === "backward" ? "backward" : "forward",
      search: c.req.query("search") || undefined,
      filter: filterField && filterValue
        ? { field: filterField, value: filterValue }
        : undefined,
      sort: {
        field: c.req.query("sort") || "updatedAt",
        direction: sortDirection,
      },
    });
    const items = result.rows.map((row) => adminListItem(row, schemasByName));
    return Response.json({
      items,
      previous_cursor: result.previousCursor ?? null,
      next_cursor: result.nextCursor ?? null,
    });
  });

  guarded("get", "/admin/api/entries/export", async (c) => {
    const collection = c.req.query("collection");
    const schema = collection ? schemasByName.get(collection) : undefined;
    if (!collection || !schema) {
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "NOT_FOUND",
          severity: "error",
          path: "GET /admin/api/entries/export",
          expected: "?collection=<name> naming a declared Schema",
          message: collection
            ? `Schema '${collection}' was not found.`
            : "Missing `collection` query parameter.",
        }),
      }, { status: 404 });
    }
    const runtime = await ref.get();
    const propertyNames = Object.keys(schema.spec.schema.properties ?? {});
    const columns = ["id", "status", "version", "updated_at", ...propertyNames];
    const lines = [csvRow(columns)];
    let cursor: string | undefined;
    do {
      const page = await runtime.listEntries.executePage({ collection, cursor });
      for (const row of page.rows) {
        lines.push(
          csvRow(
            columns.map((column) => csvValue(column, row, propertyNames)),
          ),
        );
      }
      cursor = page.nextCursor;
    } while (cursor);
    const csv = "﻿" + lines.join("\r\n") + "\r\n";
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${collection}.csv"`,
      },
    });
  });

  guarded("get", "/admin/api/entries/:id", async (c) =>
    runMantleUseCase(`GET /admin/api/entries/${c.req.param("id")}`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const row = await runtime.getEntry.execute({ id });
      return entryEditorPayload(runtime, row, schemas);
    }),
  );

  guarded("post", "/admin/api/entries", async (c, gate) =>
    runMantleUseCase("POST /admin/api/entries", async () => {
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
      if (
        gate.role === "contributor" &&
        (schemasByName.get(body.collection)?.spec.lifecycle ?? "publishing") === "operational"
      ) {
        throw new DiagnosticError(adminRoleDiagnostic(
          "POST /admin/api/entries",
          "editor",
          "Contributors can create drafts, not operational records.",
        ));
      }
      const row = await runtime.createDraft.execute({
        collection: body.collection,
        data: objectField(body.data),
        authorId: gate.userId,
        ctx: adminHandlerContext(c, gate),
        originalInput: body,
      });
      return entryEditorPayload(runtime, row, schemas);
    }),
  );

  guarded("patch", "/admin/api/entries/:id", async (c, gate) =>
    runMantleUseCase(`PATCH /admin/api/entries/${c.req.param("id")}`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      if (gate.role === "contributor") {
        const current = await runtime.getEntry.execute({ id });
        const lifecycle = schemasByName.get(current.collection)?.spec.lifecycle ?? "publishing";
        if (lifecycle === "operational" || current.status !== "draft") {
          throw new DiagnosticError(adminRoleDiagnostic(
            `PATCH /admin/api/entries/${id}`,
            "editor",
            "Contributors can edit drafts only.",
          ));
        }
      }
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
      return entryEditorPayload(runtime, updated, schemas);
    }),
  );

  roleGuarded("post", "/admin/api/entries/:id/publish", "editor", async (c, gate) =>
    runMantleUseCase(`POST /admin/api/entries/${c.req.param("id")}/publish`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const body = await c.req.raw.json().catch(() => ({}));
      const row = await runtime.requestPublish.execute({
        id,
        ctx: adminHandlerContext(c, gate),
        originalInput: body,
      });
      return entryEditorPayload(runtime, row, schemas);
    }),
  );

  roleGuarded("post", "/admin/api/entries/:id/unpublish", "editor", async (c, gate) =>
    runMantleUseCase(`POST /admin/api/entries/${c.req.param("id")}/unpublish`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const body = await c.req.raw.json().catch(() => ({}));
      const row = await runtime.unpublish.execute({
        id,
        ctx: adminHandlerContext(c, gate),
        originalInput: body,
      });
      return entryEditorPayload(runtime, row, schemas);
    }),
  );

  roleGuarded("delete", "/admin/api/entries/:id", "editor", async (c, gate) =>
    runMantleUseCase(`DELETE /admin/api/entries/${c.req.param("id")}`, async () => {
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

  roleGuarded("post", MEDIA_UPLOADS_PATH, "editor", async (c) => {
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
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          severity: "error",
          path: `POST ${MEDIA_UPLOADS_PATH}`,
          expected:
            "{ filename: string, purpose: string, variants: [{ mimeType, byteSize, role }, ...] }",
        }),
      }, { status: 400 });
    }
    const variants: Array<{ mimeType: string; byteSize: number; role: "primary" | "alternate" | "fallback" }> = [];
    for (const raw of body.variants) {
      if (raw === null || typeof raw !== "object") {
        return Response.json({
          ok: false,
          diagnostic: runtimeDiagnostic({
            code: "INPUT_VALIDATION_FAILED",
            severity: "error",
            path: `POST ${MEDIA_UPLOADS_PATH}`,
            expected: "variants[] entries are objects with { mimeType, byteSize, role }",
          }),
        }, { status: 400 });
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
        return Response.json({
          ok: false,
          diagnostic: runtimeDiagnostic({
            code: "INPUT_VALIDATION_FAILED",
            severity: "error",
            path: `POST ${MEDIA_UPLOADS_PATH}`,
            expected:
              "each variant: { mimeType: string, byteSize: positive integer, role: 'primary'|'alternate'|'fallback' }",
          }),
        }, { status: 400 });
      }
      variants.push({ mimeType, byteSize, role });
    }
    const { filename, purpose } = body;
    return runMantleUseCase(`POST ${MEDIA_UPLOADS_PATH}`, () =>
      media.createUpload.execute({
        filename,
        purpose,
        variants,
        alt: typeof body.alt === "string" ? body.alt : undefined,
        caption: typeof body.caption === "string" ? body.caption : undefined,
      }),
    );
  });

  roleGuarded("post", MEDIA_COMMIT_PATH, "editor", async (c) => {
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
    return runMantleUseCase(`POST ${MEDIA_COMMIT_PATH}`, () =>
      media.commitUpload.execute({
        uploadGroupId,
        alt: typeof body.alt === "string" ? body.alt : undefined,
        caption: typeof body.caption === "string" ? body.caption : undefined,
      }),
    );
  });

  // Media library (#434): list / get / patch / delete over committed
  // assets. All staff-gated; all 501 + MEDIA_NOT_CONFIGURED when no
  // `mediaStorage` is bound (mirrors the upload handlers above).
  const MEDIA_LIST_PATH = "/admin/api/media";
  const MEDIA_ASSET_PATH = "/admin/api/media/:id";

  roleGuarded("get", MEDIA_LIST_PATH, "editor", async (c) => {
    const runtime = await ref.get();
    const media = runtime.media;
    if (!media) return mediaNotConfiguredResponse(`GET ${MEDIA_LIST_PATH}`);
    const rawLimit = c.req.query("limit");
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : NaN;
    return runMantleUseCase(`GET ${MEDIA_LIST_PATH}`, async () => {
      const result = await media.listAssets.execute({
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
        cursor: c.req.query("cursor") ?? undefined,
        search: c.req.query("search") || undefined,
      });
      return {
        items: result.rows.map(adminMediaItem),
        next_cursor: result.nextCursor ?? null,
      };
    });
  });

  roleGuarded("get", MEDIA_ASSET_PATH, "editor", async (c) => {
    const runtime = await ref.get();
    const media = runtime.media;
    if (!media) return mediaNotConfiguredResponse(`GET ${MEDIA_ASSET_PATH}`);
    const id = c.req.param("id")!;
    return runMantleUseCase(`GET ${MEDIA_ASSET_PATH}`, async () =>
      adminMediaItem(await media.getAsset.execute(id)),
    );
  });

  roleGuarded("patch", MEDIA_ASSET_PATH, "editor", async (c) => {
    const runtime = await ref.get();
    const media = runtime.media;
    if (!media) return mediaNotConfiguredResponse(`PATCH ${MEDIA_ASSET_PATH}`);
    const id = c.req.param("id")!;
    const body = (await c.req.raw.json().catch(() => ({}))) as {
      alt?: unknown;
      caption?: unknown;
    };
    if (
      (body.alt !== undefined && typeof body.alt !== "string") ||
      (body.caption !== undefined && typeof body.caption !== "string")
    ) {
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          severity: "error",
          path: `PATCH ${MEDIA_ASSET_PATH}`,
          expected: "{ alt?: string, caption?: string }",
          message: "`alt` and `caption` must be strings when present.",
        }),
      }, { status: 400 });
    }
    return runMantleUseCase(`PATCH ${MEDIA_ASSET_PATH}`, async () =>
      adminMediaItem(
        await media.updateAsset.execute({
          id,
          alt: typeof body.alt === "string" ? body.alt : undefined,
          caption: typeof body.caption === "string" ? body.caption : undefined,
        }),
      ),
    );
  });

  roleGuarded("delete", MEDIA_ASSET_PATH, "editor", async (c) => {
    const runtime = await ref.get();
    const media = runtime.media;
    if (!media) return mediaNotConfiguredResponse(`DELETE ${MEDIA_ASSET_PATH}`);
    const id = c.req.param("id")!;
    return runMantleUseCase(`DELETE ${MEDIA_ASSET_PATH}`, () => media.deleteAsset.execute(id));
  });
}

/** Shape a committed `MediaAsset` for the admin media library wire
 *  surface (#434): the full variants set plus a convenience
 *  `primaryUrl` / `mime` / `byteSize` lifted off the primary variant so
 *  the SPA grid can render a thumbnail without re-deriving it. */
function adminMediaItem(asset: MediaAsset): {
  id: string;
  variants: MediaAsset["variants"];
  primaryUrl: string | null;
  mime: string | null;
  byteSize: number | null;
  alt: string | null;
  caption: string | null;
  createdAt: number;
} {
  const primary = asset.variants.find((v) => v.role === "primary") ?? asset.variants[0] ?? null;
  return {
    id: asset.id,
    variants: asset.variants,
    primaryUrl: primary?.publicUrl ?? null,
    mime: primary?.mimeType ?? null,
    byteSize: primary?.byteSize ?? null,
    alt: asset.alt ?? null,
    caption: asset.caption ?? null,
    createdAt: asset.createdAt,
  };
}

type StaffOperationRowBinding = {
  readonly collection: string;
  readonly inputField: string;
  readonly rowField: string;
};

type StaffOperation = {
  readonly name: string;
  readonly title: LocalizedText | null;
  readonly description: LocalizedText | null;
  readonly input: JsonSchema;
  readonly triggers: ReadonlyArray<"mcp" | "http">;
  readonly rowBindings: ReadonlyArray<StaffOperationRowBinding>;
  readonly procedure: ProcedureManifest;
};

/**
 * Derivation rule (#426, manifest-only, no new grammar): a Procedure
 * is staff-operable iff some Trigger targets it with either
 *   (a) `source.kind: "mcp"` and `source.surface === "staff"` — the
 *       exact predicate `collectMcpProcedures` in `mountMcp.ts` uses
 *       to build the `/mcp/staff` tool catalog, or
 *   (b) `source.kind: "http"` AND the procedure's `spec.requires?.auth`
 *       predicates include a `ctx.staff` entry.
 *
 * `triggers` on the result lists every distinct kind ("mcp" | "http")
 * that qualified the procedure, in Trigger declaration order,
 * deduplicated — a Procedure can be both an MCP staff tool and an
 * HTTP Trigger simultaneously.
 *
 * `title`/`description` (#430) are raw passthroughs of
 * `Procedure.spec.title`/`.description` — this REPLACES the pre-#430
 * hack of reading `procedure.spec.input.description` as a fake
 * "description". The wire shape (`string | LocalizedText | null`)
 * stays compatible for plain-string manifests since a string
 * title/description round-trips as a string; the SPA resolves
 * locale-map values client-side.
 */
function discoverStaffOperations(
  manifests: readonly Manifest[],
  schemasByName: ReadonlyMap<string, SchemaManifest>,
): readonly StaffOperation[] {
  const procedures = new Map<string, ProcedureManifest>();
  for (const m of manifests) {
    if (m.kind === "Procedure") procedures.set(m.metadata.name, m);
  }
  const triggerKindsByProcedure = new Map<string, Set<"mcp" | "http">>();
  for (const m of manifests) {
    if (m.kind !== "Trigger") continue;
    const source = m.spec.source;
    const procedureName = m.spec.target.procedure;
    const procedure = procedures.get(procedureName);
    if (!procedure) continue;

    const isStaffMcp = source.kind === "mcp" && source.surface === "staff";
    const isStaffHttp = source.kind === "http" && hasCtxStaffPredicate(procedure);
    if (!isStaffMcp && !isStaffHttp) continue;

    const kind: "mcp" | "http" = source.kind === "mcp" ? "mcp" : "http";
    const set = triggerKindsByProcedure.get(procedureName) ?? new Set();
    set.add(kind);
    triggerKindsByProcedure.set(procedureName, set);
  }

  const out: StaffOperation[] = [];
  for (const [name, kinds] of triggerKindsByProcedure) {
    const procedure = procedures.get(name);
    if (!procedure) continue;
    out.push({
      name,
      title: procedure.spec.title ?? null,
      description: procedure.spec.description ?? null,
      input: procedure.spec.input,
      triggers: [...kinds],
      rowBindings: discoverRowBindings(procedure, schemasByName),
      procedure,
    });
  }
  return out;
}

/**
 * Row-action bindings (#430): which `x-mantle-ref` input properties on
 * a staff-operable Procedure point at a real, non-"translates"
 * collection, so the admin SPA can offer this operation from a row's
 * "⋯" menu on that collection's table (with the ref field pre-filled
 * and read-only).
 *
 * Skip conditions (no binding produced, no error):
 *   - `input.type !== "object"` or `input.properties` absent — nothing
 *     to walk.
 *   - the `x-mantle-ref` target name isn't in `schemasByName` (unknown
 *     collection).
 *   - the target Schema has `spec.translates` set (it's a translation
 *     child, not a real top-level collection).
 *
 * `rowField` derivation: if the target Schema's `spec.uniqueIndexes`
 * has EXACTLY one entry and that entry names EXACTLY one field, use
 * that field name (e.g. `sku`). In every other case (no unique
 * indexes, more than one, or a composite/multi-field index) fall back
 * to the reserved `id` column.
 */
function discoverRowBindings(
  procedure: ProcedureManifest,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
): StaffOperationRowBinding[] {
  const input = procedure.spec.input;
  const inputTypes = Array.isArray(input.type) ? input.type : input.type ? [input.type] : [];
  if (input.type !== undefined && !inputTypes.includes("object")) return [];
  const properties = input.properties;
  if (!properties) return [];

  const bindings: StaffOperationRowBinding[] = [];
  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    const refTarget = propertySchema[MANTLE_REF_KEYWORD];
    if (typeof refTarget !== "string" || refTarget.length === 0) continue;
    const targetSchema = schemasByName.get(refTarget);
    if (!targetSchema) continue;
    if (targetSchema.spec.translates) continue;
    bindings.push({
      collection: refTarget,
      inputField: propertyName,
      // Same-name wins: when the target Schema declares a property
      // with the input field's own name (skuCode → product-skus.
      // skuCode, orderNumber → orders.orderNumber), that IS the value
      // the input wants — prefilling the entry id there would feed
      // the wrong value. Only refs with no same-name property fall
      // back to the single-field unique index and finally the
      // reserved id column (tierId-style inputs, where the id
      // genuinely is the value).
      rowField: sameNameField(propertyName, targetSchema)
        ?? singleUniqueIndexField(targetSchema)
        ?? "id",
    });
  }
  return bindings;
}

/** `inputField` itself, when the target Schema declares a property of
 *  that name; else `null`. */
function sameNameField(inputField: string, schema: SchemaManifest): string | null {
  const properties = schema.spec.schema.properties ?? {};
  return inputField in properties ? inputField : null;
}

/** The lone field name of a Schema's single-field unique index, or
 *  `null` when `uniqueIndexes` is absent, empty, has more than one
 *  entry, or its one entry is a composite (multi-field) index. */
function singleUniqueIndexField(schema: SchemaManifest): string | null {
  const uniqueIndexes = schema.spec.uniqueIndexes;
  if (!uniqueIndexes || uniqueIndexes.length !== 1) return null;
  const [onlyIndex] = uniqueIndexes;
  if (!onlyIndex || onlyIndex.length !== 1) return null;
  return onlyIndex[0] ?? null;
}

function hasCtxStaffPredicate(procedure: ProcedureManifest): boolean {
  const predicates = procedure.spec.requires?.auth?.all ?? [];
  return predicates.some((pred) => typeof pred === "object" && pred !== null && "ctx.staff" in pred);
}

function adminEntryTitle(data: Record<string, unknown>, schema?: JsonSchema): unknown {
  const key = titleFieldKey(data, schema);
  return key ? data[key] : null;
}

/** Which data key `adminEntryTitle` would read, or `null` if none
 *  matched. Split out from `adminEntryTitle` so `adminDataPreview` can
 *  skip the same property instead of repeating it in a data column. */
function titleFieldKey(data: Record<string, unknown>, schema?: JsonSchema): string | null {
  if (typeof data.title === "string" && data.title) return "title";
  if (typeof data.name === "string" && data.name) return "name";
  if (typeof data.slug === "string" && data.slug) return "slug";
  // Manifest-driven fallback: walk the schema's required properties in
  // declaration order and use the first string-typed one with a
  // non-empty value. Mirrors the admin SPA's `entryTitle` rule.
  if (schema) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      const fieldSchema = properties[key];
      if (!fieldSchema || !isStringTypedSchema(fieldSchema)) continue;
      const value = data[key];
      if (typeof value === "string" && value) return key;
    }
  }
  return null;
}

/** Schema property names that collide in MEANING with a system column
 *  the admin list already renders unconditionally (the "updated"
 *  column reads the reserved `updatedAt` storage column, formatted as
 *  `row.updated_at`). A schema-declared `required` property with one
 *  of these exact names would otherwise show up a SECOND time as a
 *  raw data-preview column — same value, no title-cased header — right
 *  next to the system column (#443). NAME-based only, on purpose: no
 *  fuzzy/semantic matching, just these two well-known reserved names. */
const DATA_PREVIEW_SYSTEM_COLUMN_NAMES = new Set(["updatedAt", "createdAt"]);

/** Operational collections have no title/status
 *  workflow worth a dedicated column — instead the admin list shows up
 *  to 3 raw data columns. Mirrors the client-side column-picking rule
 *  in `collection-view.tsx`: first 3 `required` properties, skipping
 *  the schema-stable title field and the system-column-name collisions
 *  above (#443). Kept small on the wire on purpose — this is a
 *  preview, not the full entry. */
function adminDataPreview(
  data: Record<string, unknown>,
  manifest?: SchemaManifest,
): Record<string, unknown> | undefined {
  if (!manifest || manifest.spec.lifecycle !== "operational") return undefined;
  const schema = manifest.spec.schema;
  // Schema-stable skip (not per-row): rows with a blank title field
  // must still produce the same columns as every other row, or the
  // client's fixed headers drift out of sync with the values.
  const titleKey = schemaTitleKey(schema);
  const fields = (schema.required ?? [])
    .filter((key) => key !== titleKey && !DATA_PREVIEW_SYSTEM_COLUMN_NAMES.has(key))
    .slice(0, 3);
  if (fields.length === 0) return undefined;
  const preview: Record<string, unknown> = {};
  for (const key of fields) preview[key] = data[key];
  return preview;
}

/** The property a row's title comes from, derived from the SCHEMA
 *  alone (no row data): literal `title`/`name`/`slug` when declared,
 *  else the first required string-typed property. Stable across all
 *  rows of a collection, so preview columns never vary per row. */
function schemaTitleKey(schema: JsonSchema): string | null {
  const properties = schema.properties ?? {};
  for (const key of ["title", "name", "slug"]) {
    if (key in properties) return key;
  }
  for (const key of schema.required ?? []) {
    const fieldSchema = properties[key];
    if (fieldSchema && isStringTypedSchema(fieldSchema)) return key;
  }
  return null;
}

function isStringTypedSchema(schema: JsonSchema): boolean {
  const rawType = schema.type;
  const types = Array.isArray(rawType) ? rawType : rawType ? [rawType] : [];
  return types.includes("string");
}

function adminListItem(
  row: AdminEntryRow,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
): {
  id: string;
  collection: string;
  locale: string | null;
  status: string;
  version: number;
  title: unknown;
  updated_at: number;
  data_preview?: Record<string, unknown>;
} {
  const manifest = schemasByName.get(row.collection);
  return {
    id: row.id,
    collection: row.collection,
    locale: row.locale ?? null,
    status: row.status,
    version: row.version,
    title: adminEntryTitle(row.data, manifest?.spec.schema),
    updated_at: row.updatedAt,
    data_preview: adminDataPreview(row.data, manifest),
  };
}

/** RFC 4180 field quoting: quote whenever the value contains a comma,
 *  quote, or newline; escape embedded quotes by doubling them. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(",");
}

/** Reads one CSV column's value off an entry row. The four leading
 *  columns are row metadata; everything else is a Schema property
 *  read from `data`. Non-scalar values (objects, arrays) are
 *  JSON-stringified. */
function csvValue(
  column: string,
  row: AdminEntryRow,
  propertyNames: readonly string[],
): string {
  if (column === "id") return row.id;
  if (column === "status") return row.status;
  if (column === "version") return String(row.version);
  if (column === "updated_at") return String(row.updatedAt);
  if (!propertyNames.includes(column)) return "";
  const value = row.data[column];
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
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
  readonly title: LocalizedText;
  readonly description: LocalizedText | null;
  readonly lifecycle: "publishing" | "editorial" | "operational";
  readonly parent: {
    readonly collection: string;
    readonly parentField: string;
    readonly childField: string;
  } | null;
  readonly hasTranslations: boolean;
  readonly localized: boolean;
  readonly translates: SchemaManifest["spec"]["translates"] | null;
  readonly schema: JsonSchema;
  readonly uiSchema: Record<string, unknown> | null;
  readonly mediaFields: Array<{ name: string; hint: string }>;
  readonly sortableFields: readonly string[];
  readonly filter: { readonly field: string; readonly values: readonly string[] } | null;
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
    lifecycle: schema.spec.lifecycle ?? "publishing",
    parent: collectionParentFor(schema, schemas),
    hasTranslations: schemas.some((candidate) => candidate.spec.translates?.parent === schema.metadata.name),
    localized: schema.spec.localized ?? Boolean(schema.spec.translates),
    translates: schema.spec.translates ?? null,
    schema: schema.spec.schema,
    uiSchema: schema.spec.uiSchema ?? null,
    mediaFields: mediaFieldsForCollection(schema, schemas),
    sortableFields: [...new Set([
      ...(schema.spec.uniqueIndexes ?? []).flat(),
      ...(schema.spec.indexes ?? []).flat(),
    ])].filter((field) => (schema.spec.schema.required ?? []).includes(field)),
    filter: checkSchemaListFilter(schema).filter,
  };
}

function adminEditorEntry(row: Entry): AdminEditorEntry {
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
  const relationships: DiscoveredRelationship[] = [];
  const seen = new Set<string>();
  const add = (
    childSchema: SchemaManifest,
    kind: "translation" | "field",
    parentField: string,
    childField: string,
    rawParentValue: unknown,
  ): void => {
    const parentValue = primitiveJoinValue(rawParentValue);
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
      add(
        childSchema,
        "translation",
        translates.on,
        translates.on,
        parentRow.data[translates.on],
      );
      continue;
    }

    for (const [childField, childProperty] of Object.entries(childProps)) {
      if (childProperty[MANTLE_REF_KEYWORD] === parentName) {
        add(childSchema, "field", "id", childField, parentRow.id);
      }
    }
  }

  return relationships;
}

function collectionParentFor(
  childSchema: SchemaManifest,
  schemas: SchemaManifest[],
): { collection: string; parentField: string; childField: string } | null {
  if (childSchema.spec.translates) {
    return {
      collection: childSchema.spec.translates.parent,
      parentField: childSchema.spec.translates.on,
      childField: childSchema.spec.translates.on,
    };
  }

  const childProps = childSchema.spec.schema.properties ?? {};
  // Required ref = composition (the child can't exist without its
  // parent, so it's buried under the parent in the sidebar). Optional
  // ref = weak reference — the collection stays top-level.
  const childRequired = new Set(childSchema.spec.schema.required ?? []);
  const schemaNames = new Set(
    schemas
      .filter((schema) => !schema.spec.translates)
      .map((schema) => schema.metadata.name),
  );
  for (const [childField, childProperty] of Object.entries(childProps)) {
    if (!childRequired.has(childField)) continue;
    const parent = childProperty[MANTLE_REF_KEYWORD];
    if (typeof parent === "string" && schemaNames.has(parent)) {
      return { collection: parent, parentField: "id", childField };
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

async function entriesByDataValue(
  runtime: CmsRuntime,
  collection: string,
  field: string,
  value: string | number | boolean,
): Promise<readonly Entry[]> {
  return runtime.entryReader.findManyByDataField({
    collection,
    field,
    value,
    limit: 50,
  });
}

function adminSiteSettings(site: SiteConfig) {
  return {
    ...site,
    ga4MeasurementId: site.ga4MeasurementId ?? "",
    facebookPixelId: site.facebookPixelId ?? "",
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
      image: string | null;
      role: StaffRole;
      sessionId: string;
    };

function adminHandlerContext(c: Context, gate: Extract<StaffGate, { kind: "ok" }>): HandlerContext {
  const waitUntil = readWaitUntil(c);
  return {
    user: { id: gate.userId },
    staff: { id: gate.userId, role: gate.role },
    auth: {
      credential: "session",
      credentialId: gate.sessionId,
      clientId: null,
      scopes: [],
    },
    env: c.env ?? {},
    ...(waitUntil ? { waitUntil } : {}),
  };
}

async function readStaffGate(c: Context, auth: Auth): Promise<StaffGate> {
  const session = await auth.getSession(c.req.raw);
  if (!session) return { kind: "unauth" };
  const role = await resolveUserRole(auth, session.user.id, session.user.role);
  const login = session.user.githubLogin ?? null;
  if (!role || !STAFF_ROLE_SET.has(role)) {
    return { kind: "forbidden", login };
  }
  return {
    kind: "ok",
    userId: session.user.id,
    login,
    image: session.user.image ?? null,
    role: role as StaffRole,
    sessionId: session.session.id,
  };
}

async function handleHttpTrigger(
  req: Request,
  runtime: CmsRuntime,
  ref: CmsRuntimeRef,
  triggerName: string,
  triggerPath: string,
  pathParams: Readonly<Record<string, string>>,
  env: unknown,
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

  const triggerPathPrefix = `${req.method} ${triggerPath}`;
  const caller = await resolveCaller(req, {
    auth: ref.auth,
    credentialResolver: ref.credentialResolver,
    jwtBearer: ref.jwtBearer,
    env,
    waitUntil,
  });
  if (caller.kind === "invalid") {
    return Response.json(
      { ok: false, diagnostic: caller.diagnostic },
      { status: caller.status },
    );
  }
  if (caller.context.auth?.credential === "session") {
    const rejected = rejectCrossOriginMutation(req);
    if (rejected) return rejected;
  }

  const body = await readBody(req);
  // Spread order matters: URL path params are authoritative for the
  // resource identifier (a `DELETE /entries/{id}` body MUST NOT spoof
  // `id`). Body fields fill in non-path inputs only.
  const input = { ...body, ...pathParams };

  const result = await runtime.invokeProcedure.execute({
    procedure,
    input,
    ctx: caller.context,
    pathPrefix: triggerPathPrefix,
  });

  if (result.ok) {
    return Response.json({ ok: true, data: result.data });
  }
  const status = HTTP_STATUS_BY_CODE[result.diagnostic.code] ?? 500;
  // Redact before egress: use-case diagnostics (e.g. HANDLER_NOT_REGISTERED,
  // or an EntryWriteGuard diagnostic from a builtin create/update Procedure)
  // can carry `candidates` listing internal handler/schema names. The wire
  // contract (ADR-0008, runUseCase, diagnosticResponse) strips those. (#396)
  return Response.json(
    { ok: false, diagnostic: redactForWire(result.diagnostic) },
    { status },
  );
}

async function handleViewRequest(
  req: Request,
  runtime: CmsRuntime,
  viewName: string,
  ref: CmsRuntimeRef,
  env: unknown,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  // Mount prefix for this View's route. Passed by the caller because
  // the same handler serves BOTH the public mount (`/api/views`) and
  // the staff mount (`/admin/api/views`); hardcoding the public prefix
  // here mislabels staff-View diagnostics + pathPrefix (#F7).
  mountPath: string,
): Promise<Response> {
  const view = runtime.viewsByName.get(viewName);
  if (!view) {
    return jsonError({ status: 500, code: "INTERNAL_ERROR", message: `View '${viewName}' missing post-boot.` });
  }

  const viewPath = `GET ${mountPath}/${viewName}`;

  // Resolve the caller once. Static auth normally runs in the runtime;
  // malformed query params take the catch path below, which performs
  // the same check before returning a schema-revealing 400.
  const caller = await resolveCaller(req, {
    auth: ref.auth,
    credentialResolver: ref.credentialResolver,
    jwtBearer: ref.jwtBearer,
    env,
    waitUntil,
  });
  if (caller.kind === "invalid") {
    return Response.json(
      { ok: false, diagnostic: caller.diagnostic },
      { status: caller.status },
    );
  }
  const ctx = caller.context;

  const url = new URL(req.url);
  const page = parsePositiveInt(url.searchParams.get(PAGE_PARAM));
  const show = parsePositiveInt(url.searchParams.get(SHOW_PARAM));

  let params: Record<string, unknown>;
  try {
    params = coerceViewParams(view, url.searchParams);
  } catch (err) {
    if (err instanceof ViewParamCoercionError) {
      if (view.spec.requires?.auth) {
        const denial = evaluateAuthAll(view.spec.requires, ctx, viewPath, "runtime");
        if (denial) {
          return Response.json(
            { ok: false, diagnostic: denial },
            { status: HTTP_STATUS_BY_CODE[denial.code] ?? 403 },
          );
        }
      }
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          severity: "error",
          path: viewPath,
          expected: "query string conforms to View.spec.params",
          message: err.message,
        }),
      }, { status: 400 });
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
    return Response.json({ ok: true, data: result.result });
  }
  const status = HTTP_STATUS_BY_CODE[result.diagnostic.code] ?? 500;
  // Same wire-redaction contract as the HTTP Trigger egress above (#396).
  return Response.json(
    { ok: false, diagnostic: redactForWire(result.diagnostic) },
    { status },
  );
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
  return Response.json({
    ok: false,
    diagnostic: runtimeDiagnostic({
      code: "UNAUTHENTICATED",
      severity: "error",
      path: `${c.req.method} ${path}`,
      expected: "active session cookie",
      message: "Not signed in. Sign in via /admin/sign-in first.",
    }),
  }, { status: 401 });
}

// Distinct from UNAUTHENTICATED so the SPA can render an "access
// denied" view for users who DID sign in but lack a staff row,
// instead of bouncing them back to /admin/sign-in (which the OAuth
// re-auth then silently fast-forwards through, producing a visible
// 5-step redirect chain that looks like an infinite loop).
function adminInsufficientRole(
  c: Context,
  path: string,
  minimumRole: StaffRole,
): Response {
  const diagnostic = adminRoleDiagnostic(
    `${c.req.method} ${path}`,
    minimumRole,
    `This action requires the ${minimumRole} role.`,
  );
  return Response.json({
    ok: false,
    diagnostic,
  }, { status: 403 });
}

function adminRoleDiagnostic(
  path: string,
  minimumRole: StaffRole,
  message: string,
): Diagnostic {
  return runtimeDiagnostic({
    code: "AUTH_DENIED",
    severity: "error",
    path,
    expected: `${minimumRole} role or higher for the signed-in user`,
    message,
  });
}

function adminNotStaff(c: Context, path: string, login: string | null): Response {
  return Response.json({
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
  }, { status: 403 });
}

function jsonError(args: { status: number; code: string; message: string }): Response {
  const diagnostic: Partial<Diagnostic> = {
    code: args.code as Diagnostic["code"],
    severity: "error",
    phase: "runtime",
    path: "mount/http",
    message: args.message,
  };
  return Response.json({ ok: false, diagnostic }, { status: args.status });
}

function mediaNotConfiguredResponse(path: string): Response {
  return Response.json({
    ok: false,
    diagnostic: runtimeDiagnostic({
      code: "MEDIA_NOT_CONFIGURED",
      severity: "error",
      path,
      message:
        "Media uploads are not enabled on this deployment. Bind a `mediaStorage` adapter in `createCmsRuntime` to enable.",
    }),
  }, { status: 501 });
}

export type { CmsRuntimeRef };
