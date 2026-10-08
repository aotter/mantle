import { afterAll, beforeAll, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, type StaffRole } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type MantleRuntime, type MediaStorage } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { createMcpSurface } from "../../src/mcp/index.js";
import { createAdminSurface } from "../../src/admin/index.js";

const manifest = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec: { title: Posts, lifecycle: operational, schema: { type: object, properties: { cover: { type: string, x-mantle-ref: media_assets, x-mcp-hint: media-image } } } }
`;
const purposes = [{ name: "cover", required: ["image/jpeg"], maxBytes: { "image/jpeg": 1000 } }];
const caller = (role: StaffRole | null): Caller => ({ kind: "user", subject: "staff", role, scopes: ["mcp"], credential: "oauth", credentialId: "token", clientId: "client" });
const objects = new Map<string, number>();
let committed = 0;
const media: MediaStorage = {
  async createUpload({ uploadGroupId, variants }) {
    return { capabilities: variants.map((v) => ({ mimeType: v.mimeType, role: v.role, method: "PUT", storageKey: `${uploadGroupId}/${v.role}`, uploadUrl: `https://bucket.test/${uploadGroupId}/${v.role}`, requiredHeaders: { "Content-Type": v.mimeType } })) };
  },
  async commitUpload({ uploadGroupId, variants, now, alt }) {
    const asset = { id: uploadGroupId, createdAt: now, ...(alt ? { alt } : {}), variants: variants.map((v) => {
      const size = objects.get(v.storageKey);
      if (!size) throw new Error("test object was not uploaded");
      return { ...v, byteSize: size, publicUrl: `https://media.test/${v.storageKey}` };
    }) };
    committed++;
    return asset;
  },
  async deleteObject({ storageKey }) { objects.delete(storageKey); },
};
let db: LocalD1;
let runtime: MantleRuntime;
let bare: MantleRuntime;
beforeAll(async () => {
  const compiled = await compilePlan({ sources: [{ sourceId: "memory:media", text: manifest }] });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  db = await LocalD1.create();
  runtime = await createMantleRuntime({ plan: compiled.plan, handlers: {}, storage: sqliteStorage(db, { site: { title: "Media", media: { purposes } } }) });
  bare = await createMantleRuntime({ plan: compiled.plan, handlers: {}, storage: sqliteStorage(db) });
}, 60_000);
afterAll(() => db.dispose());
const rpc = async (who: Caller, method: string, params: unknown = {}, surface = createMcpSurface(runtime, { basePath: "/mcp/staff", surface: "staff", media })) => {
  const response = await surface(new Request("https://site.test/mcp/staff", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), who);
  const text = await response.text();
  const data = JSON.parse(text.includes("data:") ? text.split("\n").find((line) => line.startsWith("data:"))!.slice(5) : text);
  return { status: response.status, data };
};
const invoke = async (name: string, args: unknown = {}, who = caller("editor")) => (await rpc(who, "tools/call", { name, arguments: args })).data.result;
const input = { filename: "cover.jpg", purpose: "cover", variants: [{ mimeType: "image/jpeg", byteSize: 50, role: "primary" }] };

it("advertises optional staff tools only when media and site are configured, and guards all callers", async () => {
  const names = (await rpc(caller("editor"), "tools/list")).data.result.tools.map((t: { name: string }) => t.name);
  expect(names).toEqual(expect.arrayContaining(["get_media_upload_policy", "create_media_upload", "commit_media_upload", "list_media_assets", "get_media_asset", "update_media_asset", "delete_media_asset"]));
  for (const [rt, storage, scope] of [[runtime, undefined, "staff"], [bare, media, "staff"], [runtime, media, "public"]] as const)
    expect(createMcpSurface(rt, { basePath: "/mcp", surface: scope, ...(storage ? { media: storage } : {}) }).tools).toHaveLength(0);
  expect((await rpc({ kind: "anonymous" }, "tools/list")).status).toBe(401);
  expect((await rpc(caller(null), "tools/list")).status).toBe(403);
  expect((await rpc({ ...caller("owner"), scopes: [] } as Caller, "tools/list")).status).toBe(403);
  for (const name of names) {
    const result = await invoke(name, name === "create_media_upload" ? input : { id: "x", uploadGroupId: "x" }, caller("contributor"));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).diagnostics[0].code).toBe("AUTH_DENIED");
  }
});

it("reuses Admin's media library for policy, direct upload, commit and permanent asset references", async () => {
  expect((await invoke("get_media_upload_policy")).structuredContent).toEqual({ purposes });
  expect((await invoke("create_media_upload", { ...input, purpose: "unknown" })).isError).toBe(true);
  expect(JSON.parse((await invoke("create_media_upload", { ...input, variants: [{ mimeType: "image/jpeg", byteSize: 1001, role: "primary" }] })).content[0].text).diagnostics[0].code).toBe("MEDIA_VARIANT_SIZE_EXCEEDED");
  expect(JSON.parse((await invoke("create_media_upload", { ...input, variants: [{ mimeType: "image/svg+xml", byteSize: 10, role: "primary" }] })).content[0].text).diagnostics[0].code).toBe("MEDIA_VARIANTS_INCOMPLETE");
  for (const [name, args] of [["get_media_asset", { id: 42 }], ["list_media_assets", { search: {} }], ["commit_media_upload", {}]])
    expect(JSON.parse((await invoke(name as string, args)).content[0].text).diagnostics[0].code).toBe("INPUT_VALIDATION_FAILED");
  expect(JSON.parse((await invoke("commit_media_upload", { uploadGroupId: "unknown" })).content[0].text).diagnostics[0].code).toBe("MEDIA_UPLOAD_EXPIRED");
  const expired = (await invoke("create_media_upload", input)).structuredContent;
  const [record] = await db.all<{ record: string }>(`SELECT record FROM pending_media_uploads WHERE id = '${expired.uploadGroupId}'`);
  await db.exec(`UPDATE pending_media_uploads SET record = '${JSON.stringify({ ...JSON.parse(record!.record), expiresAt: 1 })}' WHERE id = '${expired.uploadGroupId}'`);
  expect(JSON.parse((await invoke("commit_media_upload", { uploadGroupId: expired.uploadGroupId })).content[0].text).diagnostics[0].code).toBe("MEDIA_UPLOAD_EXPIRED");
  const upload = (await invoke("create_media_upload", input, caller("owner"))).structuredContent;
  expect(upload.capabilities[0]).toMatchObject({ method: "PUT", requiredHeaders: { "Content-Type": "image/jpeg" } });
  objects.set(`${upload.uploadGroupId}/primary`, 50); // direct object upload, not a JSON/base64 MCP call
  const asset = (await invoke("commit_media_upload", { uploadGroupId: upload.uploadGroupId, alt: "Cover" })).structuredContent;
  expect(committed).toBe(1);
  expect(asset).toMatchObject({ id: upload.uploadGroupId, alt: "Cover" });
  expect((await invoke("get_media_asset", { id: asset.id })).structuredContent).toEqual(asset);
  expect((await invoke("list_media_assets")).structuredContent.rows).toContainEqual(asset);
  const admin = createAdminSurface(runtime, { basePath: "/admin", media });
  const response = await admin(new Request(`https://site.test/admin/api/media/${asset.id}`), { ...caller("editor"), credential: "session" } as Caller);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: asset.id, alt: "Cover" });
  expect((await invoke("update_media_asset", { id: asset.id, caption: "Caption" })).structuredContent.caption).toBe("Caption");
  expect((await invoke("delete_media_asset", { id: asset.id })).structuredContent.deleted).toBe(true);
});

it("fails closed when a declared Procedure or View collides with an enabled media tool", () => {
  const fake = { ...runtime, plan: { ...runtime.plan, procedures: { "create-media-upload": { input: { type: "object" }, output: { type: "object" } } }, triggers: { upload: { source: { kind: "mcp", surface: "staff" }, procedure: "create-media-upload" } } } } as unknown as MantleRuntime;
  expect(() => createMcpSurface(fake, { basePath: "/mcp/staff", surface: "staff", media })).toThrow(/collides/);
  const view = { ...runtime, plan: { ...runtime.plan, views: { "get-media-asset": { surface: "staff" } } } } as unknown as MantleRuntime;
  expect(() => createMcpSurface(view, { basePath: "/mcp/staff", surface: "staff", media })).toThrow(/collides/);
});
