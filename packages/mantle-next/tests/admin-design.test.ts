import { test, expect } from "bun:test";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAdminDesignSurface } from "../src/kernel/admin/design.js";
const { adminPreviewDocument, readAdminPreviewRequest } = await import(resolve(import.meta.dir, "../../mantle-ui/src/admin-preview/index.ts"));
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
const origin = "https://design.test", options = { name: "My draft", origin };
const snapshot = { dataModel: { schemas: [] }, logic: { procedures: [] }, interfaces: {}, graph: {} };

test("design cannot grant a staff identity or execute data/auth/operations with any credential", async () => {
  let reads = 0;
  const handle = createAdminDesignSurface(snapshot, Object.defineProperties({ ...options }, {
    db: { get() { reads++; throw Error("Database must not be accessed."); } },
    caller: { get() { reads++; throw Error("Credentials must not be resolved."); } },
  }));
  const get = (path: string, init?: RequestInit) => handle(new Request(origin + path, init));
  const credentialHeaders: Record<string, string>[] = [{}, { authorization: "Bearer fixture" }, { cookie: "staff-session=fixture" }, { origin: "https://foreign.test" }];
  for (const headers of credentialHeaders) {
    const response = await get("/admin/api/me", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ role: null, login: null, image: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  }
  expect(await (await get("/admin/api/site")).json()).toEqual({ brand: options.name, icons: [], locales: [], canonicalLocale: null, publicUrl: null, capabilities: {} });
  expect(await (await get("/admin/api/developer-console")).json()).toEqual(snapshot);
  expect(await (await get("/admin/api/webmcp")).json()).toEqual({ tools: [], routes: {} });
  for (const method of ["HEAD", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"])
    for (const path of ["/admin/api/me", "/admin/api/developer-console", "/admin/api/webmcp/tool", "/api/auth/sign-out", "/admin/api/entries", "/admin/api/staff"]) {
      const response = await get(path, { method });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "DESIGN_ONLY" } });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  for (const path of ["/admin/api/entries", "/admin/api/staff", "/admin/api/operations", "/mcp", "/admin/api/me/", "/admin/api/%6de", "/admin/api/%2fme", "/admin/api/%5cme", "/admin/api/%GG", "/admin//api/me", "/admin/api", "/admin"]) expect((await get(path)).status).toBe(403);
  expect((await handle(new Request("https://foreign.test/admin/api/me"))).status).toBe(403);
  expect(reads).toBe(0);
});

test("the canonical UI preview document/protocol still bridges only same-origin Admin requests", async () => {
  const html = adminPreviewDocument('<head><meta name="mantle-admin-preview" content="1"><base href="/admin/"><script src="/admin/theme.js"></script></head>', { assetBasePath: "/preview", basePath: "/builder/admin", design: true });
  expect(html).toContain('<base href="/preview/">');
  expect(html).toContain('src="/preview/host-bridge.js" data-base-path="/builder/admin" data-mode="design"');
  expect(html).toContain('src="/preview/theme.js"');
  const envelope = { type: "mantle:host-api:request", protocolVersion: 1, request: { url: origin + "/admin/api/developer-console", method: "GET", headers: [], body: null } };
  const handle = createAdminDesignSurface(snapshot, options);
  expect(await (await handle(readAdminPreviewRequest(envelope, origin))).json()).toEqual(snapshot);
  for (const url of ["https://foreign.test/admin/api/me", origin + "/api/auth/sign-out", origin + "/admin/api/../sign-in"]) expect(() => readAdminPreviewRequest({ ...envelope, request: { ...envelope.request, url } }, origin)).toThrow();
  for (const body of [new ArrayBuffer(1), new ArrayBuffer(1024 * 1024 + 1)]) expect(() => readAdminPreviewRequest({ ...envelope, request: { ...envelope.request, body } }, origin)).toThrow();
  const mutation = readAdminPreviewRequest({ ...envelope, request: { ...envelope.request, method: "POST", body: new TextEncoder().encode("{}").buffer } }, origin);
  expect((await handle(mutation)).status).toBe(403);
});

for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const) test(`${target} generated design uses static metadata and carries no execution dependencies`, async () => {
  const files = await generateOrThrow(target, await loadFixtureSources());
  const dir = await mkdtemp(join(tmpdir(), "mantle-admin-design-"));
  try {
    await writeGenerated(dir, files);
    const { adminDesign } = await import(join(dir, "admin-design.ts"));
    const metadata = await import(join(dir, "admin-descriptors.ts")), handle = adminDesign(options);
    expect(await (await handle(new Request(origin + "/admin/api/developer-console"))).json()).toEqual(metadata.developerConsole);
    expect((await handle(new Request(origin + "/admin/api/entries"))).status).toBe(403);
    expect(files["admin-design.ts"]).not.toMatch(/^(?:const|let|export const).*createAdminDesignSurface/m);
    const entry = join(dir, "worker.ts");
    await writeFile(entry, 'import {adminDesign} from "./admin-design.js"; export default {fetch:(request)=>adminDesign({name:"Draft",origin:"https://design.test"})(request)};');
    const selected = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, platform: "neutral", format: "esm", target: "es2022" });
    const inputs = Object.keys(selected.metafile!.inputs);
    expect(inputs.some(path => path.endsWith("/kernel/admin/design.ts"))).toBe(true);
    expect(inputs.some(path => /\/(?:store|admin|contracts|site|media)\.ts$|\/driver\/|\/dialect\/|mantle\/dist|\/node_modules\//.test(path))).toBe(false);
    await writeFile(entry, 'export default {fetch:()=>new Response("Bare")};');
    const absent = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, platform: "neutral", format: "esm" });
    expect(Object.keys(absent.metafile!.inputs).some(path => /\/(?:admin-design|admin-descriptors)\.ts$|\/admin\/design\.ts$/.test(path))).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
