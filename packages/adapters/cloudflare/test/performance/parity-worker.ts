/** Synthetic, secret-protected benchmark only. Never bind a consumer database. */
import { Hono } from "hono";
import { AwsClient } from "aws4fetch";
import { McpJsonRpcDispatcher, projectCallableCapabilities, sealRuntimePlan, type RuntimePlanData, type McpUseCases } from "@aotter/mantle-runtime";
import { jsonSchemaToZod, redactForWire, type SiteDefaults } from "@aotter/mantle-spec";
import { TemplateRegistry, createPublicPathResolver } from "@aotter/mantle-web";
import { DPOP_SIGNING_ALGORITHMS } from "better-auth/oauth2";
import { createMantleWorker, D1DatabaseDriver, mountPublicRoutes, R2MediaStorage } from "../../src/index.js";
import { instrumentD1, instrumentKv, instrumentR2, runWithRequestDiagnostics, type RequestDiagnosticRecord } from "../../src/testing.js";
import { diagnosticPhase } from "../../src/requestDiagnostics.js";
import { gateCaller } from "../../src/mount/resolveCaller.js";
import { KvSiteConfigRepository } from "../../src/bindings/KvSiteConfigRepository.js";
import { applyCachePolicy } from "../../src/oauth/cachePolicy.js";
import { DatabaseSiteConfigRepository } from "../../../../mantle-runtime/src/infrastructure/persistence/DatabaseSiteConfigRepository.js";
import { ExecuteViewUseCase } from "../../../../mantle-runtime/src/usecase/view/ExecuteViewUseCase.js";
import { prepareSqliteView } from "../../../../mantle-runtime/src/infrastructure/storage/SqliteViewCompiler.js";
import { fixtureAuth } from "./parity-auth.js";
import planData from "./parity-plan.generated.json" with { type: "json" };

interface Env { DB: D1Database; MANTLE_KV: KVNamespace; MEDIA?: R2Bucket; BENCHMARK_KEY: string; BENCH_LOCALES?: string; BENCH_REMOTE_RECORDS?: string; }
type Layer = "F0" | "F1" | "F2" | "M";
const plan = sealRuntimePlan(planData as RuntimePlanData);
let bootId: string;
const completedCases = new Set<string>();
const records = new Map<string, { record: RequestDiagnosticRecord; bootId: string; colo: unknown; country: unknown; placement: string | null; cohort: string | null }>();
const states = new Map<boolean, ReturnType<typeof createState>>();

function createState(raw: Env, origin: string, observed: boolean) {
  const env = observed ? { ...raw, DB: instrumentD1(raw.DB), MANTLE_KV: instrumentKv(raw.MANTLE_KV), MEDIA: raw.MEDIA ? instrumentR2(raw.MEDIA) : undefined } : raw;
  const { auth, login } = fixtureAuth(env.DB, origin, env.BENCHMARK_KEY);
  const locales = (env.BENCH_LOCALES ?? "en").split(",");
  const defaults: SiteDefaults = { title: "Synthetic parity", brand: "Parity", origin, locales };
  const db = new D1DatabaseDriver(env.DB, observed ? () => {} : undefined); // Native .all metadata for Runtime .first; no second counter.
  const catalog = new KvSiteConfigRepository(new DatabaseSiteConfigRepository(db), { namespace: env.MANTLE_KV, scope: "default" });
  const lookup = async ({ id }: { id: string }) => {
    const result = await env.DB.prepare(
      `SELECT _mantle_id AS id,
              json_object('slug', slug, 'locale', locale, 'title', title, 'body', body) AS data
       FROM "items" WHERE _mantle_id = ? AND _mantle_status = 'published'`,
    ).bind(id).all();
    return { entry: result.results[0] ?? null };
  };
  const templates = new TemplateRegistry();
  templates.registerEntryTemplate("items", ({ entry }) => `<article><h1>${entry.data.title}</h1><p>${entry.data.body}</p></article>`);
  templates.registerListTemplate("items", ({ entries }) => `<main>${entries.map((entry) => `<h2>${entry.data.title}</h2>`).join("")}</main>`);
  const worker = createMantleWorker<Env>({ plan, templates, siteDefaults: defaults, auth: () => auth,
    publicPathResolver: createPublicPathResolver({ collectionRoutes: { items: { segment: "items" } } }),
    bindings: () => ({ db, mcpCatalogKv: { namespace: env.MANTLE_KV, scope: "default" },
      adminAssets: { fetch: async () => new Response("<!doctype html><title>Admin fixture</title>", { headers: { "content-type": "text/html" } }) } }),
    handlers: { lookup },
    extend: () => ({ jwtBearer: { audience: `${origin}/mcp`, scopes: ["mcp"] }, mount: ({ app, ref }) => {
      app.get("/health", () => new Response("ok"));
      mountPublicRoutes(app as Hono, ref, { collectionRoutes: [{ collection: "items", segment: "items", listRoute: true }],
        notFoundRenderer: async () => new Response("not found", { status: 404 }) });
    } }),
  });
  const prepared = new Map(Object.values(plan.views).map((view) => [view.name, prepareSqliteView(view.query, view.name, plan.schemas.items!.manifest)]));
  const viewQueries = { async execute<R>(request: { view: string; page?: number; show?: number }) {
    const query = prepared.get(request.view)!;
    const bound = query.bind(request);
    const result = await env.DB.prepare(bound.sql).bind(...bound.params).all<R>();
    const rows = query.normalizeRows(result.results);
    return { rows, page: bound.effectivePage, show: bound.effectiveShow, hasMore: rows.length === bound.effectiveShow };
  } };
  const executeView = new ExecuteViewUseCase(viewQueries, undefined, plan.views);
  const httpRoutes = new Set(plan.httpRoutes.map((route) => `${route.method} ${route.path}`));
  const input = jsonSchemaToZod(plan.procedures.lookup!.manifest.spec.input);
  const output = jsonSchemaToZod(plan.procedures.lookup!.manifest.spec.output);
  const hono = new Hono();
  hono.get("/health", () => new Response("ok"));
  for (const view of Object.values(plan.views)) hono.get(`/api/views/${view.name}`, async (c) => Response.json({ ok: true, data: await viewQueries.execute({ view: view.name }) }));
  for (const route of plan.httpRoutes) hono.post(route.path, async (c) => procedure(c.req.raw));
  async function procedure(request: Request) {
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ ok: false }, { status: 400 }); }
    const parsed = input.safeParse(body);
    if (!parsed.success) return Response.json({ ok: false, diagnostic: { code: "INPUT_VALIDATION_FAILED" } }, { status: 400 });
    return Response.json({ ok: true, data: output.parse(await lookup(parsed.data as { id: string })) });
  }
  let dispatcher: { key: string; value: McpJsonRpcDispatcher } | undefined;
  async function nativeMcp(request: Request, ctx: ExecutionContext) {
    const surface = new URL(request.url).pathname.endsWith("/staff") ? "staff" : "public";
    // Mirrors mountMcp: one shared gate, surface decides only the staff rule (#977).
    const gate = await gateCaller(request, { auth, jwtBearer: { audience: `${origin}/mcp`, scopes: ["mcp"] }, env, waitUntil: ctx.waitUntil.bind(ctx), phase: diagnosticPhase, surface });
    if (gate.kind === "deny") return denied(gate.status, gate.reason);
    const caller = gate.context;
    const site = await diagnosticPhase("catalog", () => catalog.loadCatalogSite(worker));
    const serverInfo = { name: `aotter.mantle.${surface}`, title: site.brand, description: site.description || undefined,
      websiteUrl: site.origin, icons: site.icons.filter((icon) => URL.canParse(icon.src, `${site.origin}/`)).map((icon) => ({ ...icon, src: new URL(icon.src, `${site.origin}/`).href })) };
    const key = JSON.stringify({ surface, serverInfo });
    if (dispatcher?.key !== key) {
      // Share the protocol library, not runtime assembly/storage. Only the View
      // workload is implemented in F2; unmeasured content mutations fail closed.
      const unavailable = () => { throw new Error("Operation outside native benchmark workload"); };
      const cases = new Proxy({ executeView }, { get(target, name) { return name === "executeView" ? target.executeView : { execute: unavailable, executePage: unavailable }; } });
      dispatcher = { key, value: new McpJsonRpcDispatcher(cases as unknown as McpUseCases,
        Object.values(plan.schemas).map((schema) => schema.manifest), { surface, capabilities: projectCallableCapabilities(plan, { surface }), serverInfo }) };
    }
    const response = await diagnosticPhase("dispatch", () => dispatcher!.value.dispatch(request, caller));
    if ((response.status !== 401 && response.status !== 403) || response.headers.has("www-authenticate")) return response;
    const challenged = denied(response.status, "unauthenticated");
    return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...Object.fromEntries(challenged.headers) } });
  }
  function denied(status: 401 | 403, reason: string) {
    return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: status === 403 ? "insufficient scope" : "unauthorized" }, id: null }, {
      status, headers: { "www-authenticate": reason === "invalid-dpop-proof"
        ? `DPoP error="invalid_dpop_proof", algs="${DPOP_SIGNING_ALGORITHMS.join(" ")}"`
        : `Bearer realm="mcp", error="${status === 403 ? "insufficient_scope" : "invalid_token"}", scope="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        "access-control-expose-headers": "WWW-Authenticate" },
    });
  }
  async function native(request: Request, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/mcp")) return nativeMcp(request, ctx);
    if (path === "/health") return new Response("ok");
    const gate = await gateCaller(request, { auth, jwtBearer: { audience: `${origin}/mcp`, scopes: ["mcp"] }, env, waitUntil: ctx.waitUntil.bind(ctx) });
    if (gate.kind === "deny") return Response.json({ ok: false, diagnostic: gate.diagnostic }, { status: gate.status });
    const caller = gate;
    if (httpRoutes.has(`${request.method} ${path}`)) return procedure(request);
    const name = path.slice("/api/views/".length), view = plan.views[name];
    if (path.startsWith("/api/views/") && view && request.method === "GET") {
      const search = new URL(request.url).searchParams;
      const params = Object.fromEntries([...search].filter(([key]) => key !== "page" && key !== "show"));
      const result = await executeView.execute({ view: view.manifest, ctx: caller.context, pathPrefix: `GET /api/views/${name}`,
        options: { params, page: positive(search.get("page")), show: positive(search.get("show")) } });
      return result.ok ? Response.json({ ok: true, data: result.result }) : Response.json({ ok: false, diagnostic: redactForWire(result.diagnostic) }, { status: 400 });
    }
    return new Response("not found", { status: 404 });
  }
  const storage = env.MEDIA ? new R2MediaStorage(env.MEDIA, new AwsClient({ accessKeyId: "synthetic", secretAccessKey: "synthetic" }), "https://synthetic.invalid", "https://media.example.test") : null;
  return { env, worker, auth, login, locales, async fetch(layer: Layer, request: Request, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/r2") return env.MEDIA && storage ? r2(request, env.MEDIA, storage, layer) : new Response("R2 unavailable", { status: 503 });
    if (layer === "M") return worker.fetch(request, env, ctx);
    const response = layer === "F0" ? new Response("ok") : layer === "F1" ? await hono.fetch(request, env, ctx) : await native(request, ctx);
    return applyCachePolicy(request, response);
  } };
}

const mimes = ["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif", "image/svg+xml"];
function variants(count: number, maxBytes: number) {
  return Array.from({ length: count }, (_, index) => ({ storageKey: `parity/variant-${index}`, mimeType: mimes[Math.max(0, Math.floor((index - 1) / 2))]!,
    role: (index === 0 ? "primary" : index % 2 === 0 ? "fallback" : "alternate") as "primary" | "alternate" | "fallback", maxBytes }));
}
async function r2(request: Request, bucket: R2Bucket, storage: R2MediaStorage, layer: Layer) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const params = new URL(request.url).searchParams, count = Math.min(12, Math.max(1, Number(params.get("variants")) || 1));
  // Only one primary and unique MIME/role pairs across all 12 variants.
  const specs = variants(count, 4 * 1024 * 1024);
  const args = { uploadGroupId: "parity", variants: specs, filename: "fixture", now: 1, alt: "synthetic", caption: undefined };
  if (params.get("failure") === "1") specs[0]!.maxBytes = 0;
  if (layer === "M") {
    try { return Response.json(await storage.commitUpload(args)); }
    catch { return Response.json({ failed: true }, { status: 409 }); }
  }
  if (layer === "F0") { for (const spec of specs) await bucket.head(spec.storageKey); return Response.json({ variants: count }); }
  // Sequential transfer floor: same full body reads and metadata writes, no
  // media publication. F2 adds the same pre-I/O and MIME/size validation.
  if (layer === "F2" && (specs.filter((spec) => spec.role === "primary").length !== 1
    || new Set(specs.map((spec) => `${spec.mimeType}/${spec.role}`)).size !== specs.length)) return Response.json({ failed: true }, { status: 409 });
  const result = [];
  for (const spec of specs) {
    const object = await bucket.get(spec.storageKey);
    if (!object) throw new Error("missing seeded R2 object");
    if (layer === "F2" && (object.httpMetadata?.contentType !== spec.mimeType || object.size > spec.maxBytes)) {
      await object.body.cancel(); return Response.json({ failed: true }, { status: 409 });
    }
    const committed = await bucket.put(spec.storageKey, object.body, { httpMetadata: { contentType: spec.mimeType }, customMetadata: {
      ...object.customMetadata, committedAt: "1", role: spec.role, uploadGroupId: "parity", filename: "fixture", alt: "synthetic" } });
    if (!committed) throw new Error("R2 metadata commit did not store the object.");
    result.push({ mimeType: spec.mimeType, publicUrl: `https://media.example.test/${spec.storageKey}`, storageKey: spec.storageKey, byteSize: object.size, role: spec.role });
  }
  return Response.json({ id: "parity", variants: result, alt: "synthetic", createdAt: 1, metadata: { filename: "fixture" } });
}

export default {
  async fetch(request: Request, raw: Env, ctx: ExecutionContext) {
    if (raw.BENCHMARK_KEY?.length < 32 || !raw.BENCHMARK_KEY || request.headers.get("x-benchmark-key") !== raw.BENCHMARK_KEY) return new Response("not found", { status: 404 });
    bootId ??= crypto.randomUUID();
    const url = new URL(request.url);
    if (url.pathname === "/__health") return Response.json({ bootId, fingerprint: plan.semanticFingerprint, routes: plan.httpRoutes.length, schemas: Object.keys(plan.schemas).length, views: Object.keys(plan.views).length });
    if (url.pathname === "/__records") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const ids: unknown = await request.json();
      if (!Array.isArray(ids) || ids.length > 1000 || !ids.every((id) => typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id))) return new Response("invalid ids", { status: 400 });
      return Response.json(ids.map((id) => { const record = records.get(id); records.delete(id); return record ?? null; }));
    }
    const observed = request.headers.get("x-benchmark-observe") !== "off";
    const currentState = () => {
      let current = states.get(observed);
      if (!current) { current = createState(raw, url.origin, observed); states.set(observed, current); }
      return current;
    };
    if (url.pathname.startsWith("/__")) {
      const current = currentState();
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body: any = await request.json();
      if (url.pathname === "/__login") return Response.json(await current.login(body.proof));
      if (url.pathname === "/__role") { await raw.DB.prepare("UPDATE user SET role = ? WHERE id = ?").bind(body.role, body.userId).run(); return new Response("ok"); }
      if (url.pathname === "/__consent") { await raw.DB.prepare("UPDATE oauthConsent SET scopes = ? WHERE id = ?").bind(body.scopes, body.consentId).run(); return new Response("ok"); }
      if (url.pathname === "/__session") { await raw.DB.prepare("UPDATE session SET expiresAt = ? WHERE id = ?").bind(body.expiresAt, body.sessionId).run(); return new Response("ok"); }
      if (url.pathname === "/__seed") {
        await current.worker.getRuntime(current.env);
        await raw.DB.prepare('DELETE FROM "items"').run();
        const rows = Math.min(50_000, Math.max(0, Number(body.rows) || 0)), bytes = Math.min(65_536, Math.max(0, Number(body.bytes) || 0));
        for (let offset = 0; offset < rows; offset += 50) await raw.DB.batch(Array.from({ length: Math.min(50, rows - offset) }, (_, j) => {
          const i = offset + j;
          return raw.DB.prepare(`INSERT INTO "items"
            (_mantle_id, _mantle_status, _mantle_version, slug, locale, title, body,
             _mantle_author_id, _mantle_created_at, _mantle_updated_at)
            VALUES (?, ?, 1, ?, ?, ?, ?, NULL, ?, ?)`)
            .bind(`item-${i}`, i % 5 === 0 ? "draft" : "published", `item-${i}`,
              current.locales[i % current.locales.length], `Item ${i}`, "x".repeat(bytes), i, i);
        }));
        await raw.DB.prepare("ANALYZE").run();
        return Response.json({ rows, bytes, locales: current.locales.length });
      }
      if (url.pathname === "/__r2seed") {
        if (!raw.MEDIA) return new Response("R2 unavailable", { status: 503 });
        const bytes = Math.min(4 * 1024 * 1024, Math.max(1, Number(body.bytes) || 1024));
        for (const spec of variants(12, bytes)) await raw.MEDIA.put(spec.storageKey, new Uint8Array(bytes), { httpMetadata: { contentType: spec.mimeType } });
        return Response.json({ bytes });
      }
      return new Response("not found", { status: 404 });
    }
    const layer = (request.headers.get("x-benchmark-layer") ?? "M") as Layer;
    if (!["F0", "F1", "F2", "M"].includes(layer)) return new Response("invalid layer", { status: 400 });
    const path = url.pathname;
    const surface: RequestDiagnosticRecord["surface"] = path.startsWith("/mcp") ? "mcp" : path === "/r2" ? "r2" : path.startsWith("/admin") ? "admin"
      : path === "/api/views" ? "catalog" : path.startsWith("/api/views/") ? "view" : path.startsWith("/api/lookup") ? "procedure" : path === "/health" ? "health" : "web";
    const caseName = request.headers.get("x-benchmark-case");
    if (caseName && caseName.length > 200) return new Response("invalid case", { status: 400 });
    const cohort = caseName ? (completedCases.has(caseName) ? "repeat-in-isolate" : "first-in-isolate") : null;
    const run = async () => {
      const response = await (layer === "F0" && path !== "/r2" ? Promise.resolve(applyCachePolicy(request, new Response("ok"))) : currentState().fetch(layer, request, ctx));
      if (caseName) {
        if (completedCases.size >= 1000) completedCases.delete(completedCases.values().next().value!);
        completedCases.add(caseName);
      }
      return response;
    };
    const id = request.headers.get("x-benchmark-request");
    const observation = (record: RequestDiagnosticRecord | null) => ({ record, bootId, colo: request.cf?.colo ?? null, country: request.cf?.country ?? null,
      placement: request.headers.get("cf-placement"), cohort });
    if (!observed) {
      const response = await run();
      if (id && raw.BENCH_REMOTE_RECORDS === "1") console.log("mantle-benchmark-v1", JSON.stringify({ id, observation: observation(null) }));
      return response;
    }
    return runWithRequestDiagnostics({ surface, bindings: { d1: true, kv: true, r2: !!raw.MEDIA } }, run, (record) => {
      if (!id) return;
      if (raw.BENCH_REMOTE_RECORDS === "1") {
        console.log("mantle-benchmark-v1", JSON.stringify({ id, observation: observation(record) }));
        return;
      }
      if (records.size >= 2000) records.delete(records.keys().next().value!);
      records.set(id, { ...observation(record), record });
    });
  },
};
function positive(value: string | null) { const n = Number(value); return n > 0 && Number.isFinite(n) ? n : undefined; }
