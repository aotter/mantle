import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, DiagnosticError, makeDiagnostic, type RuntimePlan, type StaffRole } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type MantleRuntime, type MediaStorage } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/core/sql/adapter.js";
import { createAdminSurface, type AdminSurfaceOptions } from "../../src/admin/index.js";

const MANIFEST = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec: { title: Posts, lifecycle: operational, schema: { type: object, properties: { title: { type: string } } } }
`;
const staff = (subject: string, role: StaffRole): Caller => ({ kind: "user", subject, role, scopes: [], credential: "session", credentialId: null, clientId: null });
const owner = staff("u-owner", "owner");
const editor = staff("u-editor", "editor");
const contributor = staff("u-contrib", "contributor");

const purposes = [
  { name: "cover", required: ["image/jpeg,image/png", "webp"], maxBytes: { "image/jpeg": 1000, "image/png": 1000, "image/webp": 1000 } },
  { name: "logo", required: ["image/svg+xml"], maxBytes: { "image/svg+xml": 1000 } },
];

/** The bucket, mocked at the port: what was PUT is what commit finds. */
const calls: unknown[][] = [];
const stored = new Map<string, { mime: string; size: number }>();
const storage: MediaStorage = {
  async createUpload({ uploadGroupId, variants }) {
    calls.push(["createUpload", uploadGroupId]);
    return { capabilities: variants.map((v) => ({ mimeType: v.mimeType, role: v.role, method: "PUT", uploadUrl: `https://s3.test/${uploadGroupId}/${v.role}?sig`, storageKey: `${uploadGroupId}/${v.role}`, requiredHeaders: { "Content-Type": v.mimeType } })) };
  },
  async commitUpload({ uploadGroupId, variants, alt, caption, now }) {
    const out = variants.map((v) => {
      const o = stored.get(v.storageKey);
      if (!o) throw new DiagnosticError(makeDiagnostic({ code: "MEDIA_OBJECT_NOT_FOUND", phase: "runtime", severity: "error", path: "t", message: "missing" }));
      return { mimeType: v.mimeType, publicUrl: `https://cdn.test/${v.storageKey}`, storageKey: v.storageKey, byteSize: o.size, role: v.role };
    });
    return { id: uploadGroupId, variants: out, createdAt: now, metadata: { filename: "a.jpg" }, ...(alt === undefined ? {} : { alt }), ...(caption === undefined ? {} : { caption }) };
  },
  async deleteObject({ storageKey }) { calls.push(["deleteObject", storageKey]); },
};

let plan: RuntimePlan;
let rt: MantleRuntime;
let bare: MantleRuntime;
let d1: LocalD1;
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:site", text: MANIFEST }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  plan = res.plan;
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan, handlers: {}, storage: sqliteStorage(d1, { site: { brand: "Acme", title: "Acme News", origin: "https://acme.test", locales: ["en"], media: { purposes } } }) });
  bare = await createMantleRuntime({ plan, handlers: {}, storage: sqliteStorage(d1) });
}, 60_000);
afterAll(() => d1.dispose());

const call = async (method: string, path: string, caller: Caller, body?: unknown, opts: Partial<AdminSurfaceOptions> & { runtime?: MantleRuntime } = {}) => {
  const { runtime = rt, ...rest } = opts;
  const surface = createAdminSurface(runtime, { basePath: "/admin", media: storage, site: { mcpEndpoints: { public: "/mcp", staff: null } }, ...rest });
  const res = await surface(new Request(`http://admin.test${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), caller);
  return { status: res.status, body: await res.json() as any };
};
const variants = (jpeg = 900, webp = 500) => [{ mimeType: "image/jpeg", byteSize: jpeg, role: "primary" }, { mimeType: "image/webp", byteSize: webp, role: "alternate" }];
const upload = async (body: Record<string, unknown> = {}) => call("POST", "/admin/api/media/uploads", editor, { filename: "a.jpg", purpose: "cover", variants: variants(), ...body });

describe("site", () => {
  it("GET /site is the site config with the public URL, the mounted MCP endpoints and the media purposes; bootstrap carries it", async () => {
    const r = await call("GET", "/admin/api/site", contributor);
    expect(r.body).toMatchObject({ brand: "Acme", title: "Acme News", locales: ["en"], publicUrl: "https://acme.test", mcpEndpoints: { public: "https://acme.test/mcp", staff: null }, media: { purposes } });
    expect(r.body).not.toHaveProperty("origin");
    expect((await call("GET", "/admin/api/bootstrap", contributor)).body.site).toEqual(r.body);
    // without the capability the SPA still gets a site: the defaults, at the request's origin
    expect((await call("GET", "/admin/api/site", contributor, undefined, { runtime: bare, site: undefined })).body)
      .toMatchObject({ brand: "AotterMantle", publicUrl: "http://admin.test", mcpEndpoints: { public: null, staff: null }, media: { purposes: [] } });
  });

  it("site-settings is the owner's, checks each field's type and length, and does not exist without the capability", async () => {
    expect((await call("GET", "/admin/api/site-settings", editor)).body).toMatchObject({ minimumRole: "owner" });
    expect((await call("PATCH", "/admin/api/site-settings", editor, { title: "x" })).status).toBe(403);
    expect((await call("GET", "/admin/api/site-settings", owner)).body).toEqual({ brand: "Acme", title: "Acme News", description: "" });
    for (const body of [{ title: 5 }, { brand: "b".repeat(81) }, { title: "t".repeat(201) }, { description: "d".repeat(1001) }]) {
      const r = await call("PATCH", "/admin/api/site-settings", owner, body);
      expect([r.status, r.body.error.code]).toEqual([400, "INPUT_VALIDATION_FAILED"]);
    }
    expect((await call("PATCH", "/admin/api/site-settings", owner, { title: "Acme Daily", description: "d".repeat(1000), origin: "https://evil.test" })).body)
      .toEqual({ brand: "Acme", title: "Acme Daily", description: "d".repeat(1000) });
    expect((await call("GET", "/admin/api/site", owner)).body).toMatchObject({ title: "Acme Daily", publicUrl: "https://acme.test" });
    expect((await call("GET", "/admin/api/site-settings", owner, undefined, { runtime: bare })).status).toBe(404);
  });

  it("a stored origin that is not a URL does not take /site down: the request origin stands in", async () => {
    await d1.exec("UPDATE site_config SET value = 'not a url' WHERE key = 'origin'");
    try {
      expect((await call("GET", "/admin/api/site", contributor)).body).toMatchObject({ publicUrl: "http://admin.test", mcpEndpoints: { public: "http://admin.test/mcp" } });
    } finally { await d1.exec("UPDATE site_config SET value = 'https://acme.test' WHERE key = 'origin'"); }
  });
});

describe("media", () => {
  it("every media route is editor+ and 501 MEDIA_NOT_CONFIGURED without a MediaStorage or the site capability", async () => {
    const routes: [string, string][] = [["POST", "/admin/api/media/uploads"], ["POST", "/admin/api/media/uploads/g/commit"], ["GET", "/admin/api/media"], ["GET", "/admin/api/media/m"], ["PATCH", "/admin/api/media/m"], ["DELETE", "/admin/api/media/m"]];
    for (const [method, path] of routes) {
      expect([path, (await call(method, path, contributor, method === "GET" || method === "DELETE" ? undefined : {})).body.minimumRole]).toEqual([path, "editor"]);
      for (const opts of [{ media: undefined }, { runtime: bare }]) {
        const r = await call(method, path, editor, method === "GET" || method === "DELETE" ? undefined : {}, opts);
        expect([path, r.status, r.body.error.code]).toEqual([path, 501, "MEDIA_NOT_CONFIGURED"]);
      }
    }
  });

  it("refuses an undeclared purpose, a missing or extra slot, two primaries, SVG, a size over the cap and a suspicious one, before any URL is issued", async () => {
    calls.length = 0;
    const cases: [Record<string, unknown>, string][] = [
      [{ purpose: "banner" }, "MEDIA_PURPOSE_REJECTED"],
      [{ variants: [variants()[0]] }, "MEDIA_VARIANTS_INCOMPLETE"],
      [{ variants: [...variants(), { mimeType: "image/png", byteSize: 10, role: "alternate" }] }, "MEDIA_VARIANTS_INCOMPLETE"],
      [{ variants: variants().map((v) => ({ ...v, role: "primary" })) }, "MEDIA_VARIANTS_INCOMPLETE"],
      [{ purpose: "logo", variants: [{ mimeType: "image/svg+xml", byteSize: 10, role: "primary" }] }, "MEDIA_SVG_REJECTED"],
      [{ variants: variants(1001) }, "MEDIA_VARIANT_SIZE_EXCEEDED"],
      [{ variants: variants(500, 900) }, "MEDIA_VARIANTS_SUSPICIOUS_SIZE"],
      [{ variants: [{ mimeType: "image/jpeg", byteSize: 0, role: "primary" }] }, "INPUT_VALIDATION_FAILED"],
      [{ filename: 3 }, "INPUT_VALIDATION_FAILED"],
      [{ filename: `${"f".repeat(252)}.jpg` }, "INPUT_VALIDATION_FAILED"],
      [{ alt: "a".repeat(1001) }, "INPUT_VALIDATION_FAILED"],
      [{ caption: "c".repeat(1001) }, "INPUT_VALIDATION_FAILED"],
    ];
    for (const [body, code] of cases) {
      const r = await upload(body);
      expect([body, r.status, r.body.error.code]).toEqual([body, 400, code]);
    }
    expect(calls).toEqual([]);
  });

  it("creates, commits once, lists, reads, updates and deletes an asset; delete removes every object, then the row", async () => {
    const created = await upload({ alt: "at create" });
    expect(created.status).toBe(200);
    const { uploadGroupId, capabilities, expiresAt } = created.body;
    expect(capabilities).toEqual([
      { mimeType: "image/jpeg", role: "primary", method: "PUT", uploadUrl: `https://s3.test/${uploadGroupId}/primary?sig`, requiredHeaders: { "Content-Type": "image/jpeg" } },
      { mimeType: "image/webp", role: "alternate", method: "PUT", uploadUrl: `https://s3.test/${uploadGroupId}/alternate?sig`, requiredHeaders: { "Content-Type": "image/webp" } },
    ]);
    expect(expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
    // nothing was PUT yet: storage refuses, every object of the group is deleted (a PUT is not trusted), and a re-PUT may retry
    calls.length = 0;
    expect((await call("POST", `/admin/api/media/uploads/${uploadGroupId}/commit`, editor, {})).body.error.code).toBe("MEDIA_OBJECT_NOT_FOUND");
    expect(calls).toEqual([["deleteObject", `${uploadGroupId}/primary`], ["deleteObject", `${uploadGroupId}/alternate`]]);
    stored.set(`${uploadGroupId}/primary`, { mime: "image/jpeg", size: 900 }).set(`${uploadGroupId}/alternate`, { mime: "image/webp", size: 500 });
    const committed = await call("POST", `/admin/api/media/uploads/${uploadGroupId}/commit`, editor, { caption: "at commit" });
    expect(committed.body).toMatchObject({ id: uploadGroupId, alt: "at create", caption: "at commit", variants: [{ role: "primary", byteSize: 900 }, { role: "alternate" }] });
    expect((await call("POST", `/admin/api/media/uploads/${uploadGroupId}/commit`, editor, {})).body.error.code).toBe("MEDIA_UPLOAD_EXPIRED");

    const item = { id: uploadGroupId, primaryUrl: `https://cdn.test/${uploadGroupId}/primary`, mime: "image/jpeg", byteSize: 900, alt: "at create", caption: "at commit" };
    expect((await call("GET", "/admin/api/media?search=at%20com", editor)).body).toMatchObject({ items: [item], next_cursor: null });
    expect((await call("GET", "/admin/api/media?search=nothing", editor)).body.items).toEqual([]);
    expect((await call("GET", `/admin/api/media/${uploadGroupId}`, editor)).body).toMatchObject(item);
    expect((await call("PATCH", `/admin/api/media/${uploadGroupId}`, editor, { alt: 3 })).status).toBe(400);
    expect((await call("PATCH", `/admin/api/media/${uploadGroupId}`, editor, { caption: "c".repeat(1001) })).status).toBe(400);
    expect((await call("PATCH", `/admin/api/media/${uploadGroupId}`, editor, { alt: "" })).body).toMatchObject({ alt: "", caption: "at commit" });

    calls.length = 0;
    expect((await call("DELETE", `/admin/api/media/${uploadGroupId}`, editor)).body).toEqual({ deleted: true, variantsRemoved: 2 });
    expect(calls).toEqual([["deleteObject", `${uploadGroupId}/primary`], ["deleteObject", `${uploadGroupId}/alternate`]]);
    expect(await d1.all("SELECT id FROM media_assets WHERE id = ?1", uploadGroupId)).toEqual([]);
    expect((await call("GET", `/admin/api/media/${uploadGroupId}`, editor)).status).toBe(404);
    expect((await call("DELETE", `/admin/api/media/${uploadGroupId}`, editor)).body.error.code).toBe("MEDIA_ASSET_NOT_FOUND");
  });

  it("an unknown or expired group is MEDIA_UPLOAD_EXPIRED, and the expired record is dropped", async () => {
    expect((await call("POST", "/admin/api/media/uploads/nope/commit", editor, {})).status).toBe(410);
    await d1.exec(`INSERT INTO pending_media_uploads (id, record, expires_at) VALUES ('old', '{"expiresAt":1,"variants":[{"storageKey":"old/primary"}]}', 1)`);
    calls.length = 0;
    const r = await call("POST", "/admin/api/media/uploads/old/commit", editor, {});
    expect([r.status, r.body.error.code]).toEqual([410, "MEDIA_UPLOAD_EXPIRED"]);
    expect(await d1.all("SELECT id FROM pending_media_uploads WHERE id = 'old'")).toEqual([]);
    expect(calls).toEqual([["deleteObject", "old/primary"]]);
  });

  it("pages newest first with the cursor it returned, and refuses any other", async () => {
    await d1.exec("DELETE FROM media_assets");
    for (const n of [1, 2, 3]) await d1.exec(`INSERT INTO media_assets (id, created_at, variants) VALUES ('m${n}', ${n}, '[]')`);
    const first = await call("GET", "/admin/api/media?limit=2", editor);
    expect([first.body.items.map((i: any) => i.id), first.body.next_cursor]).toEqual([["m3", "m2"], "2"]);
    expect((await call("GET", `/admin/api/media?limit=2&cursor=${first.body.next_cursor}`, editor)).body).toMatchObject({ items: [{ id: "m1", primaryUrl: null }], next_cursor: null });
    expect((await call("GET", "/admin/api/media?cursor=x", editor)).status).toBe(400);
  });
});
