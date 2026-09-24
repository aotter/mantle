import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runGenerate } from "../../src/cli/generate.js";
import { runSkills } from "../../src/cli/skills.js";

const originalCwd = process.cwd();
const coreOnly = { resolveAdminUiIndexHtml: () => null };
const roots: string[] = [];
const version = (JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mantle-project-"));
  roots.push(root);
  process.chdir(root);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return root;
}

it("plans a full new app from bootstrap files without confusing them for authored code", async () => {
  const root = await project();
  await writeFile("README.md", "new app\n");
  await writeFile("package.json", JSON.stringify({ name: "consumer", private: true, dependencies: { "@aotter/mantle": version } }));
  await writeFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  expect(await runSkills([])).toBe(0);
  expect(await readdir(".claude")).toContain("skills");
  expect(await runGenerate(["--host", "cf"], coreOnly)).toBe(1);
  expect(JSON.parse(await readFile("mantle.config.json", "utf8"))).toEqual({
    version: 1, host: "cf", features: ["spec", "runtime", "api", "mcp", "admin", "web"],
  });
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.type).toBe("module");
  expect(pkg.dependencies["@aotter/mantle-cloudflare"]).toBe(version);
  expect(pkg.dependencies["@aotter/mantle-admin-ui"]).toBe(version);
  expect(pkg.dependencies["@aotter/mantle-web"]).toBe(version);
  expect(pkg.devDependencies.wrangler).toBeTruthy();
  expect(pkg.scripts.generate).toBe("mantle generate");
  expect(await readFile("src/index.ts", "utf8")).toContain("generated/worker.js");
  expect(await readFile("src/home.ts", "utf8")).toContain("<main></main>");
  expect(await readFile("wrangler.jsonc", "utf8")).toContain('"binding": "ASSETS"');
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("pnpm install"));
  const before = await readFile("package.json", "utf8");
  expect(await runGenerate(["--check"], coreOnly)).toBe(1);
  expect(await readFile("package.json", "utf8")).toBe(before);
  expect(await runGenerate(["--features", "spec,runtime"], coreOnly)).toBe(2);
  expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Changing a saved host or feature list"));
  expect(await readFile("package.json", "utf8")).toBe(before);
  for (const [name, declared] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>)) {
    const path = join(root, "node_modules", name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({
      version: name.startsWith("@aotter/") ? declared : "0.0.0",
      ...(name === "@aotter/mantle-admin-ui" ? { exports: { "./index.html": "./dist/index.html" } } : {}),
    }));
  }
  await mkdir("node_modules/@aotter/mantle-admin-ui/dist", { recursive: true });
  await writeFile("node_modules/@aotter/mantle-admin-ui/dist/index.html", "admin");
  expect(await runGenerate([])).toBe(0);
  expect(await readFile(".mantle/generated/mantle.ts", "utf8")).toContain("sealRuntimePlan(");
  expect(await readFile("public/_mantle/admin/index.html", "utf8")).toBe("admin");
  expect(await readFile(".mantle/generated/worker.ts", "utf8")).toContain("createMantleWorker");
  expect(await readFile(".mantle/generated/worker.ts", "utf8")).toContain("const origin = env.PUBLIC_ORIGIN;");
  expect(await readFile(".gitignore", "utf8")).toContain(".dev.vars\n");
  await writeFile("src/home.ts", "export const customHome = true;\n");
  expect(await runGenerate([])).toBe(0);
  expect(await runGenerate(["--check"])).toBe(0);
  expect(await readFile("src/home.ts", "utf8")).toBe("export const customHome = true;\n");
  expect(await readdir(root)).toContain("README.md");
});

it("preserves an adopted Wrangler TOML and requires the existing entry to opt in", async () => {
  await project();
  const toml = 'name = "existing-worker"\nmain = "src/index.ts"\n[[d1_databases]]\nbinding = "DB"\n';
  await writeFile("wrangler.toml", toml);
  await writeFile("package.json", JSON.stringify({ name: "existing", type: "module",
    scripts: { dev: "wrangler dev", build: "my-build" } }));
  await mkdir("src");
  await writeFile("src/index.ts", "export default { fetch: () => new Response('mine') };\n");
  expect(await runGenerate(["--adopt", "--host", "cf", "--features", "spec,api"])).toBe(2);
  await expect(readFile("mantle.config.json")).rejects.toThrow();
  await writeFile("src/index.ts", 'export { default } from "../.mantle/generated/worker.js";\n');
  expect(await runGenerate(["--adopt", "--host", "cf", "--features", "spec,api"])).toBe(1);
  expect(await readFile("wrangler.toml", "utf8")).toBe(toml);
  await expect(readFile("wrangler.jsonc")).rejects.toThrow();
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.scripts.dev).toBe("wrangler dev");
  expect(pkg.scripts.build).toBe("my-build");
});

it("refuses a reduced composition while old Admin assets are still present", async () => {
  await project();
  await mkdir("public/_mantle/admin", { recursive: true });
  await writeFile("public/_mantle/admin/index.html", "old Admin");
  expect(await runGenerate(["--adopt", "--host", "cf", "--features", "spec,api"])).toBe(2);
  await expect(readFile("mantle.config.json")).rejects.toThrow();
});

it("keeps the Worker import valid with a custom generated output directory", async () => {
  await project();
  expect(await runGenerate(["--host", "cf", "--features", "spec,api", "--output", "generated"])).toBe(1);
  expect(await readFile("src/index.ts", "utf8")).toContain('../generated/worker.js');
  expect(await readFile("generated/worker.ts", "utf8")).toContain('../src/handlers.js');
  expect(await readFile("tsconfig.json", "utf8")).toContain('generated/**/*.ts');
  expect(JSON.parse(await readFile("mantle.config.json", "utf8")).output).toBe("generated");
  expect(await runGenerate([])).toBe(1);
  await expect(readFile(".mantle/generated/worker.ts")).rejects.toThrow();
});

it("repairs required project files after an interrupted first run", async () => {
  await project();
  expect(await runGenerate(["--host", "cf"])).toBe(1);
  for (const path of ["src/handlers.ts", "src/home.ts", "tsconfig.json"]) await rm(path);
  expect(await runGenerate([])).toBe(1);
  for (const path of ["src/handlers.ts", "src/home.ts", "tsconfig.json"]) {
    expect((await readFile(path, "utf8")).length).toBeGreaterThan(0);
  }
});

it("generates a blank Sites app with an immutable initial D1 migration", async () => {
  const root = await project();
  expect(await runGenerate(["--host", "chatgpt-sites"], coreOnly)).toBe(1);
  expect(await readFile("src/home.ts", "utf8")).toContain("<main></main>");
  expect(await readFile(".openai/hosting.json", "utf8")).toBe('{"d1":"DB"}\n');
  expect(await readFile("drizzle/0000_mantle.sql", "utf8")).toContain("_mantle_managed_runtime_state");
  expect(await readFile("drizzle/0000_mantle.sql", "utf8")).toContain("CREATE TABLE sites_users");
  expect(await readFile(".mantle/generated/worker.ts", "utf8")).toContain("createMantleRequestHandler");
  expect(await readFile(".mantle/generated/worker.ts", "utf8")).not.toContain("oai-authenticated-user-id");
  expect(await readFile("scripts/smoke-local.mjs", "utf8")).toContain("loopback-only");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.scripts.build).toBe("node scripts/build.mjs");
  expect(pkg.scripts["smoke:local"]).toBe("node scripts/smoke-local.mjs");
  expect(pkg.dependencies["@aotter/mantle-admin-ui"]).toBe(version);
  for (const [name, declared] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>)) {
    const path = join(root, "node_modules", name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({
      version: name.startsWith("@aotter/") ? declared : "0.0.0",
      ...(name === "@aotter/mantle-admin-ui" ? { exports: { "./index.html": "./dist/index.html" } } : {}),
    }));
  }
  await mkdir("node_modules/@aotter/mantle-admin-ui/dist", { recursive: true });
  await writeFile("node_modules/@aotter/mantle-admin-ui/dist/index.html", "admin");
  expect(await runGenerate([])).toBe(0);
  expect(await runGenerate(["--check"])).toBe(0);
  await writeFile("src/home.ts", "export const customHome = true;\n");
  await writeFile(".openai/hosting.json", '{"d1":"DB","project_id":"sites-owned"}\n');
  const wrangler = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  wrangler.d1_databases[0].database_name = "custom-local-db";
  await writeFile("wrangler.jsonc", `${JSON.stringify(wrangler, null, 2)}\n`);
  expect(await runGenerate([])).toBe(0);
  expect(await readFile("src/home.ts", "utf8")).toBe("export const customHome = true;\n");
  expect(await readFile(".openai/hosting.json", "utf8")).toContain("sites-owned");
  expect(await readFile("wrangler.jsonc", "utf8")).toContain("custom-local-db");
});

it("refuses to adopt unrelated Sites migrations and resumes its own first write", async () => {
  await project();
  await mkdir("drizzle/meta", { recursive: true });
  await writeFile("drizzle/0000_existing.sql", "CREATE TABLE existing (id TEXT);\n");
  expect(await runGenerate(["--adopt", "--host", "chatgpt-sites", "--features", "spec,api"], coreOnly)).toBe(2);
  expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("cannot be adopted"));
  await rm("drizzle/0000_existing.sql");
  expect(await runGenerate(["--adopt", "--host", "chatgpt-sites", "--features", "spec,api"], coreOnly)).toBe(1);
  const sql = await readFile("drizzle/0000_mantle.sql", "utf8");
  await rm("drizzle/meta/mantle-state.json");
  await rm("src/storage-fingerprint.json");
  expect(await runGenerate([], coreOnly)).toBe(1);
  expect(await readFile("drizzle/0000_mantle.sql", "utf8")).toBe(sql);
  expect(await readFile("drizzle/meta/mantle-state.json", "utf8")).toContain('"lastIndex": 0');
});

it("keeps a reduced Sites composition free of Admin and media bindings", async () => {
  await project();
  expect(await runGenerate(["--host", "chatgpt-sites", "--features", "spec,api"], coreOnly)).toBe(1);
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.dependencies["@aotter/mantle-admin-ui"]).toBeUndefined();
  expect(pkg.scripts["smoke:local"]).toBeUndefined();
  expect(await readFile("drizzle/0000_mantle.sql", "utf8")).not.toContain("CREATE TABLE sites_users");
  expect(await readFile("wrangler.jsonc", "utf8")).not.toContain("ASSETS");
  expect(await readFile(".openai/hosting.json", "utf8")).not.toContain("r2");
});

it("generates a real empty Spec plan without a host or fake Schema", async () => {
  await project();
  await mkdir("node_modules/@aotter/mantle", { recursive: true });
  await writeFile("node_modules/@aotter/mantle/package.json", JSON.stringify({ version }));
  await mkdir("node_modules/zod", { recursive: true });
  await writeFile("node_modules/zod/package.json", '{"version":"4.5.4"}');
  expect(await runGenerate(["--features", "spec"], coreOnly)).toBe(0);
  const source = await readFile(".mantle/generated/mantle.ts", "utf8");
  expect(source).toContain("sealRuntimePlan(");
  expect(source).not.toContain("EntryDataScalar");
  expect(source).not.toContain("MantleEntry");
  const formatted = '{"features":["spec"],"host":null,"version":1}\n';
  await writeFile("mantle.config.json", formatted);
  expect(await runGenerate(["--check"], coreOnly)).toBe(0);
  expect(await readFile("mantle.config.json", "utf8")).toBe(formatted);
  expect(JSON.parse(await readFile("mantle.config.json", "utf8")).host).toBe(null);
});

it("rejects invalid selections, explicit missing manifests, and path escapes before writing", async () => {
  const root = await project();
  expect(await runGenerate(["--features", "unknown"], coreOnly)).toBe(2);
  expect(await runGenerate(["--features", "spec", "--manifests", "./missing"], coreOnly)).toBe(1);
  expect(await runGenerate(["--features", "spec", "--output", "../outside"], coreOnly)).toBe(2);
  await writeFile("mantle.config.json", JSON.stringify({ version: 1, host: null, features: ["spec"] }));
  await mkdir(".mantle");
  await symlink(tmpdir(), ".mantle/generated");
  vi.mocked(process.stderr.write).mockClear();
  expect(await runGenerate(["--features", "spec"], coreOnly)).toBe(2);
  expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Generated path uses a symlink"));
  await rm(".mantle/generated");
  await mkdir(".mantle/generated");
  const outside = join(tmpdir(), `mantle-outside-${Date.now()}.ts`);
  await symlink(outside, ".mantle/generated/mantle.ts");
  vi.mocked(process.stderr.write).mockClear();
  expect(await runGenerate(["--features", "spec"], coreOnly)).toBe(2);
  expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Generated path uses a symlink"));
  await expect(readFile(outside)).rejects.toThrow();
  expect(await readdir(root)).toEqual([".mantle", "mantle.config.json"]);
});

it("preserves legacy compilation and requires explicit adoption for an authored application", async () => {
  await project();
  await mkdir("manifests");
  await writeFile("manifests/site.yaml", `apiVersion: cms.mantle.aotter.net/v1\nkind: Schema\nmetadata: { name: notes }\nspec: { title: Notes, schema: { type: object } }\n`);
  expect(await runGenerate([], coreOnly)).toBe(0);
  await expect(readFile("mantle.config.json")).rejects.toThrow();
  expect(await runGenerate(["--host", "cf"], coreOnly)).toBe(2);
  expect(await runGenerate(["--adopt", "--host", "cf", "--features", "spec,api"], coreOnly)).toBe(1);
  expect(JSON.parse(await readFile("mantle.config.json", "utf8")).features).toEqual(["spec", "runtime", "api"]);
});

it("does not save adoption when linking or code generation fails", async () => {
  await project();
  await mkdir("manifests");
  await writeFile("manifests/bad.yaml", `apiVersion: cms.mantle.aotter.net/v1\nkind: View\nmetadata: { name: orphan }\nspec: { surface: public, from: missing }\n`);
  expect(await runGenerate(["--adopt", "--features", "spec"], coreOnly)).toBe(1);
  await expect(readFile("mantle.config.json")).rejects.toThrow();
  await expect(readFile("package.json")).rejects.toThrow();
});

it("can adopt a legacy app whose Admin assets still match the installed bundle", async () => {
  const root = await project();
  await mkdir("manifests");
  await writeFile("manifests/site.yaml", `apiVersion: cms.mantle.aotter.net/v1\nkind: Schema\nmetadata: { name: notes }\nspec: { title: Notes, schema: { type: object } }\n`);
  await mkdir("admin-assets");
  await writeFile("admin-assets/index.html", "admin");
  const admin = { resolveAdminUiIndexHtml: () => join(root, "admin-assets/index.html") };
  expect(await runGenerate([], admin)).toBe(0);
  expect(await readFile("public/_mantle/admin/index.html", "utf8")).toBe("admin");
  expect(await runGenerate(["--adopt", "--host", "cf"], admin)).toBe(1);
  expect(JSON.parse(await readFile("mantle.config.json", "utf8")).host).toBe("cf");
});

it("leaves conflicting user package scripts untouched", async () => {
  await project();
  const original = '{"name":"custom","scripts":{"generate":"my-build"}}\n';
  await writeFile("package.json", original);
  expect(await runGenerate(["--features", "spec"], coreOnly)).toBe(2);
  expect(await readFile("package.json", "utf8")).toBe(original);
  await expect(readFile("mantle.config.json")).rejects.toThrow();
});
