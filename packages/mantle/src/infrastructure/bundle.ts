import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Metafile } from "esbuild";
import { INPUTS_FILE, authTableSql, extraRoles, generatedTarget, staleInputs } from "./inputs.js";

/** Only static imports run at startup; dynamic imports remain separate uploaded modules. */
export function startupGraph(metafile: Metafile, entry: string): string[] {
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);
    const output = metafile.outputs[name]!;
    for (const imported of output.imports) {
      if (!imported.external && imported.kind !== "dynamic-import") visit(imported.path);
    }
  };
  for (const [name, output] of Object.entries(metafile.outputs)) if (output.entryPoint && resolve(output.entryPoint) === resolve(entry)) visit(name);
  return [...visited];
}

const refused: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|\/)node_modules\/(?:better-auth(?:\/|$)|@better-auth\/)/, "Load it through authLoader(() => import(...)) to keep Better Auth out of startup."],
  [/(?:^|\/)node_modules\/@modelcontextprotocol\//, "Load MCP through a request-time import(...)."],
  // the compiler: the package's own generator layers (installed, or workspace dist/source) and its parser, YAML and SQL dependencies
  [/(?:^|\/)node_modules\/(?:@aotter\/mantle\/dist\/(?:build|infrastructure)\/|yaml\/|pgsql-deparser\/|libpg-query\/)|(?:^|\/)mantle\/(?:dist|src)\/(?:build|infrastructure)\//, "Generator code must not run in a Worker; import runtime entry points such as @aotter/mantle/rest."],
  // Admin's UI is built into <assets>/admin by the app's admin.tsx; the Worker serves it, never runs it.
  [/(?:^|\/)node_modules\/@aotter\/mantle-admin\/dist\/admin-app\/|(?:^|\/)mantle-admin\/(?:dist\/admin-app|admin\/src)\//, "Admin's UI (@aotter/mantle-admin/app, /hooks) runs in the browser: import it only from src/admin.tsx, which `mantle bundle` builds into the assets directory."],
];

export function guardStartup(metafile: Metafile, entry: string): void {
  for (const name of startupGraph(metafile, entry)) {
    const output = metafile.outputs[name]!;
    for (const input of Object.keys(output.inputs)) {
      // shortcut: vendored auth outside node_modules is not recognized; use package metadata if vendoring is supported.
      const hit = refused.find(([pattern]) => pattern.test(input.replaceAll("\\", "/")));
      if (hit) throw new Error(`Startup module ${name} contains ${input}. ${hit[1]}`);
    }
  }
}

/** The physical spelling of a path, including a nonexistent tail below its nearest existing ancestor. */
const physical = (input: string): string => {
  let found = resolve(input); const tail: string[] = [];
  while (!existsSync(found)) {
    const parent = dirname(found);
    if (parent === found) return found;
    tail.unshift(basename(found)); found = parent;
  }
  return resolve(realpathSync(found), ...tail);
};

/** Whether `inner` is `outer` or inside it. */
const within = (outer: string, inner: string) => {
  const path = relative(physical(outer), physical(inner));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

/** A directory a build empties must not be the working directory or hold the source entry. */
function assertCleanable(label: string, dir: string, entry: string): void {
  if (physical(dir) === physical(process.cwd())) throw new Error(`${label} must not be the working directory: it is cleaned before building.`);
  if (within(dir, entry)) throw new Error(`${label} must not contain the source entry: it is cleaned before building.`);
}

/** The app's own modules only (packages external): enough to find its generated output and what it imports. */
export const ownModules = async (entry: string): Promise<Metafile> =>
  (await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, packages: "external", format: "esm", platform: "neutral", logLevel: "silent", absWorkingDir: process.cwd() })).metafile;

/**
 * `mantle bundle <entry> <outdir> [--assets <dir>]`: the Worker into `<outdir>/worker`, and Admin into `<assets>/admin`
 * (default `<outdir>/client`) when the Worker serves it (`@aotter/mantle-admin/server`; `/mcp` and the other subpaths alone do not).
 * A server whose generated output records a `bun-*` target runs as TypeScript, so only its Admin is built.
 */
export async function bundleApp(entry: string, outdir: string, assets = join(outdir, "client"), options: { watch?: boolean } = {}): Promise<void> {
  const source = realpathSync(entry);
  // what is cleaned lies under these two, so neither may be the working directory or hold the source
  assertCleanable("Bundle outdir", outdir, source);
  assertCleanable("The assets directory", assets, source);
  const own = await ownModules(entry);
  const worker = join(outdir, "worker");
  // Wrangler uploads every module under the Worker directory and every file under the assets directory.
  const apart = () => {
    if (within(worker, assets) || within(assets, worker)) throw new Error(`The assets directory ${assets} must not overlap the Worker directory ${worker}.`);
  };
  // A watcher (wrangler dev) prints a failed build's whole process object on every change. Refuse stale generated
  // output with one line instead: remove the Worker output, so nothing old or stale can start, and say what to run.
  const refuse = (error: unknown): void => {
    if (!options.watch || !(error instanceof StaleGeneratedError)) throw error;
    apart();
    rmSync(worker, { recursive: true, force: true });
    console.error(`${error.summary} Run your generate script (mantle generate ...). ${worker} is removed, so Wrangler reports its entry missing; a running wrangler dev holds requests and rebuilds when ${error.dir} changes.`);
  };
  let dirs: string[];
  try { dirs = generatedDirs(own); }
  catch (error) { refuse(error); return; }
  if (dirs.some(dir => generatedTarget(join(dir, "generated.ts"))?.startsWith("bun-"))) {
    // Packages are external here, so only the app's own imports of the Admin server are seen; one reached through another package is not.
    if (Object.values(own.inputs).some(input => input.imports.some(imported => /^@aotter\/mantle-admin\/server(?:\/|$)/.test(imported.path)))) await bundleAdmin(source, outdir, join(assets, "admin"));
    else console.warn("note: no Admin built: the entry's own modules do not import @aotter/mantle-admin/server (an import through another package is not seen).");
    return;
  }
  apart();
  let metafile: Metafile;
  // The full build also sees generated output reached through a package, which the check above does not.
  try { metafile = await bundle(entry, worker); }
  catch (error) { refuse(error); return; }
  if (Object.keys(metafile.inputs).some(input => /(?:^|\/)mantle-admin\/(?:dist|src)\/server\/index\.[jt]s$/.test(input.replaceAll("\\", "/")))) {
    await bundleAdmin(source, outdir, join(assets, "admin"));
  }
}

/**
 * Admin from `<dirname(entry)>/admin.tsx`, or the built-in entry; an optional `admin.mcp.tsx` selects the host-safe graph.
 * Uses `@aotter/mantle-admin/build` as the app installed
 * it. The built-in entry is skipped when the installed Admin and its direct dependencies are unchanged since the last
 * build; an application entry always builds, because what it imports is only known by building it.
 */
async function bundleAdmin(entry: string, outdir: string, out: string): Promise<void> {
  const source = join(dirname(entry), "admin.tsx"), custom = existsSync(source);
  const mcpSource = join(dirname(entry), "admin.mcp.tsx"), customMcp = existsSync(mcpSource);
  assertCleanable("The Admin output directory", out, entry);
  const require = createRequire(entry);
  let builder: string;
  try { builder = require.resolve("@aotter/mantle-admin/build"); }
  catch { throw new Error(`The Worker serves Admin, but @aotter/mantle-admin/build does not resolve from ${relative(process.cwd(), entry)}. Install @aotter/mantle-admin at the version of @aotter/mantle-admin/server.`); }
  const stamp = join(outdir, ".admin-inputs");
  // the installed path too: a patched or linked Admin keeps its version but not its path
  const manifest = realpathSync(lookup(require, "@aotter/mantle-admin") ?? require.resolve("@aotter/mantle-admin/package.json"));
  const key = custom || customMcp ? undefined : JSON.stringify({ out: resolve(out), path: dirname(manifest), packages: installed(manifest) });
  if (key && existsSync(join(out, "index.html")) && existsSync(join(out, "mcp-app.html")) && existsSync(stamp) && readFileSync(stamp, "utf8") === key) {
    console.log(`Admin inputs unchanged; kept ${relative(process.cwd(), out)}.`);
    return;
  }
  rmSync(stamp, { force: true });
  const { buildAdmin } = await import(pathToFileURL(builder).href) as { buildAdmin(options: { entry?: string; mcpEntry?: string; outDir: string }): Promise<void> };
  await buildAdmin({ entry: custom ? source : undefined, ...(customMcp ? { mcpEntry: mcpSource } : {}), outDir: out });
  if (key) writeFileSync(stamp, key);
}

/** The package.json a bare import of `name` finds, read from disk (`exports` may hide it, and require caches realpaths). */
const lookup = (require: NodeRequire, name: string) => require.resolve.paths(name)?.map(dir => join(dir, name, "package.json")).find(file => existsSync(file));

/** The package's version and the installed version of each of its dependencies and peers (React comes from the application). */
function installed(manifest: string): Record<string, string | null> {
  const { name, version, dependencies = {}, peerDependencies = {} } = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; version: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
  const require = createRequire(manifest);
  const versions: Record<string, string | null> = { [name]: version };
  for (const dependency of Object.keys({ ...peerDependencies, ...dependencies }).sort()) {
    const found = lookup(require, dependency);
    versions[dependency] = found ? (JSON.parse(readFileSync(found, "utf8")) as { version: string }).version : null;
  }
  return versions;
}

/** Generated output whose recorded inputs changed: a build refuses it until the app generates again. */
export class StaleGeneratedError extends Error {
  readonly summary: string;
  constructor(readonly dir: string, reasons: string[]) {
    const summary = `Generated output in ${dir} is stale (${reasons.join("; ")}).`;
    super(`${summary} Run your generate script (mantle generate ...) and rebuild.`);
    this.summary = summary;
  }
}

/** The generated directories among a build's inputs, refusing stale ones. */
function generatedDirs(metafile: Metafile): string[] {
  const dirs = [...new Set(Object.keys(metafile.inputs).map(input => resolve(input, "..")).filter(dir => existsSync(resolve(dir, INPUTS_FILE))))];
  for (const dir of dirs) {
    const stale = staleInputs(resolve(dir, "generated.ts"));
    if (stale.length) throw new StaleGeneratedError(relative(process.cwd(), dir), stale);
  }
  return dirs;
}

export async function bundle(entry: string, outdir: string): Promise<Metafile> {
  entry = realpathSync(entry);
  assertCleanable("Bundle outdir", outdir, entry);
  rmSync(outdir, { recursive: true, force: true });
  const result = await build({
    entryPoints: [entry], outdir, bundle: true, splitting: true, format: "esm", platform: "neutral",
    conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"], minify: true, metafile: true, chunkNames: "chunks/[name]-[hash]",
    plugins: [{ name: "optional-peers", setup(builder) {
      builder.onResolve({ filter: /^(?:better-auth|@better-auth\/(?:core|oauth-provider)|@modelcontextprotocol\/server)(?:\/|$)/ }, async args => {
        if (args.pluginData?.optionalPeer) return;
        const resolved = await builder.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind, pluginData: { optionalPeer: true } });
        // Unselected request paths may reference absent peers; installed peers still bundle normally.
        return resolved.errors.length ? { path: args.path, external: true } : resolved;
      });
    } }],
  });
  if (Object.keys(result.metafile.inputs).some(input => /(?:^|\/)mantle\/(?:src|dist)\/testing\//.test(resolve(input).replaceAll("\\", "/"))))
    throw new Error("@aotter/mantle/testing is only for tests and cannot be bundled for production.");
  // A build is what `wrangler dev` and deploys run: generated code must match the manifests it came from.
  // Any bundled module from a generated directory finds its fingerprint (type-only imports leave generated.ts out).
  generatedDirs(result.metafile);
  const appSources = Object.keys(result.metafile.inputs).filter(input => !/node_modules|(?:^|\/)generated\/|^\.\.\//.test(input) && /\.[cm]?[jt]s$/.test(input)).map(input => [input, readFileSync(input, "utf8")] as const);
  for (const [input, source] of appSources) {
    const tables = authTableSql(source);
    if (tables.length) console.warn(`note: ${input} queries Better Auth's ${tables.join(", ")} table with SQL. Read users through userOf(caller) or readIdentity(auth) (@aotter/mantle/auth, @aotter/mantle/auth/identity), which follow each instance's table mapping and ban state.`);
  }
  const roles = appSources.flatMap(([, source]) => extraRoles(source));
  if (roles.length) console.warn(`note: Better Auth roles beyond admin and user: ${[...new Set(roles)].join(", ")}. Mantle grants by the admin layer and app code; keep extra roles only if the app needs them.`);
  guardStartup(result.metafile, entry);
  return result.metafile;
}
