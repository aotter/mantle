import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { prepareCloudflare } from "./generate-cloudflare.js";

export const FEATURES = ["spec", "runtime", "api", "mcp", "admin", "web"] as const;
export type Feature = typeof FEATURES[number];
export type Host = "cf" | "chatgpt-sites";
export interface ProjectSelection { readonly version: 1; readonly host: Host | null; readonly features: readonly Feature[]; readonly output?: string }
export interface ProjectOptions {
  readonly root: string;
  readonly host?: string;
  readonly features?: string;
  readonly adopt: boolean;
  readonly check: boolean;
  readonly output: string;
  readonly adminAssetsCurrent?: () => Promise<boolean>;
}
export interface ProjectDecision {
  readonly mode: "legacy" | "project";
  readonly selection?: ProjectSelection;
  readonly incomplete: boolean;
  readonly commit?: () => Promise<void>;
}

const CONFIG = "mantle.config.json";
const FULL = FEATURES;
const DEPENDS: Record<Feature, readonly Feature[]> = {
  spec: [], runtime: ["spec"], api: ["runtime"], mcp: ["runtime"], admin: ["runtime", "api", "mcp"], web: ["runtime"],
};
const BOOTSTRAP = new Set([
  ".git", ".gitignore", ".agent", ".agents", ".claude", ".codex", ".cursor", ".gemini", ".opencode", ".windsurf",
  ".vscode", ".idea", ".skills", "skills", "node_modules", "package.json",
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "README.md", "AGENTS.md",
  ".DS_Store", ".npmrc", ".yarnrc.yml", ".yarn", ".nvmrc", "CLAUDE.md", "LICENSE", ".editorconfig",
]);

export async function prepareProject(options: ProjectOptions): Promise<ProjectDecision> {
  const root = await realpath(options.root);
  const configPath = join(root, CONFIG);
  const saved = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const evidence = (await readdir(root)).filter((name) => !BOOTSTRAP.has(name) && name !== CONFIG);
  if (saved === null && evidence.length && !options.adopt) {
    if (options.host || options.features) throw new Error(`Existing application (${evidence.join(", ")}) needs --adopt before selecting generated features.`);
    stdout.write(`Legacy compile mode: existing application files ${evidence.join(", ")} (use --adopt to opt in).\n`);
    return { mode: "legacy", incomplete: false };
  }
  if (options.adopt && saved !== null) throw new Error("This application already has mantle.config.json; omit --adopt.");
  if (options.adopt && !evidence.length) throw new Error("--adopt is only for an existing authored application.");
  const selection = saved !== null ? parseSelection(saved) : await chooseSelection(options);
  if (saved !== null && options.output !== ".mantle/generated" && options.output !== (selection.output ?? ".mantle/generated")) {
    throw new Error("Changing a saved generated output directory is not supported; use the saved output path.");
  }
  if (saved !== null && (options.host !== undefined || options.features !== undefined)) {
    const requested = await chooseSelection(options, selection);
    if (JSON.stringify(requested) !== JSON.stringify(selection)) {
      throw new Error("Changing a saved host or feature list is not supported in v1; edit the application deliberately before adopting a new composition.");
    }
  }
  stdout.write(`Generated project mode: ${selection.host ?? "host-free"}; features ${selection.features.join(", ")}${saved !== null ? " (saved)" : " (new)"}.\n`);
  const packagePath = join(root, "package.json");
  const existingPackage = await readFile(packagePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const pkg = existingPackage ? JSON.parse(existingPackage) as Record<string, unknown> : {
    name: basename(root).toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[._-]+/, "") || "app", private: true, type: "module",
  };
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) ||
      [pkg.dependencies, pkg.devDependencies, pkg.scripts].some((value) => value !== undefined &&
        (!value || typeof value !== "object" || Array.isArray(value)))) {
    throw new Error("package.json must contain an object with object-valued dependencies and scripts.");
  }
  if (pkg.type !== undefined && pkg.type !== "module") {
    throw new Error("Generated applications require package.json type=module; preserve CommonJS applications in legacy compile mode.");
  }
  const addModuleType = pkg.type === undefined;
  const version = (JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const required = requiredPackages(selection, version);
  const dependencies = { ...((pkg.dependencies ?? {}) as Record<string, string>) };
  const devDependencies = { ...((pkg.devDependencies ?? {}) as Record<string, string>) };
  let packageChanged = existingPackage === null || addModuleType;
  for (const [name, expected] of Object.entries(required)) {
    const actual = dependencies[name] ?? devDependencies[name];
    if (actual && name.startsWith("@aotter/") && actual !== expected) {
      throw new Error(`package.json declares ${name}@${actual}; expected exact ${expected}. Review this conflict before generating.`);
    }
    if (!actual) {
      if (["wrangler", "typescript", "@cloudflare/workers-types", "esbuild"].includes(name)) devDependencies[name] = expected;
      else dependencies[name] = expected;
      packageChanged = true;
    }
  }
  const scripts = { ...((pkg.scripts ?? {}) as Record<string, string>) };
  const requiredScripts = { generate: "mantle generate", "generate:check": "mantle generate --check",
    ...(selection.host === "cf" ? { dev: "wrangler dev --local --ip 127.0.0.1 --port 8787", deploy: "wrangler deploy", typecheck: "tsc --noEmit", build: "mantle generate && tsc --noEmit" } : {}),
    ...(selection.host === "chatgpt-sites" ? { dev: "wrangler dev --local --ip 127.0.0.1 --port 4174", typecheck: "tsc --noEmit", build: "node scripts/build.mjs",
      ...(selection.features.includes("admin") ? { "smoke:local": "node scripts/smoke-local.mjs" } : {}) } : {}) };
  for (const [name, expected] of Object.entries(requiredScripts)) {
    if (scripts[name] && scripts[name] !== expected) {
      if (name === "generate" || name === "generate:check") throw new Error(`package.json scripts.${name} conflicts with generated command ${expected}.`);
      continue;
    }
    if (!scripts[name]) { scripts[name] = expected; packageChanged = true; }
  }
  const lockfiles = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"].filter((name) => existsSync(join(root, name)));
  if (lockfiles.length > 1) throw new Error(`Multiple package-manager lockfiles found: ${lockfiles.join(", ")}. Choose one before generating.`);
  await assertInsideProject(root, packagePath);
  await assertInsideProject(root, configPath);
  const outputDir = selection.output ?? options.output;
  const output = resolve(root, outputDir, "mantle.ts");
  await assertInsideProject(root, output);
  const existingOutput = await readFile(output, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existingOutput !== null && !existingOutput.startsWith("// Generated by `mantle generate`")) {
    throw new Error(`Generated output would replace a user-owned file: ${output}`);
  }
  if (selection.features.includes("admin")) {
    const admin = resolve(root, "public/_mantle/admin");
    await assertInsideProject(root, admin);
    if (saved === null && existsSync(admin) && !(options.adopt && await options.adminAssetsCurrent?.())) {
      throw new Error(`Admin asset target already exists and cannot be verified as generated: ${admin}`);
    }
  }
  const cloudflare = selection.host === "cf" ? await prepareCloudflare(root, outputDir, selection, saved === null) : null;
  const nextPackage = packageChanged ? `${JSON.stringify({ ...pkg, type: "module", scripts, dependencies,
    ...(Object.keys(devDependencies).length ? { devDependencies } : {}),
  }, null, 2)}\n` : existingPackage!;
  const nextConfig = `${JSON.stringify(selection, null, 2)}\n`;
  const drift = saved === null || existingPackage !== nextPackage || Boolean(cloudflare?.stale);
  if (options.check) {
    if (drift) stderr.write("Project config or package declarations are stale.\n");
    const missing = missingPackages(root, required);
    if (missing.length) stderr.write(`Selected packages are missing or mismatched: ${missing.join(", ")}.\n`);
    return { mode: "project", selection, incomplete: drift || missing.length > 0 };
  }
  const missing = missingPackages(root, required);
  const install = lockfiles[0] === "pnpm-lock.yaml" ? "pnpm install" : lockfiles[0] === "yarn.lock" ? "yarn install" : lockfiles[0]?.startsWith("bun") ? "bun install" : "npm install";
  return {
    mode: "project", selection, incomplete: missing.length > 0,
    commit: async () => {
      if (existingPackage !== nextPackage) await atomicWrite(packagePath, nextPackage);
      if (saved === null) await atomicWrite(configPath, nextConfig);
      await cloudflare?.commit();
      if (missing.length) stdout.write(`Install selected packages with ${install}, then run mantle generate again. Missing or mismatched: ${missing.join(", ")}.\n`);
    },
  };
}

async function chooseSelection(options: ProjectOptions, saved?: ProjectSelection): Promise<ProjectSelection> {
  const selected = options.features === undefined ? saved?.features ?? FULL : options.features.split(",").map((value) => value.trim());
  if (!selected.length || selected.some((value) => !FEATURES.includes(value as Feature))) {
    throw new Error(`--features accepts only ${FEATURES.join(", ")}; got ${options.features ?? ""}.`);
  }
  const closure = new Set<Feature>();
  const add = (feature: Feature): void => { for (const dep of DEPENDS[feature]) add(dep); closure.add(feature); };
  for (const feature of selected) add(feature as Feature);
  const features = FEATURES.filter((feature) => closure.has(feature));
  let host = options.host ?? (features.length === 1 ? null : saved?.host ?? null);
  if (host && host !== "cf" && host !== "chatgpt-sites") throw new Error(`--host must be cf or chatgpt-sites; got ${host}.`);
  if (features.some((feature) => feature !== "spec") && !host) {
    if (options.check || !stdin.isTTY) throw new Error("Host required for selected features; pass --host cf or --host chatgpt-sites.");
    const prompt = createInterface({ input: stdin, output: stdout });
    try { host = (await prompt.question("Host (cf/chatgpt-sites): ")).trim(); }
    finally { prompt.close(); }
    if (host !== "cf" && host !== "chatgpt-sites") throw new Error("Host must be cf or chatgpt-sites.");
  }
  if (features.length === 1 && host) throw new Error("Spec-only generation is host-free; omit --host.");
  return { version: 1, host: host as Host | null, features,
    ...(options.output !== ".mantle/generated" ? { output: options.output } : saved?.output ? { output: saved.output } : {}) };
}

function parseSelection(source: string): ProjectSelection {
  const value = JSON.parse(source) as ProjectSelection;
  if (!value || value.version !== 1 || !Array.isArray(value.features) ||
      value.features.some((feature) => !FEATURES.includes(feature)) ||
      (value.host !== null && value.host !== "cf" && value.host !== "chatgpt-sites") ||
      (value.output !== undefined && (typeof value.output !== "string" || !value.output.trim()))) {
    throw new Error("Invalid mantle.config.json selection.");
  }
  const selected = new Set(value.features);
  if (!selected.has("spec") || value.features.length !== selected.size ||
      FEATURES.filter((feature) => selected.has(feature)).join(",") !== value.features.join(",") ||
      value.features.some((feature: Feature) => DEPENDS[feature].some((dependency) => !selected.has(dependency))) ||
      (value.features.length === 1) !== (value.host === null)) {
    throw new Error("mantle.config.json has an invalid feature closure or host.");
  }
  return { version: 1, host: value.host, features: value.features,
    ...(value.output ? { output: value.output } : {}) };
}

function requiredPackages(selection: ProjectSelection, version: string): Record<string, string> {
  const required: Record<string, string> = { "@aotter/mantle": version, zod: "^4.5.0" };
  if (selection.host) required["@aotter/mantle-cloudflare"] = version;
  if (selection.features.includes("admin")) {
    required["@aotter/mantle-admin"] = version;
    required["@aotter/mantle-admin-ui"] = version;
  }
  if (selection.features.includes("web")) required["@aotter/mantle-web"] = version;
  if (selection.host) {
    // The current Cloudflare adapter declares these peers even in reduced compositions.
    required["better-auth"] = "1.7.2";
    required["hono"] = "^4.12.0";
    required["aws4fetch"] = "^1.0.20";
  }
  if (selection.host === "cf" && selection.features.includes("admin")) required["@aotter/mantle-auth"] = version;
  if (selection.host === "cf" || selection.host === "chatgpt-sites") {
    required.wrangler = "4.129.0";
    required.typescript = "^6.0.3";
    required["@cloudflare/workers-types"] = "5.20260904.1";
  }
  if (selection.host === "chatgpt-sites") required.esbuild = "^0.28.0";
  return required;
}

function missingPackages(root: string, required: Record<string, string>): string[] {
  return Object.entries(required).filter(([name, expected]) => {
    let path: string | null = null;
    for (let parent = root; ; parent = dirname(parent)) {
      const candidate = join(parent, "node_modules", name, "package.json");
      if (existsSync(candidate)) { path = candidate; break; }
      if (dirname(parent) === parent) break;
    }
    if (!path) return true;
    if (!name.startsWith("@aotter/")) return false;
    try { return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version !== expected; }
    catch { return true; }
  }).map(([name]) => name);
}

export async function assertInsideProject(root: string, path: string): Promise<void> {
  const project = await realpath(root);
  let parent = resolve(path);
  while (true) {
    try {
      if ((await lstat(parent)).isSymbolicLink()) throw new Error(`Generated path uses a symlink: ${parent}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      parent = dirname(parent);
    }
  }
  const target = await realpath(parent);
  const difference = relative(project, target);
  if (difference === ".." || difference.startsWith(`..${sep}`) || resolve(path) === project) {
    throw new Error(`Generated path escapes project: ${path}`);
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try { await writeFile(temporary, value, { flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
