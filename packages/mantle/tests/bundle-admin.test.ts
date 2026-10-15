import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleApp } from "../src/infrastructure/bundle.js";

/** An app whose Worker may mount Admin, with a stand-in `@aotter/mantle-admin` whose buildAdmin records each call. */
async function app() {
  const dir = await mkdtemp(join(tmpdir(), "mantle-bundle-admin-"));
  const pkg = join(dir, "node_modules/@aotter/mantle-admin");
  await mkdir(join(pkg, "dist/server"), { recursive: true });
  await mkdir(join(dir, "src"));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@aotter/mantle-admin", version: "1.0.0", type: "module", dependencies: { vite: "^8.0.0" },
    exports: { "./server": "./dist/server/index.js", "./mcp": "./dist/server/mcp.js", "./build": { default: "./dist/build.js" }, "./package.json": "./package.json" } }));
  await writeFile(join(pkg, "dist/server/index.js"), 'export const shell = "admin";\n');
  await writeFile(join(pkg, "dist/server/mcp.js"), 'export const tools = "mcp";\n');
  // an Admin dependency whose `exports` hide its package.json
  await mkdir(join(dir, "node_modules/vite"), { recursive: true });
  await writeFile(join(dir, "node_modules/vite/package.json"), JSON.stringify({ name: "vite", version: "8.0.0", exports: { ".": "./index.js" } }));
  await writeFile(join(pkg, "dist/build.js"), [
    'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "export async function buildAdmin({ entry, outDir }) {",
    "  mkdirSync(outDir, { recursive: true });",
    '  writeFileSync(join(outDir, "index.html"), String(entry));',
    `  appendFileSync(${JSON.stringify(join(dir, "builds.log"))}, String(entry) + "\\n");`,
    "}",
  ].join("\n"));
  await writeFile(join(dir, "src/worker.ts"), 'import { shell } from "@aotter/mantle-admin/server";\nexport default { fetch: () => new Response(shell) };\n');
  const builds = async () => (await readFile(join(dir, "builds.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { dir, entry: join(dir, "src/worker.ts"), builds };
}

test("mantle bundle: the Worker into <outdir>/worker, Admin into <assets>/admin; the built-in entry is rebuilt only when installed packages change", async () => {
  const { dir, entry, builds } = await app();
  try {
    const dist = join(dir, "dist");
    await bundleApp(entry, dist);
    expect(existsSync(join(dist, "worker/worker.js"))).toBe(true);
    expect(readdirSync(join(dist, "client"))).toEqual(["admin"]);
    expect(await readFile(join(dist, "client/admin/index.html"), "utf8")).toBe("undefined"); // the built-in entry
    await bundleApp(entry, dist);
    expect(await builds()).toHaveLength(1);
    // an app file changes nothing in the built-in entry
    await writeFile(join(dir, "src/page.tsx"), "export const page = 1;\n");
    await bundleApp(entry, dist);
    expect(await builds()).toHaveLength(1);
    // an upgraded Admin dependency does
    await writeFile(join(dir, "node_modules/vite/package.json"), JSON.stringify({ name: "vite", version: "8.1.0", exports: { ".": "./index.js" } }));
    await bundleApp(entry, dist);
    expect(await builds()).toHaveLength(2);
    await rm(join(dist, "client/admin"), { recursive: true });
    await bundleApp(entry, dist);
    expect(await builds()).toHaveLength(3);

    // src/admin.tsx is the entry; src/admin.ts (an Admin presentation module) is not. What it imports can be anywhere, so it always builds.
    await writeFile(join(dir, "src/admin.ts"), "export const navGroups = [];\n");
    await writeFile(join(dir, "src/admin.tsx"), "export default {};\n");
    await bundleApp(entry, dist);
    expect(await readFile(join(dist, "client/admin/index.html"), "utf8")).toEndWith("/src/admin.tsx");
    await bundleApp(entry, dist);
    expect(await builds()).toHaveLength(5);

    await bundleApp(entry, dist, join(dir, "public"));
    expect(existsSync(join(dir, "public/admin/index.html"))).toBe(true);
    await expect(bundleApp(entry, dist, dist)).rejects.toThrow("must not overlap the Worker directory");
    await expect(bundleApp(entry, dist, join(dist, "worker/static"))).rejects.toThrow("must not overlap the Worker directory");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("mantle bundle builds no Admin for a Worker that does not serve it", async () => {
  const { dir, entry, builds } = await app();
  try {
    await writeFile(entry, "export default { fetch: () => new Response('api') };\n");
    await bundleApp(entry, join(dir, "dist"));
    expect(existsSync(join(dir, "dist/worker/worker.js"))).toBe(true);
    expect(existsSync(join(dir, "dist/client"))).toBe(false);
    // Admin's MCP tools without the Admin server
    await writeFile(entry, 'import { tools } from "@aotter/mantle-admin/mcp";\nexport default { fetch: () => new Response(tools) };\n');
    await bundleApp(entry, join(dir, "dist"));
    expect(existsSync(join(dir, "dist/client"))).toBe(false);
    expect(await builds()).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
