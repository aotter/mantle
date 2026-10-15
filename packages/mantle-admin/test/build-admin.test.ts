import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "mantle-build-admin-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const { buildAdmin } = await import(resolve(pkg, "dist/build/index.js")) as typeof import("../src/build/index.js");
const assets = (dir: string, ext: string) => readdirSync(join(dir, "assets")).filter(file => file.endsWith(ext)).map(file => readFileSync(join(dir, "assets", file), "utf8")).join("\n");

describe("@aotter/mantle-admin/build", () => {
  it("builds the built-in entry: shell, preview document, bridge, public files and extension shims", async () => {
    const out = join(temp, "default");
    await buildAdmin({ outDir: out });
    for (const file of ["index.html", "preview.html", "host-bridge.js", "theme.js", "favicon.svg", "shared/kit.js", "shared/react.js", "shared/extension.js"]) expect(existsSync(join(out, file)), file).toBe(true);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain('<script type="importmap">{"imports":{"react":"./shared/react.js",');
    expect(html).toMatch(/<script type="module" crossorigin src="\.\/assets\/index-[\w-]+\.js"><\/script>/);
    expect(readFileSync(join(out, "preview.html"), "utf8")).toContain('<meta name="mantle-admin-preview" content="1"><meta http-equiv="Content-Security-Policy" content="connect-src \'none\'; form-action \'none\'">');
    // Tailwind sees Admin's library and the kit: their classes are generated
    expect(assets(out, ".css")).toMatch(/\.bg-sidebar\{/);
  }, 120_000);

  it("builds an application entry from its own directory, with its own Tailwind classes", async () => {
    const src = join(temp, "app/src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "admin.tsx"), [
      `import { defineAdmin } from ${JSON.stringify(resolve(pkg, "dist/admin-app/index.js"))};`,
      'export default defineAdmin({ note: <p className="bg-[#123456]">custom-admin-entry</p> });',
    ].join("\n"));
    const out = join(temp, "app/dist/client/admin");
    await buildAdmin({ entry: join(src, "admin.tsx"), outDir: out });
    expect(assets(out, ".js")).toContain("custom-admin-entry");
    expect(assets(out, ".css")).toContain("#123456");
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
