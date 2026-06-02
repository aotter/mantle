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
  const translatedParents = new Set<string>();
  for (const s of schemas) {
    if (s.spec.translates) translatedParents.add(s.spec.translates.parent);
  }
  const collections = schemas
    .filter((s) => !s.spec.translates)
    .map((s) => ({
      name: s.metadata.name,
      title: s.spec.title,
      description: s.spec.description ?? null,
      lifecycle: s.spec.lifecycle ?? "simple",
      hasTranslations: translatedParents.has(s.metadata.name),
      mediaFields: mediaFieldsForCollection(s, schemas),
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
    const titleByProductSlug =
      collection === "products"
        ? await localizedProductTitles(runtime, c.req.query("locale") ?? undefined)
        : new Map<string, string>();
    const items = result.rows.map((row) =>
      adminListItem(row, titleByProductSlug),
    );
    return jsonResponse(200, { items, next_cursor: result.nextCursor ?? null });
  });

  guarded("patch", "/admin/api/entries/:id", async (c) =>
    runUseCase(`PATCH /admin/api/entries/${c.req.param("id")}`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const body = (await c.req.raw.json().catch(() => ({}))) as {
        title?: unknown;
        locale?: unknown;
      };
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) {
        throw new DiagnosticError(
          runtimeDiagnostic({
            code: "INPUT_VALIDATION_FAILED",
            severity: "error",
            path: `PATCH /admin/api/entries/${id}#/title`,
            expected: "non-empty string",
            message: "A non-empty `title` is required.",
          }),
        );
      }
      const row = await readAdminEntry(runtime, id);
      if (!row) {
        throw new DiagnosticError(adminNotFoundDiagnostic(`PATCH /admin/api/entries/${id}`, id));
      }
      await updateAdminEntryTitle(
        runtime,
        row,
        title,
        typeof body.locale === "string" ? body.locale : undefined,
      );
      const updated = await readAdminEntry(runtime, id);
      if (!updated) {
        throw new DiagnosticError(adminNotFoundDiagnostic(`PATCH /admin/api/entries/${id}`, id));
      }
      return adminListItem(
        updated,
        updated.collection === "products"
          ? await localizedProductTitles(runtime, typeof body.locale === "string" ? body.locale : undefined)
          : new Map<string, string>(),
      );
    }),
  );

  guarded("get", "/admin/api/entries/:id/product-editor", async (c) =>
    runUseCase(`GET /admin/api/entries/${c.req.param("id")}/product-editor`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const row = await readAdminEntry(runtime, id);
      if (!row) {
        throw new DiagnosticError(adminNotFoundDiagnostic(`GET /admin/api/entries/${id}/product-editor`, id));
      }
      return productEditorPayload(runtime, row, c.req.query("locale") ?? undefined);
    }),
  );

  guarded("patch", "/admin/api/entries/:id/product-editor", async (c) =>
    runUseCase(`PATCH /admin/api/entries/${c.req.param("id")}/product-editor`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const body = (await c.req.raw.json().catch(() => ({}))) as Record<string, unknown>;
      const row = await readAdminEntry(runtime, id);
      if (!row) {
        throw new DiagnosticError(adminNotFoundDiagnostic(`PATCH /admin/api/entries/${id}/product-editor`, id));
      }
      await updateProductEditor(runtime, row, body);
      const updated = await readAdminEntry(runtime, id);
      if (!updated) {
        throw new DiagnosticError(adminNotFoundDiagnostic(`PATCH /admin/api/entries/${id}/product-editor`, id));
      }
      return productEditorPayload(runtime, updated, stringField(body.locale));
    }),
  );

  guarded("post", "/admin/api/entries/:id/duplicate", async (c, gate) =>
    runUseCase(`POST /admin/api/entries/${c.req.param("id")}/duplicate`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const body = (await c.req.raw.json().catch(() => ({}))) as {
        locale?: unknown;
      };
      const row = await readAdminEntry(runtime, id);
      if (!row) {
        throw new DiagnosticError(adminNotFoundDiagnostic(`POST /admin/api/entries/${id}/duplicate`, id));
      }
      const duplicated =
        row.collection === "products"
          ? await duplicateProductEntry(runtime, row, gate.userId)
          : await duplicateGenericEntry(runtime, row, gate.userId);
      return adminListItem(
        duplicated,
        duplicated.collection === "products"
          ? await localizedProductTitles(runtime, typeof body.locale === "string" ? body.locale : undefined)
          : new Map<string, string>(),
      );
    }),
  );

  guarded("delete", "/admin/api/entries/:id", async (c) =>
    runUseCase(`DELETE /admin/api/entries/${c.req.param("id")}`, async () => {
      const runtime = await ref.get();
      const id = c.req.param("id")!;
      const row = await readAdminEntry(runtime, id);
      if (!row) {
        throw new DiagnosticError(adminNotFoundDiagnostic(`DELETE /admin/api/entries/${id}`, id));
      }
      return deleteAdminEntry(runtime, row);
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

async function localizedProductTitles(
  runtime: CmsRuntime,
  requestedLocale: string | undefined,
): Promise<Map<string, string>> {
  const site = await runtime.siteConfig.load().catch(() => null);
  const locale = requestedLocale ?? site?.canonicalLocale ?? "zh-TW";
  const page = await runtime.listEntries.executePage({
    collection: "product-translations",
    status: "published",
    limit: 500,
  });
  const fallback = new Map<string, string>();
  const preferred = new Map<string, string>();
  for (const row of page.rows) {
    const slug = typeof row.data.slug === "string" ? row.data.slug : null;
    const title = typeof row.data.title === "string" ? row.data.title : null;
    if (!slug || !title) continue;
    if (!fallback.has(slug)) fallback.set(slug, title);
    if (row.locale === locale || row.data.locale === locale) preferred.set(slug, title);
  }
  return new Map([...fallback, ...preferred]);
}

function adminEntryTitle(data: Record<string, unknown>, productTitles: Map<string, string>): unknown {
  if (typeof data.title === "string" && data.title) return data.title;
  if (typeof data.slug === "string" && productTitles.has(data.slug)) {
    return productTitles.get(data.slug);
  }
  if (typeof data.slug === "string" && data.slug) return data.slug;
  if (typeof data.skuCode === "string" && data.skuCode) return data.skuCode;
  if (typeof data.orderId === "string" && data.orderId) return data.orderId;
  return null;
}

function adminListItem(row: AdminEntryRow, productTitles: Map<string, string>): {
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
    title: adminEntryTitle(row.data, productTitles),
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

async function readAdminEntry(runtime: CmsRuntime, id: string): Promise<AdminEntryRow | null> {
  const row = await runtime.db
    .prepare(
      `SELECT id, collection, status, version, data, author_id, created_at, updated_at
       FROM entries WHERE id = ?`,
    )
    .bind(id)
    .first<AdminEntryDbRow>();
  return row ? adminRowFromDb(row) : null;
}

async function updateAdminEntryTitle(
  runtime: CmsRuntime,
  row: AdminEntryRow,
  title: string,
  requestedLocale: string | undefined,
): Promise<void> {
  if (row.collection === "products" && typeof row.data.slug === "string") {
    const locale = requestedLocale ?? "zh-TW";
    const translation = await findProductTranslation(runtime, row.data.slug, locale);
    if (translation) {
      const updated = await updateAdminEntryData(runtime, translation, { ...translation.data, title });
      await republishIfPublished(runtime, updated);
      await republishIfPublished(runtime, row);
      return;
    }
    const inserted = await insertAdminEntry(runtime, {
      id: adminId("entry_admin_translation"),
      collection: "product-translations",
      status: row.status,
      data: { slug: row.data.slug, locale, title },
      authorId: row.authorId,
    });
    await republishIfPublished(runtime, inserted);
    await republishIfPublished(runtime, row);
    return;
  }
  const updated = await updateAdminEntryData(runtime, row, { ...row.data, title });
  await republishIfPublished(runtime, updated);
}

async function productEditorPayload(
  runtime: CmsRuntime,
  row: AdminEntryRow,
  requestedLocale: string | undefined,
): Promise<{
  product: ReturnType<typeof adminListItem>;
  sku: {
    id: string | null;
    priceMinor: number | null;
    compareAtPriceMinor: number | null;
    currency: string;
  };
  content: {
    id: string | null;
    title: string;
    shortDescription: string;
    body: string;
    brand: { name: string; tagline: string; intro: string };
    promotions: Array<{
      label: string;
      title: string;
      body: string;
      relatedSkuCode?: string;
      discountPercent?: number | null;
    }>;
    serviceIncludes: string;
  };
  availableSkus: Array<{
    skuCode: string;
    productSlug: string;
    title: string;
    priceMinor: number | null;
    currency: string;
  }>;
}> {
  const slug = typeof row.data.slug === "string" ? row.data.slug : "";
  const locale = requestedLocale ?? "zh-TW";
  const sku = slug ? (await entriesByDataField(runtime, "product-skus", "productSlug", slug))[0] : null;
  const translation = slug ? await findProductTranslation(runtime, slug, locale) : null;
  const productTitles = await localizedProductTitles(runtime, locale);
  const merchandising = objectField(translation?.data.merchandising);
  const brand = objectField(merchandising.brand);
  const serviceSection = findServiceSection(
    arrayField(merchandising.introSections).map(objectField),
  );

  return {
    product: adminListItem(
      row,
      row.collection === "products" ? productTitles : new Map<string, string>(),
    ),
    sku: {
      id: sku?.id ?? null,
      priceMinor: numberField(sku?.data.priceMinor),
      compareAtPriceMinor: numberField(sku?.data.compareAtPriceMinor),
      currency: stringField(sku?.data.currency) ?? stringField(row.data.currency) ?? "TWD",
    },
    content: {
      id: translation?.id ?? null,
      title: stringField(translation?.data.title) ?? "",
      shortDescription: stringField(translation?.data.shortDescription) ?? "",
      body: stringField(translation?.data.body) ?? "",
      brand: {
        name: stringField(brand.name) ?? "",
        tagline: stringField(brand.tagline) ?? "",
        intro: stringField(brand.intro) ?? "",
      },
      promotions: arrayField(merchandising.promotions)
        .map(objectField)
        .map((promotion) => ({
          label: stringField(promotion.label) ?? "",
          title: stringField(promotion.title) ?? "",
          body: stringField(promotion.body) ?? "",
          relatedSkuCode: stringField(promotion.relatedSkuCode),
          discountPercent: numberField(promotion.discountPercent),
        })),
      serviceIncludes: stringField(serviceSection?.body) ?? "",
    },
    availableSkus: await adminProductSkuOptions(runtime, productTitles),
  };
}

async function updateProductEditor(
  runtime: CmsRuntime,
  row: AdminEntryRow,
  body: Record<string, unknown>,
): Promise<void> {
  const slug = typeof row.data.slug === "string" ? row.data.slug : null;
  if (!slug) return;
  const locale = stringField(body.locale) ?? "zh-TW";
  const priceMinor = numberField(body.priceMinor);
  const compareAtPriceMinor = numberField(body.compareAtPriceMinor);
  const sku = (await entriesByDataField(runtime, "product-skus", "productSlug", slug))[0];
  if (sku && priceMinor != null) {
    const updatedSku = await updateAdminEntryData(runtime, sku, {
      ...sku.data,
      priceMinor,
      compareAtPriceMinor,
    });
    await republishIfPublished(runtime, updatedSku);
  }

  let translation = await findProductTranslation(runtime, slug, locale);
  if (!translation) {
    translation = await insertAdminEntry(runtime, {
      id: adminId("entry_admin_translation"),
      collection: "product-translations",
      status: row.status,
      authorId: row.authorId,
      data: { slug, locale, title: stringField(body.title) ?? slug },
    });
  }

  const existingMerchandising = objectField(translation.data.merchandising);
  const introSections = upsertIntroSection(
    arrayField(existingMerchandising.introSections).map(objectField),
    SERVICE_SECTION_KEY,
    serviceSectionTitle(locale),
    stringField(body.serviceIncludes) ?? "",
  );
  const updatedTranslation = await updateAdminEntryData(runtime, translation, {
    ...translation.data,
    title: stringField(body.title) ?? translation.data.title,
    shortDescription: stringField(body.shortDescription) ?? translation.data.shortDescription,
    body: stringField(body.body) ?? translation.data.body,
    merchandising: {
      ...existingMerchandising,
      brand: {
        ...objectField(existingMerchandising.brand),
        name: stringField(body.brandName) ?? "",
        tagline: stringField(body.brandTagline) ?? "",
        intro: stringField(body.brandIntro) ?? "",
      },
      promotions: promotionsField(body.promotions),
      introSections,
    },
  });
  await republishIfPublished(runtime, updatedTranslation);
  await republishProductContent(runtime, row, slug);
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

async function duplicateProductEntry(
  runtime: CmsRuntime,
  row: AdminEntryRow,
  authorId: string | null,
): Promise<AdminEntryRow> {
  const oldSlug = typeof row.data.slug === "string" ? row.data.slug : null;
  if (!oldSlug) return duplicateGenericEntry(runtime, row, authorId);

  const newSlug = await uniqueDataField(runtime, "products", "slug", `${oldSlug}-copy`);
  const relatedSkus = await entriesByDataField(runtime, "product-skus", "productSlug", oldSlug);
  const relatedTranslations = await entriesByDataField(runtime, "product-translations", "slug", oldSlug);
  const skuMap = new Map<string, string>();
  for (const sku of relatedSkus) {
    const oldSku = typeof sku.data.skuCode === "string" ? sku.data.skuCode : null;
    if (!oldSku) continue;
    skuMap.set(oldSku, await uniqueDataField(runtime, "product-skus", "skuCode", `${oldSku}-COPY`));
  }

  const productSku = typeof row.data.sku === "string" ? row.data.sku : null;
  const product = await insertAdminEntry(runtime, {
    id: adminId("entry_admin_product"),
    collection: "products",
    status: row.status,
    authorId,
    data: {
      ...row.data,
      slug: newSlug,
      sku: productSku ? (skuMap.get(productSku) ?? `${productSku}-COPY`) : row.data.sku,
      createdAt: Date.now(),
    },
  });

  for (const sku of relatedSkus) {
    const oldSku = typeof sku.data.skuCode === "string" ? sku.data.skuCode : null;
    await insertAdminEntry(runtime, {
      id: adminId("entry_admin_sku"),
      collection: "product-skus",
      status: sku.status,
      authorId,
      data: {
        ...sku.data,
        productSlug: newSlug,
        skuCode: oldSku ? (skuMap.get(oldSku) ?? `${oldSku}-COPY`) : sku.data.skuCode,
        createdAt: Date.now(),
      },
    });
  }

  for (const translation of relatedTranslations) {
    await insertAdminEntry(runtime, {
      id: adminId("entry_admin_translation"),
      collection: "product-translations",
      status: translation.status,
      authorId,
      data: {
        ...translation.data,
        slug: newSlug,
        title:
          typeof translation.data.title === "string"
            ? `${translation.data.title}（副本）`
            : translation.data.title,
      },
    });
  }

  return product;
}

const SERVICE_SECTION_KEY = "service-includes";
const SERVICE_SECTION_TITLES = new Set(["服務包含", "服务包含", "Service includes"]);

function serviceSectionTitle(locale: string): string {
  if (locale === "zh-CN") return "服务包含";
  if (locale === "en") return "Service includes";
  return "服務包含";
}

function findServiceSection(
  sections: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  return sections.find((section) => {
    const key = stringField(section.key) ?? stringField(section.id);
    if (key === SERVICE_SECTION_KEY) return true;
    const title = stringField(section.title);
    return title ? SERVICE_SECTION_TITLES.has(title) : false;
  });
}

function upsertIntroSection(
  sections: Record<string, unknown>[],
  key: string,
  title: string,
  body: string,
): Record<string, unknown>[] {
  const next = [...sections];
  const index = next.findIndex((section) => {
    const sectionKey = stringField(section.key) ?? stringField(section.id);
    if (sectionKey === key) return true;
    const title = stringField(section.title);
    return title ? SERVICE_SECTION_TITLES.has(title) : false;
  });
  const existing = index >= 0 ? (next[index] ?? {}) : {};
  const value = {
    ...existing,
    key,
    title: stringField(existing.title) ?? title,
    body,
  };
  if (index >= 0) next[index] = value;
  else next.push(value);
  return next;
}

function promotionsField(value: unknown): Array<{
  label: string;
  title: string;
  body: string;
  relatedSkuCode?: string;
  discountPercent?: number | null;
}> {
  return arrayField(value).map(objectField).map((promotion) => ({
    label: stringField(promotion.label) ?? "",
    title: stringField(promotion.title) ?? "",
    body: stringField(promotion.body) ?? "",
    ...(stringField(promotion.relatedSkuCode) ? { relatedSkuCode: stringField(promotion.relatedSkuCode) } : {}),
    discountPercent: numberField(promotion.discountPercent),
  }));
}

async function adminProductSkuOptions(
  runtime: CmsRuntime,
  productTitles: Map<string, string>,
): Promise<Array<{
  skuCode: string;
  productSlug: string;
  title: string;
  priceMinor: number | null;
  currency: string;
}>> {
  const page = await runtime.listEntries.executePage({
    collection: "product-skus",
    status: "published",
    limit: 500,
  });
  return page.rows
    .map((row) => {
      const skuCode = stringField(row.data.skuCode);
      const productSlug = stringField(row.data.productSlug);
      if (!skuCode || !productSlug) return null;
      return {
        skuCode,
        productSlug,
        title: productTitles.get(productSlug) ?? productSlug,
        priceMinor: numberField(row.data.priceMinor),
        currency: stringField(row.data.currency) ?? "TWD",
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((a, b) => a.title.localeCompare(b.title) || a.skuCode.localeCompare(b.skuCode));
}

async function duplicateGenericEntry(
  runtime: CmsRuntime,
  row: AdminEntryRow,
  authorId: string | null,
): Promise<AdminEntryRow> {
  const data = { ...row.data };
  if (typeof data.slug === "string") {
    data.slug = await uniqueDataField(runtime, row.collection, "slug", `${data.slug}-copy`);
  }
  if (typeof data.title === "string") data.title = `${data.title}（副本）`;
  return insertAdminEntry(runtime, {
    id: adminId("entry_admin_copy"),
    collection: row.collection,
    status: row.status,
    data,
    authorId,
  });
}

async function deleteAdminEntry(
  runtime: CmsRuntime,
  row: AdminEntryRow,
): Promise<{ readonly removed: boolean }> {
  if (row.collection === "products" && typeof row.data.slug === "string") {
    const related = [
      ...(await entriesByDataField(runtime, "product-translations", "slug", row.data.slug)),
      ...(await entriesByDataField(runtime, "product-skus", "productSlug", row.data.slug)),
    ];
    for (const child of related) {
      await unpublishIfPublished(runtime, child);
      await runtime.deleteEntry.execute({ id: child.id });
    }
  }
  await unpublishIfPublished(runtime, row);
  return runtime.deleteEntry.execute({ id: row.id });
}

async function republishProductContent(
  runtime: CmsRuntime,
  product: AdminEntryRow,
  slug: string,
): Promise<void> {
  await republishIfPublished(runtime, product);
  const translations = await entriesByDataField(runtime, "product-translations", "slug", slug);
  await Promise.all(translations.map((entry) => republishIfPublished(runtime, entry)));
}

async function republishIfPublished(
  runtime: CmsRuntime,
  row: AdminEntryRow,
): Promise<void> {
  if (row.status !== "published") return;
  const site = await runtime.siteConfig.load();
  await runtime.publishOrchestrator.publish({
    entryId: row.id,
    site,
    templates: runtime.templates,
  });
}

async function unpublishIfPublished(
  runtime: CmsRuntime,
  row: AdminEntryRow,
): Promise<void> {
  if (row.status !== "published") return;
  const site = await runtime.siteConfig.load();
  await runtime.publishOrchestrator.unpublish({
    entryId: row.id,
    site,
    templates: runtime.templates,
  });
}

async function updateAdminEntryData(
  runtime: CmsRuntime,
  row: AdminEntryRow,
  data: Record<string, unknown>,
): Promise<AdminEntryRow> {
  const updated = await runtime.db
    .prepare(
      `UPDATE entries SET data = ?, version = version + 1, updated_at = ?
       WHERE id = ?
       RETURNING id, collection, status, version, data, author_id, created_at, updated_at`,
    )
    .bind(JSON.stringify(data), Date.now(), row.id)
    .first<AdminEntryDbRow>();
  if (!updated) throw new DiagnosticError(adminNotFoundDiagnostic("admin/updateEntryData", row.id));
  return adminRowFromDb(updated);
}

async function insertAdminEntry(
  runtime: CmsRuntime,
  args: {
    id: string;
    collection: string;
    status: ContentState;
    data: Record<string, unknown>;
    authorId: string | null;
  },
): Promise<AdminEntryRow> {
  const now = Date.now();
  await runtime.db
    .prepare(
      `INSERT INTO entries (id, collection, status, version, data, author_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .bind(args.id, args.collection, args.status, JSON.stringify(args.data), args.authorId, now, now)
    .run();
  const row = await readAdminEntry(runtime, args.id);
  if (!row) throw new DiagnosticError(adminNotFoundDiagnostic("admin/insertEntry", args.id));
  return row;
}

async function findProductTranslation(
  runtime: CmsRuntime,
  slug: string,
  locale: string,
): Promise<AdminEntryRow | null> {
  const row = await runtime.db
    .prepare(
      `SELECT id, collection, status, version, data, author_id, created_at, updated_at
       FROM entries
       WHERE collection = 'product-translations' AND json_extract(data, '$.slug') = ?
       ORDER BY CASE WHEN json_extract(data, '$.locale') = ? THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    )
    .bind(slug, locale)
    .first<AdminEntryDbRow>();
  return row ? adminRowFromDb(row) : null;
}

async function entriesByDataField(
  runtime: CmsRuntime,
  collection: string,
  field: string,
  value: string,
): Promise<AdminEntryRow[]> {
  const rows = await runtime.db
    .prepare(
      `SELECT id, collection, status, version, data, author_id, created_at, updated_at
       FROM entries
       WHERE collection = ? AND json_extract(data, ?) = ?
       ORDER BY updated_at DESC, id DESC`,
    )
    .bind(collection, `$.${field}`, value)
    .all<AdminEntryDbRow>();
  return rows.map(adminRowFromDb);
}

async function uniqueDataField(
  runtime: CmsRuntime,
  collection: string,
  field: string,
  preferred: string,
): Promise<string> {
  const base = slugifyIdentifier(preferred);
  for (let i = 0; i < 100; i += 1) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const row = await runtime.db
      .prepare(
        `SELECT id FROM entries
         WHERE collection = ? AND json_extract(data, ?) = ?
         LIMIT 1`,
      )
      .bind(collection, `$.${field}`, candidate)
      .first<{ id: string }>();
    if (!row) return candidate;
  }
  return `${base}-${Date.now()}`;
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

function adminId(prefix: string): string {
  const raw = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${raw.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function slugifyIdentifier(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `copy-${Date.now()}`;
}

function adminNotFoundDiagnostic(path: string, id: string): Diagnostic {
  return runtimeDiagnostic({
    code: "NOT_FOUND",
    severity: "error",
    path,
    value: id,
    expected: "existing entry id",
    message: `Entry '${id}' was not found.`,
  });
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function objectField(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
