import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "mantle-build-admin-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const { adminVitePlugin, buildAdmin } = await import(resolve(pkg, "dist/build/index.js")) as typeof import("../src/build/index.js");
const assets = (dir: string, ext: string) => readdirSync(join(dir, "assets")).filter(file => file.endsWith(ext)).map(file => readFileSync(join(dir, "assets", file), "utf8")).join("\n");

describe("@aotter/mantle-admin/build", () => {
  it("refuses an application whose react and react-dom versions differ", async () => {
    const app = join(temp, "skew");
    for (const [name, version] of [["react", "19.3.1"], ["react-dom", "19.3.0"]] as const) {
      const dir = join(app, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
    }
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "src/admin.tsx"), "export default {};\n");
    await expect(buildAdmin({ entry: join(app, "src/admin.tsx"), outDir: join(temp, "skew-out") })).rejects.toThrow(/react 19\.3\.1 and react-dom 19\.3\.0.*#527/);
  });

  it("builds the built-in entry: shell, preview document, bridge, and public files", async () => {
    const out = join(temp, "default");
    // an installed package sits under the application: an upward search would reach the application's PostCSS config
    const planted = resolve(pkg, "dist/postcss.config.mjs");
    writeFileSync(planted, 'export default { plugins: [{ postcssPlugin: "app", Once() { throw new Error("app postcss plugin ran on Admin CSS"); } }] };\n');
    try { await buildAdmin({ outDir: out }); }
    finally { rmSync(planted, { force: true }); }
    for (const file of ["index.html", "preview.html", "host-bridge.js", "theme.js", "favicon.svg"]) expect(existsSync(join(out, file)), file).toBe(true);
    // the application bundle holds the one React there is: no import map, no shared shim modules
    expect(existsSync(join(out, "shared")), "shared").toBe(false);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).not.toContain("importmap");
    expect(html).toMatch(/<script type="module" crossorigin src="\.\/assets\/index-[\w-]+\.js"><\/script>/);
    expect(readFileSync(join(out, "preview.html"), "utf8")).toContain('<meta name="mantle-admin-preview" content="1"><meta http-equiv="Content-Security-Policy" content="connect-src \'none\'; form-action \'none\'">');
    // Tailwind sees Admin's library and the kit: their classes are generated
    expect(assets(out, ".css")).toMatch(/\.bg-sidebar\{/);
  }, 120_000);

  it("builds an application entry from its own directory, with its own Tailwind classes and React's JSX", async () => {
    const src = join(temp, "app/src");
    mkdirSync(src, { recursive: true });
    // the Worker's tsconfig may set another JSX runtime; Admin's entry is React regardless
    writeFileSync(join(temp, "app/tsconfig.json"), JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" } }));
    writeFileSync(join(src, "admin.tsx"), [
      `import { defineAdmin } from ${JSON.stringify(resolve(pkg, "dist/admin-app/index.js"))};`,
      'export default defineAdmin({ note: <p className="bg-[#123456]">custom-admin-entry</p> });',
    ].join("\n"));
    const out = join(temp, "app/dist/client/admin");
    await buildAdmin({ entry: join(src, "admin.tsx"), outDir: out });
    expect(assets(out, ".js")).toContain("custom-admin-entry");
    expect(assets(out, ".css")).toContain("#123456");
  }, 120_000);

  it("serves Admin with HMR from a Vite dev server, proxying the service's API", async () => {
    const src = join(temp, "dev/src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "admin.tsx"), [
      `import { defineAdmin } from ${JSON.stringify(resolve(pkg, "dist/admin-app/index.js"))};`,
      "export default defineAdmin({});",
    ].join("\n"));
    // the "service" echoes what it received; both servers take a free port
    const service = createHttpServer((request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ via: "service", url: request.url, host: request.headers.host, origin: request.headers.origin })); });
    await new Promise<void>(done => service.listen(0, "127.0.0.1", done));
    const target = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    const { createServer } = await import("vite");
    const vite = await createServer({ configFile: false, logLevel: "silent", plugins: await adminVitePlugin({ entry: join(src, "admin.tsx"), target, authBasePath: "/auth" }), server: { port: 0, host: "127.0.0.1" } });
    try {
      await vite.listen();
      const origin = new URL(vite.resolvedUrls!.local[0]!).origin;
      const get = (path: string) => fetch(`${origin}${path}`);
      for (const path of ["/admin/", "/admin/c/requests"]) {
        const html = await (await get(path)).text();
        expect(html, path).toContain("/@vite/client");
        expect(html, path).toContain('<div id="root">');
      }
      // the page's module graph loads the application's entry through Admin's library
      const main = await get("/admin/main.js");
      expect(main.status).toBe(200);
      const code = await main.text();
      // the entry is the application's file, and every module it imports is served
      expect(code).toMatch(/import admin from "\/admin\/@fs\/[^"]+\/dev\/src\/admin\.tsx"/);
      for (const [, url] of code.matchAll(/from "(\/admin\/[^"]+)"/g)) expect((await get(url!)).status, url).toBe(200);
      expect(await (await get("/admin/api/me")).json()).toMatchObject({ via: "service", url: "/admin/api/me" });
      expect(await (await get("/auth/get-session")).json()).toMatchObject({ via: "service", url: "/auth/get-session" });
      expect(await (await get("/admin/")).text()).toContain('<meta name="mantle-auth-base" content="/auth">');
      // a write keeps the browser's Origin and Host together, as the service's same-origin check needs
      const write = await (await fetch(`${origin}/admin/api/operations/x`, { method: "POST", headers: { origin } })).json() as { host: string; origin: string };
      expect(`http://${write.host}`).toBe(write.origin);
    } finally {
      await vite.close();
      await new Promise(done => service.close(done));
    }
  }, 120_000);

  it("declares every package its shipped build and library import as a dependency", () => {
    const { name, dependencies } = JSON.parse(readFileSync(resolve(pkg, "package.json"), "utf8")) as { name: string; dependencies: Record<string, string> };
    const files = [resolve(pkg, "dist/build/index.js"), resolve(pkg, "dist/admin-build/main.js"), resolve(pkg, "dist/admin-build/styles.css"), ...readdirSync(resolve(pkg, "dist/admin-app")).filter(file => file.endsWith(".js")).map(file => resolve(pkg, "dist/admin-app", file))];
    const missing = new Set<string>();
    for (const file of files) for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"'./\s][^"'\s]*)["']/g)) {
      const bare = spec!.startsWith("@") ? spec!.split("/").slice(0, 2).join("/") : spec!.split("/")[0]!;
      if (!/^(?:node|virtual):/.test(bare) && bare !== name && !dependencies[bare]) missing.add(bare);
    }
    expect([...missing]).toEqual([]);
  });
});
