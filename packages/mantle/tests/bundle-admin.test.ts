import { expect, test } from "bun:test";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleApp } from "../src/infrastructure/bundle.js";
import { INPUTS_FILE, inputsFingerprint } from "../src/infrastructure/inputs.js";

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

test("mantle bundle refuses an outdir or assets directory that is the working directory or holds the source", async () => {
  const { dir, entry } = await app();
  const cwd = process.cwd();
  try {
    await mkdir(join(dir, "worker"));
    await writeFile(join(dir, "worker/keep.ts"), "");
    await writeFile(join(dir, "src/keep.ts"), "");
    // absolute paths: esbuild resolves a relative outdir against the directory the process started in
    const real = realpathSync(dir);
    process.chdir(real);
    await expect(bundleApp(entry, real)).rejects.toThrow("Bundle outdir must not be the working directory");
    await expect(bundleApp(entry, join(real, "src"))).rejects.toThrow("Bundle outdir must not contain the source entry");
    await expect(bundleApp(entry, join(real, "dist"), join(real, "src"))).rejects.toThrow("The assets directory must not contain the source entry");
    await expect(bundleApp(entry, join(real, "dist"), real)).rejects.toThrow("The assets directory must not be the working directory");
    expect([existsSync(join(dir, "worker/keep.ts")), existsSync(join(dir, "src/keep.ts")), existsSync(join(dir, "dist"))]).toEqual([true, true, false]);
  } finally { process.chdir(cwd); await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("mantle bundle rebuilds the built-in entry when the installed Admin moves at the same version (a patch or a link)", async () => {
  const { dir, entry, builds } = await app();
  try {
    // pnpm's layout: node_modules/@aotter/mantle-admin links into the store, whose directory names a patch by its hash
    const pkg = join(dir, "node_modules/@aotter/mantle-admin"), dist = join(dir, "dist");
    const store = (name: string) => join(dir, `node_modules/.pnpm/${name}/node_modules/@aotter/mantle-admin`);
    await mkdir(join(store("orig"), ".."), { recursive: true });
    await rename(pkg, store("orig"));
    await cp(store("orig"), store("patched"), { recursive: true });
    await symlink(store("orig"), pkg, "dir");
    await bundleApp(entry, dist);
    await bundleApp(entry, dist);
    expect(await builds()).toHaveLength(1);
    await rm(pkg);
    await symlink(store("patched"), pkg, "dir");
    await bundleApp(entry, dist);
    expect(await builds()).toHaveLength(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("mantle bundle for a bun-* target builds only Admin: Bun runs the server as TypeScript", async () => {
  const { dir, builds } = await app();
  try {
    const entry = join(dir, "src/server.ts"), generated = join(dir, "generated"), manifest = join(dir, "app.yaml");
    await mkdir(generated);
    await writeFile(manifest, "kind: Schema\n");
    await writeFile(join(generated, "generated.ts"), "export const store = 1;\n");
    await writeFile(join(generated, INPUTS_FILE), inputsFingerprint(generated, [manifest], "bun-sqlite"));
    await writeFile(entry, 'import { Database } from "bun:sqlite";\nimport { shell } from "@aotter/mantle-admin/server";\nimport { store } from "../generated/generated.js";\nBun.serve({ fetch: () => new Response(shell + store + new Database()) });\n');
    await bundleApp(entry, join(dir, "dist"));
    expect(existsSync(join(dir, "dist/worker"))).toBe(false);
    expect(await readFile(join(dir, "dist/client/admin/index.html"), "utf8")).toBe("undefined");
    // stale generated output is refused as on Workers
    await writeFile(manifest, "kind: View\n");
    await expect(bundleApp(entry, join(dir, "dist"))).rejects.toThrow("is stale");
    await writeFile(join(generated, INPUTS_FILE), inputsFingerprint(generated, [manifest], "bun-postgres"));
    // a Bun server without the Admin server builds nothing
    await rm(join(dir, "dist"), { recursive: true });
    await writeFile(entry, 'import { store } from "../generated/generated.js";\nBun.serve({ fetch: () => new Response(String(store)) });\n');
    await bundleApp(entry, join(dir, "dist"));
    expect(existsSync(join(dir, "dist"))).toBe(false);
    expect(await builds()).toHaveLength(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
