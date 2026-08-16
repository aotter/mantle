import type { Context, Env, Hono } from "hono";
import {
  DiagnosticError,
  HTTP_STATUS_BY_CODE,
  MANTLE_REF_KEYWORD,
  MCP_HINT_KEYWORD,
  VIEW_PARAMS_RESERVED,
  isMediaMcpHint,
  httpStatusFor,
  meetsRole,
  redactForWire,
  runtimeDiagnostic,
  checkSchemaAdminUi,
  checkViewAdminUi,
  schemaSortableFields,
  STAFF_ROLES,
  type ContentState,
  type Diagnostic,
  type Entry,
  type JsonSchema,
  type LocalizedText,
  type ProcedureManifest,
  type SchemaManifest,
  type SiteConfig,
  type ViewManifest,
} from "@aotter/mantle-spec";
import {
  ViewParamCoercionError,
  coerceViewParams,
  evaluateAuthAll,
  type HandlerContext,
  type MantleRuntime,
  type MediaAsset,
  type RuntimePlan,
} from "@aotter/mantle-runtime";

export type MantleAdminRuntime = MantleRuntime & {
  readonly siteConfig: NonNullable<MantleRuntime["siteConfig"]>;
  readonly updateSiteSettings: NonNullable<MantleRuntime["updateSiteSettings"]>;
};

export type StaffRole = (typeof STAFF_ROLES)[number];
const STAFF_ROLE_SET: ReadonlySet<string> = new Set(STAFF_ROLES);

export interface AdminAssetServer {
  fetch(request: Request): Promise<Response | null>;
}

export type AdminAuthMethod =
  | { readonly kind: "email-otp" }
  | { readonly kind: "magic-link" }
  | { readonly kind: "social"; readonly provider: string }
  | { readonly kind: "oauth"; readonly providerId: string; readonly displayName?: string };

export interface AdminStaffUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string | null;
  readonly githubLogin: string | null;
  readonly emailVerified: boolean;
  readonly createdAt: Date;
}

export type AdminMember = Pick<
  AdminStaffUser,
  "id" | "email" | "name" | "emailVerified" | "createdAt"
>;

export interface AdminListMembersArgs {
  readonly search?: string;
  readonly cursor?: string;
  readonly cursorDirection?: "forward" | "backward";
  readonly limit: number;
}

export interface AdminMemberList {
  readonly items: readonly AdminMember[];
  readonly previousCursor: string | null;
  readonly nextCursor: string | null;
}

export interface AdminAuth {
  readonly basePath: string;
  readonly handler: (request: Request) => Promise<Response>;
  readonly methods: readonly AdminAuthMethod[];
  readonly getSession: (request: Request) => Promise<{
    session: { id: string };
    user: { id: string; image?: string | null; githubLogin?: string | null };
  } | null>;
  readonly getUserRole: (userId: string) => Promise<string | null>;
  readonly listUsers: () => Promise<readonly AdminStaffUser[]>;
  readonly listMembers: (args: AdminListMembersArgs) => Promise<AdminMemberList>;
  readonly setUserRole: (userId: string, role: StaffRole | null) => Promise<boolean>;
  readonly inviteUser: (
    email: string,
    role: StaffRole,
  ) => Promise<{ readonly kind: "created" | "exists"; readonly id: string }>;
  readonly revokeInvite: (userId: string) => Promise<boolean>;
}

export interface MantleAdminRef {
  get(): Promise<MantleAdminRuntime>;
  readonly plan: RuntimePlan;
  readonly auth: AdminAuth;
  readonly assets: AdminAssetServer;
  readonly requestContext?: (context: Context) => {
    readonly env?: unknown;
    readonly waitUntil?: (promise: Promise<unknown>) => void;
  };
}

const [PAGE_PARAM, SHOW_PARAM] = VIEW_PARAMS_RESERVED;
const MEMBER_CURSOR_PREFIX = "m:";

export function encodeMemberCursor(createdAt: string, id: string): string {
  return `${MEMBER_CURSOR_PREFIX}${encodeURIComponent(JSON.stringify([createdAt, id]))}`;
}

export function decodeMemberCursor(cursor: string): readonly [string, string] | null {
  if (!cursor.startsWith(MEMBER_CURSOR_PREFIX)) return null;
  try {
    const value = JSON.parse(decodeURIComponent(cursor.slice(MEMBER_CURSOR_PREFIX.length))) as unknown;
    return Array.isArray(value) && value.length === 2 &&
        typeof value[0] === "string" && !Number.isNaN(Date.parse(value[0])) &&
        typeof value[1] === "string" && value[1]
      ? [value[0], value[1]]
      : null;
  } catch {
    return null;
  }
}

/** Mount the optional Admin API, auth routes, and SPA assets. */
export function mountMantleAdmin<E extends Env>(
  app: Hono<E>,
  ref: MantleAdminRef,
): void {
  const auth = ref.auth;
  const authBasePath = auth.basePath;
  const spa = async (c: Context): Promise<Response> => {
    const asset = await ref.assets.fetch(
      new Request(new URL("/_mantle/admin/index.html", c.req.url)),
    );
    return asset ?? new Response(
      "Mantle Admin assets are missing; run `mantle generate` and configure the ASSETS binding.",
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  };

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
  // forwarder needed in this mount.

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
    "/admin/members",
    "/admin/ops",
    "/admin/views/:name",
  ]) {
    app.get(path, spa);
  }

  // Pre-derive the collections projection — `ref.plan` is
  // immutable post-boot, so the filter / Set / mediaFields work doesn't
  // need to repeat per request.
  const schemas = Object.values(ref.plan.schemas).map(({ manifest }) => manifest);
  const schemasByName = new Map(schemas.map((s) => [s.metadata.name, s]));
  const assertMutableSchema = (path: string, schema: SchemaManifest | undefined): void => {
    if (schema?.spec.schema.readOnly !== true) return;
    throw new DiagnosticError(runtimeDiagnostic({
      code: "CONFLICT",
      severity: "error",
      path,
      value: schema.metadata.name,
      expected: "a Schema without root readOnly: true",
      message: `Schema '${schema.metadata.name}' is read-only on generic authoring surfaces; use its declared Procedures.`,
    }));
  };
  const readMutableEntry = async (runtime: MantleAdminRuntime, id: string, path: string): Promise<Entry> => {
    const entry = await runtime.getEntry.execute({ id });
    assertMutableSchema(path, schemasByName.get(entry.collection));
    return entry;
  };
  const collections = schemas
    .filter((s) => !s.spec.translates)
    .map((s) => adminEditorCollection(s, schemas));

  // Staff-operable Procedures (#426, extended #430 with rowBindings):
  // precompute at mount, same as `collections` above — `ref.plan`
  // is immutable post-boot.
  const operations = discoverStaffOperations(ref.plan, schemasByName);
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
  // "precompute at mount from ref.plan, list on GET") and needs
  // no changes to the `SiteInfo` type or its query key.
  // Report-sidebar source (#433): ONLY `surface: staff` Views. Public
  // storefront Views explicitly marked public auto-mount on the public REST
  // path and must not appear in the admin report sidebar — listing
  // them was noise + broke on param-driven storefront Views (see #433).
  const staffViews = Object.values(ref.plan.views)
    .map(({ manifest }) => manifest)
    .filter((view) => view.spec.surface === "staff");
  const viewsManifest = staffViews.map((v) => ({
    name: v.metadata.name,
    title: v.spec.title ?? null,
    from: v.spec.from ?? null,
    params: v.spec.params ?? null,
    fields: v.spec.fields ?? null,
    list: checkViewAdminUi(v).list,
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

  roleGuarded("get", "/admin/api/members", "editor", async (c) => {
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    const cursor = c.req.query("cursor") || undefined;
    const search = c.req.query("search")?.trim() || undefined;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (cursor && !decodeMemberCursor(cursor)) || (search?.length ?? 0) > 200) {
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          severity: "error",
          path: "GET /admin/api/members",
          expected: "limit 1..100, a valid cursor, and search up to 200 characters",
          message: "Member list parameters are invalid.",
        }),
      }, { status: 400 });
    }
    const result = await auth.listMembers({
      limit,
      search,
      cursor,
      cursorDirection: c.req.query("cursor_direction") === "backward" ? "backward" : "forward",
    });
    return Response.json({
      items: result.items,
      previous_cursor: result.previousCursor,
      next_cursor: result.nextCursor,
    });
  });

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

  roleGuarded("post", "/admin/api/staff/invitations", "owner", async (c, gate) => {
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
      if (result.id === gate.userId) {
        return Response.json({
          ok: false,
          diagnostic: runtimeDiagnostic({
            code: "AUTH_DENIED",
            severity: "error",
            path: "POST /admin/api/staff/invitations",
            expected: "an email other than the caller's",
            message: "You cannot change your own role.",
          }),
        }, { status: 403 });
      }
      await auth.setUserRole(result.id, role as StaffRole);
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
    guarded("get", `/admin/api/views/${viewName}`, async (c, gate) => {
      const runtime = await ref.get();
      return handleViewRequest(
        c.req.raw,
        runtime,
        v,
        adminHandlerContext(c, gate, ref),
      );
    });
    guarded("get", `/admin/api/views/${viewName}/export`, async (c, gate) => {
      const runtime = await ref.get();
      return handleViewRequest(
        c.req.raw,
        runtime,
        v,
        adminHandlerContext(c, gate, ref),
        true,
      );
    });
  }

  guarded("get", "/admin/api/operations", (c, gate) =>
    Response.json({
      operations: operations.filter((op) =>
        evaluateAuthAll(
          op.procedure.spec.requires,
          adminHandlerContext(c, gate, ref),
          `GET /admin/api/operations/${op.name}`,
          "runtime",
        ) === null
      ).map((op) => ({
        name: op.name,
        title: op.title,
        description: op.description,
        input: op.input,
        uiSchema: op.uiSchema,
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
      // → `runtime.invokeProcedure`) — same auth evaluation,
      // same input/output validation, same handler dispatch. The
      // staff HandlerContext below mirrors the MCP dispatcher's
      // `procCtx` construction 1:1.
      const result = await runtime.invokeProcedure({
        procedure: op.procedure.metadata.name,
        input: objectField(input),
        ctx: adminHandlerContext(c, gate, ref),
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
    const { origin, ...site } = await runtime.siteConfig.load();
    const publicUrl = origin || new URL(c.req.url).origin;
    return Response.json({
      ...site,
      publicUrl,
      mcpUrl: `${publicUrl}/mcp/staff`,
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
    const translationLocales = new Map<string, Set<string>>();
    const translationSchemas = schemas.filter((schema) => schema.spec.translates?.parent === collection);
    for (const schema of translationSchemas) {
      const field = schema.spec.translates!.on;
      const parentValues = new Map<string, string | number | boolean>();
      for (const row of result.rows) {
        const value = primitiveJoinValue(row.data[field]);
        if (value !== null) parentValues.set(joinValueKey(value), value);
      }
      const translations = await runtime.entries.readByDataFieldIn({
        collection: schema.metadata.name,
        field,
        values: [...parentValues.values()],
      });
      const localesByValue = new Map<string, Set<string>>();
      for (const entry of translations) {
        const value = primitiveJoinValue(entry.data[field]);
        if (value === null || !entry.locale) continue;
        const key = joinValueKey(value);
        const locales = localesByValue.get(key) ?? new Set<string>();
        locales.add(entry.locale);
        localesByValue.set(key, locales);
      }
      for (const row of result.rows) {
        const value = primitiveJoinValue(row.data[field]);
        if (value === null) continue;
        const locales = translationLocales.get(row.id) ?? new Set<string>();
        for (const locale of localesByValue.get(joinValueKey(value)) ?? []) locales.add(locale);
        translationLocales.set(row.id, locales);
      }
    }
    const items = result.rows.map((row) =>
      adminListItem(row, schemasByName, [...(translationLocales.get(row.id) ?? [])])
    );
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
    const statusQuery = c.req.query("status");
    const filterField = c.req.query("filter_field");
    const filterValue = c.req.query("filter_value");
    if (Boolean(filterField) !== Boolean(filterValue)) {
      return Response.json({
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          severity: "error",
          path: "GET /admin/api/entries/export",
          expected: "filter_field and filter_value together",
          message: "List filters require both `filter_field` and `filter_value`.",
        }),
      }, { status: 400 });
    }
    const listOptions = {
      collection,
      status: statusQuery && statusQuery !== "all" ? statusQuery as ContentState : undefined,
      search: c.req.query("search") || undefined,
      filter: filterField && filterValue ? { field: filterField, value: filterValue } : undefined,
      sort: {
        field: c.req.query("sort") || "updatedAt",
        direction: c.req.query("direction") === "asc" ? "asc" as const : "desc" as const,
      },
    };
    const propertyNames = Object.keys(schema.spec.schema.properties ?? {});
    const columns = ["id", "status", "version", "updated_at", ...propertyNames];
    let page = await runtime.listEntries.executePage({ ...listOptions, limit: 100 });
    async function* chunks(): AsyncGenerator<string> {
      while (true) {
        if (page.rows.length > 0) {
          yield page.rows.map((row) =>
            csvRow(columns.map((column) => csvValue(column, row, propertyNames)))
          ).join("\r\n") + "\r\n";
        }
        if (!page.nextCursor) return;
        page = await runtime.listEntries.executePage({
          ...listOptions,
          limit: 100,
          cursor: page.nextCursor,
        });
      }
    }
    return csvDownloadResponse(collection, columns, chunks());
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
      assertMutableSchema("POST /admin/api/entries", schemasByName.get(body.collection));
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
        ctx: adminHandlerContext(c, gate, ref),
        originalInput: body,
      });
      return entryEditorPayload(runtime, row, schemas);
    }),
  );

  guarded("patch", "/admin/api/entries/:id", async (c, gate) =>
    runMantleUseCase(`PATCH /admin/api/entries/${c.req.param("id")}`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const current = await readMutableEntry(runtime, id, `PATCH /admin/api/entries/${id}`);
      if (gate.role === "contributor") {
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
        ctx: adminHandlerContext(c, gate, ref),
        originalInput: body,
      });
      return entryEditorPayload(runtime, updated, schemas);
    }),
  );

  roleGuarded("post", "/admin/api/entries/:id/publish", "editor", async (c, gate) =>
    runMantleUseCase(`POST /admin/api/entries/${c.req.param("id")}/publish`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      await readMutableEntry(runtime, id, `POST /admin/api/entries/${id}/publish`);
      const body = await c.req.raw.json().catch(() => ({}));
      const row = await runtime.requestPublish.execute({
        id,
        ctx: adminHandlerContext(c, gate, ref),
        originalInput: body,
      });
      return entryEditorPayload(runtime, row, schemas);
    }),
  );

  roleGuarded("post", "/admin/api/entries/:id/unpublish", "editor", async (c, gate) =>
    runMantleUseCase(`POST /admin/api/entries/${c.req.param("id")}/unpublish`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      await readMutableEntry(runtime, id, `POST /admin/api/entries/${id}/unpublish`);
      const body = await c.req.raw.json().catch(() => ({}));
      const row = await runtime.unpublish.execute({
        id,
        ctx: adminHandlerContext(c, gate, ref),
        originalInput: body,
      });
      return entryEditorPayload(runtime, row, schemas);
    }),
  );

  roleGuarded("delete", "/admin/api/entries/:id", "editor", async (c, gate) =>
    runMantleUseCase(`DELETE /admin/api/entries/${c.req.param("id")}`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      await readMutableEntry(runtime, id, `DELETE /admin/api/entries/${id}`);
      const body = await c.req.raw.json().catch(() => ({}));
      return runtime.deleteEntry.execute({
        id,
        ctx: adminHandlerContext(c, gate, ref),
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
  readonly uiSchema: Record<string, unknown> | null;
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
  plan: RuntimePlan,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
): readonly StaffOperation[] {
  const procedures = new Map(Object.values(plan.procedures)
    .map(({ manifest }) => [manifest.metadata.name, manifest] as const));
  const triggerKindsByProcedure = new Map<string, Set<"mcp" | "http">>();
  for (const { manifest: m } of Object.values(plan.triggers)) {
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
      uiSchema: procedure.spec.uiSchema ?? null,
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

/** Which data key publishing-list `adminEntryTitle` reads. */
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

/** Operational previews contain exactly the manifest-declared list
 *  fields. Undeclared lists stay metadata-only. */
function adminDataPreview(
  data: Record<string, unknown>,
  manifest?: SchemaManifest,
): Record<string, unknown> | undefined {
  if (!manifest || manifest.spec.lifecycle !== "operational") return undefined;
  const list = checkSchemaAdminUi(manifest).list;
  const fields = [...(list.primaryField ? [list.primaryField] : []), ...list.columns];
  if (fields.length === 0) return undefined;
  const preview: Record<string, unknown> = {};
  for (const key of fields) preview[key] = data[key];
  return preview;
}

function isStringTypedSchema(schema: JsonSchema): boolean {
  const rawType = schema.type;
  const types = Array.isArray(rawType) ? rawType : rawType ? [rawType] : [];
  return types.includes("string");
}

function adminListItem(
  row: AdminEntryRow,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  translationLocales: readonly string[] = [],
): {
  id: string;
  collection: string;
  locale: string | null;
  status: string;
  version: number;
  title: unknown;
  updated_at: number;
  translation_locales: readonly string[];
  data_preview?: Record<string, unknown>;
} {
  const manifest = schemasByName.get(row.collection);
  return {
    id: row.id,
    collection: row.collection,
    locale: row.locale ?? null,
    status: row.status,
    version: row.version,
    title: manifest?.spec.lifecycle === "operational"
      ? null
      : adminEntryTitle(row.data, manifest?.spec.schema),
    updated_at: row.updatedAt,
    translation_locales: translationLocales,
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

function csvDownloadResponse(
  filename: string,
  columns: readonly string[],
  chunks: AsyncIterable<string>,
): Response {
  const encoder = new TextEncoder();
  const iterator = chunks[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`﻿${csvRow(columns)}\r\n`));
    },
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}.csv"`,
    },
  });
}

function viewCsvValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
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
  runtime: MantleAdminRuntime,
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
    parentEntryId: await parentEntryId(runtime, schema, row, schemas),
    related,
  };
}

type AdminEditorCollection = {
  readonly name: string;
  readonly title: LocalizedText;
  readonly description: LocalizedText | null;
  readonly lifecycle: "publishing" | "operational";
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
  readonly list: { readonly primaryField: string | null; readonly columns: readonly string[] };
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
  readonly parentEntryId: string | null;
  readonly related: AdminRelatedEntrySection[];
};

type AdminRelatedEntrySection = {
  readonly collection: AdminEditorCollection;
  readonly relationship: {
    readonly kind: "translation" | "field";
    readonly parentField: string;
    readonly childField: string;
    readonly parentValue: string | number | boolean | null;
  };
  readonly entries: AdminEditorEntry[];
};

function adminEditorCollection(
  schema: SchemaManifest,
  schemas: SchemaManifest[],
): AdminEditorCollection {
  const adminUi = checkSchemaAdminUi(schema);
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
    sortableFields: schemaSortableFields(schema),
    filter: adminUi.filter,
    list: adminUi.list,
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
  runtime: MantleAdminRuntime,
  parentSchema: SchemaManifest,
  parentRow: AdminEntryRow,
  schemas: SchemaManifest[],
): Promise<AdminRelatedEntrySection[]> {
  const relationships = discoverChildRelationships(parentSchema, parentRow, schemas);
  const sections: AdminRelatedEntrySection[] = [];
  for (const relationship of relationships) {
    const childSchema = schemas.find((schema) => schema.metadata.name === relationship.collection);
    if (!childSchema) continue;
    const entries = relationship.parentValue === null
      ? []
      : await entriesByDataValue(
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
  readonly parentValue: string | number | boolean | null;
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
    if (parentValue == null && kind !== "translation") return;
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

  const translates = parentSchema.spec.translates;
  if (translates) {
    add(
      parentSchema,
      "translation",
      translates.on,
      translates.on,
      parentRow.data[translates.on],
    );
  }

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

async function parentEntryId(
  runtime: MantleAdminRuntime,
  childSchema: SchemaManifest,
  childRow: AdminEntryRow,
  schemas: SchemaManifest[],
): Promise<string | null> {
  const parent = collectionParentFor(childSchema, schemas);
  if (!parent) return null;
  const value = primitiveJoinValue(childRow.data[parent.childField]);
  if (value === null) return null;
  if (parent.parentField === "id" && typeof value === "string") return value;
  return (await entriesByDataValue(runtime, parent.collection, parent.parentField, value))[0]?.id ?? null;
}

function primitiveJoinValue(value: unknown): string | number | boolean | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function joinValueKey(value: string | number | boolean): string {
  return `${typeof value}:${String(value)}`;
}

async function entriesByDataValue(
  runtime: MantleAdminRuntime,
  collection: string,
  field: string,
  value: string | number | boolean,
): Promise<readonly Entry[]> {
  return runtime.entries.findManyByDataField({
    collection,
    field,
    value,
    limit: 50,
  });
}

function adminSiteSettings(site: SiteConfig) {
  return {
    brand: site.brand,
    title: site.title,
    description: site.description,
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

function adminHandlerContext(
  c: Context,
  gate: Extract<StaffGate, { kind: "ok" }>,
  ref: MantleAdminRef,
): HandlerContext {
  const request = ref.requestContext?.(c);
  return {
    user: { id: gate.userId },
    staff: { id: gate.userId, role: gate.role },
    auth: {
      credential: "session",
      credentialId: gate.sessionId,
      clientId: null,
      scopes: [],
    },
    env: request?.env ?? {},
    ...(request?.waitUntil ? { waitUntil: request.waitUntil } : {}),
  };
}

async function readStaffGate(c: Context, auth: AdminAuth): Promise<StaffGate> {
  const session = await auth.getSession(c.req.raw);
  if (!session) return { kind: "unauth" };
  const role = await auth.getUserRole(session.user.id);
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

async function handleViewRequest(
  req: Request,
  runtime: MantleAdminRuntime,
  view: ViewManifest,
  ctx: HandlerContext,
  exportCsv = false,
): Promise<Response> {
  const viewName = view.metadata.name;
  const viewPath = `GET /admin/api/views/${viewName}`;

  const url = new URL(req.url);
  const page = parsePositiveInt(url.searchParams.get(PAGE_PARAM));
  const show = parsePositiveInt(url.searchParams.get(SHOW_PARAM));

  let params: Record<string, unknown>;
  let listQuery: ReturnType<typeof readViewListQuery>;
  try {
    params = coerceViewParams(view, url.searchParams);
    listQuery = readViewListQuery(view, url.searchParams);
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

  const execute = (requestedPage: number | undefined) => runtime.executeView({
    view: view.metadata.name,
    pathPrefix: viewPath,
    options: {
      params,
      page: requestedPage,
      show: exportCsv ? view.spec.limit : show,
      search: listQuery.search,
      filters: listQuery.filters,
    },
    ctx,
  });

  if (exportCsv) {
    const result = await execute(1);
    if (!result.ok) {
      const status = HTTP_STATUS_BY_CODE[result.diagnostic.code] ?? 500;
      return Response.json(
        { ok: false, diagnostic: redactForWire(result.diagnostic) },
        { status },
      );
    }
    const declaredColumns = checkViewAdminUi(view).list.columns;
    const columns = declaredColumns.length > 0
      ? [...declaredColumns]
      : view.spec.fields?.length
        ? [...view.spec.fields]
        : [...new Set(result.result.rows.flatMap((row) => Object.keys(row)))];
    let current = result.result;
    let exportPage = 1;
    async function* chunks(): AsyncGenerator<string> {
      while (true) {
        if (current.rows.length > 0) {
          yield current.rows.map((row) =>
            csvRow(columns.map((column) => viewCsvValue(row[column])))
          ).join("\r\n") + "\r\n";
        }
        if (current.rows.length < current.show) return;
        const next = await execute(++exportPage);
        if (!next.ok) throw new DiagnosticError(next.diagnostic);
        current = next.result;
      }
    }
    return csvDownloadResponse(viewName, columns, chunks());
  }

  const result = await execute(page);

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

function readViewListQuery(
  view: ViewManifest,
  query: URLSearchParams,
): {
  readonly search?: { readonly term: string; readonly fields: readonly string[] };
  readonly filters: ReadonlyArray<{ readonly field: string; readonly value: string }>;
} {
  const list = checkViewAdminUi(view).list;
  const rawSearch = query.get("search")?.trim() ?? "";
  if (rawSearch && list.searchFields.length === 0) {
    throw new ViewParamCoercionError(`View '${view.metadata.name}' does not declare Admin search fields.`);
  }
  if (rawSearch.length > 200) {
    throw new ViewParamCoercionError("View Admin search must be at most 200 characters.");
  }
  const allowedFilters = new Set(list.filterFields);
  for (const key of query.keys()) {
    if (key.startsWith("filter.") && !allowedFilters.has(key.slice("filter.".length))) {
      throw new ViewParamCoercionError(`View '${view.metadata.name}' does not declare Admin filter field '${key.slice("filter.".length)}'.`);
    }
  }
  const filters = list.filterFields.flatMap((field) => {
    const value = query.get(`filter.${field}`)?.trim() ?? "";
    if (!value) return [];
    if (value.length > 200) {
      throw new ViewParamCoercionError(`View Admin filter '${field}' must be at most 200 characters.`);
    }
    return [{ field, value }];
  });
  return {
    search: rawSearch ? { term: rawSearch, fields: list.searchFields } : undefined,
    filters,
  };
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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

export async function runMantleUseCase<T>(
  operation: string,
  execute: () => T | Promise<T>,
): Promise<Response> {
  try {
    const result = await execute();
    if (isDiagnosticFailure(result)) {
      return Response.json(
        { ok: false, diagnostic: redactForWire(result.diagnostic) },
        { status: httpStatusFor(result.diagnostic) },
      );
    }
    return Response.json(result);
  } catch (error) {
    if (error instanceof DiagnosticError) {
      return Response.json(
        { ok: false, diagnostic: redactForWire(error.diagnostic) },
        { status: httpStatusFor(error.diagnostic) },
      );
    }
    console.error(`[mantle ${operation}] unhandled error`, error);
    return Response.json({
      ok: false,
      diagnostic: runtimeDiagnostic({
        code: "INTERNAL_ERROR",
        severity: "error",
        path: operation,
        message: "An internal error occurred.",
      }),
    }, { status: 500 });
  }
}

function isDiagnosticFailure(
  value: unknown,
): value is { readonly ok: false; readonly diagnostic: Diagnostic } {
  if (!value || typeof value !== "object") return false;
  const result = value as { readonly ok?: unknown; readonly diagnostic?: unknown };
  if (result.ok !== false || !result.diagnostic || typeof result.diagnostic !== "object") {
    return false;
  }
  const diagnostic = result.diagnostic as Partial<Diagnostic>;
  return typeof diagnostic.code === "string"
    && typeof diagnostic.path === "string"
    && typeof diagnostic.message === "string"
    && diagnostic.severity === "error";
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
        "Media uploads are not enabled on this deployment. Bind a `mediaStorage` port in `createMantleRuntime` to enable.",
    }),
  }, { status: 501 });
}
