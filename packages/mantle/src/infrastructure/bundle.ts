import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build, version as esbuildVersion, type Metafile } from "esbuild";
import type { ClientAsset } from "../kernel/client-assets.js";
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
  for (const [name, output] of Object.entries(metafile.outputs))
    if (output.entryPoint && resolve(output.entryPoint) === resolve(entry)) visit(name);
  return [...visited];
}

/**
 * esbuild emits a chunk for every `import()` it reads, also one whose caller tree shaking removed (an unused
 * `mediaUploadCard`), and Wrangler uploads every module under the Worker directory. Deletes the JavaScript outputs that
 * no static or dynamic import from the entry reaches, from disk and from the metafile, and names them in one line. An
 * import graph it cannot read fails the build before anything is deleted.
 */
export function pruneUnreachable(metafile: Metafile, entry: string): void {
  const unreadable = (problem: string) =>
    new Error(
      `mantle bundle cannot tell which chunks the Worker imports: ${problem}. Nothing was removed and the build failed. Build with the esbuild version @aotter/mantle depends on (this is esbuild ${esbuildVersion}), or report this message to Mantle.`,
    );
  const reached = new Set<string>();
  const visit = (name: string, importer?: string) => {
    const output = metafile.outputs[name];
    if (!output) throw unreadable(`${importer} imports ${name}, which esbuild's metafile does not list as an output`);
    if (reached.has(name)) return;
    reached.add(name);
    for (const imported of output.imports) if (!imported.external) visit(imported.path, name);
  };
  const roots = Object.keys(metafile.outputs).filter(name => {
    const output = metafile.outputs[name]!;
    return name.endsWith(".js") && output.entryPoint && physical(output.entryPoint) === physical(entry);
  });
  if (roots.length !== 1)
    throw unreadable(`esbuild's metafile lists ${roots.length} JavaScript outputs for the entry ${entry}, not one`);
  visit(roots[0]!);
  const removed = Object.keys(metafile.outputs).filter(name => name.endsWith(".js") && !reached.has(name));
  if (!removed.length) return;
  const bytes = removed.reduce((total, name) => total + metafile.outputs[name]!.bytes, 0);
  for (const name of removed) {
    rmSync(resolve(name));
    delete metafile.outputs[name];
  }
  console.log(
    `Removed ${removed.length} chunk(s) (${bytes} B) no import from the entry reaches: ${removed.map(name => basename(name)).join(", ")}.`,
  );
}

const refused: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /(?:^|\/)node_modules\/(?:better-auth(?:\/|$)|@better-auth\/)/,
    "Load it through authLoader(() => import(...)) to keep Better Auth out of startup.",
  ],
  [/(?:^|\/)node_modules\/@modelcontextprotocol\//, "Load MCP through a request-time import(...)."],
  // the compiler: the package's own generator layers (installed, or workspace dist/source) and its parser, YAML and SQL dependencies
  [
    /(?:^|\/)node_modules\/(?:@aotter\/mantle\/dist\/(?:build|infrastructure)\/|yaml\/|pgsql-deparser\/|libpg-query\/)|(?:^|\/)mantle\/(?:dist|src)\/(?:build|infrastructure)\//,
    "Generator code must not run in a Worker; import runtime entry points such as @aotter/mantle/rest.",
  ],
  // Admin's UI is built into <assets>/admin by the app's admin.tsx; the Worker serves it, never runs it.
  [
    /(?:^|\/)node_modules\/@aotter\/mantle-admin\/dist\/admin-app\/|(?:^|\/)mantle-admin\/(?:dist\/admin-app|admin\/src)\//,
    "Admin's UI (@aotter/mantle-admin/app, /hooks) runs in the browser: import it only from src/admin.tsx, which `mantle bundle` builds into the assets directory.",
  ],
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
  let found = resolve(input);
  const tail: string[] = [];
  while (!existsSync(found)) {
    const parent = dirname(found);
    if (parent === found) return found;
    tail.unshift(basename(found));
    found = parent;
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
  if (physical(dir) === physical(process.cwd()))
    throw new Error(`${label} must not be the working directory: it is cleaned before building.`);
  if (within(dir, entry)) throw new Error(`${label} must not contain the source entry: it is cleaned before building.`);
}

/** The app's own modules only (packages external): enough to find its generated output and what it imports. */
export const ownModules = async (entry: string): Promise<Metafile> =>
  (
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      packages: "external",
      format: "esm",
      platform: "neutral",
      logLevel: "silent",
      absWorkingDir: process.cwd(),
    })
  ).metafile;

/**
 * `mantle bundle <entry> <outdir> [--assets <dir>]`: the Worker into `<outdir>/worker`, and Admin into `<assets>/admin`
 * (default `<outdir>/client`) when the Worker serves it (`@aotter/mantle-admin/server`; `/mcp` and the other subpaths alone do not).
 * A server whose generated output records a `bun-*` target runs as TypeScript, so only its Admin is built.
 */
export async function bundleApp(
  entry: string,
  outdir: string,
  assets = join(outdir, "client"),
  options: { watch?: boolean } = {},
): Promise<void> {
  const source = realpathSync(entry);
  // what is cleaned lies under these two, so neither may be the working directory or hold the source
  assertCleanable("Bundle outdir", outdir, source);
  assertCleanable("The assets directory", assets, source);
  const own = await ownModules(entry);
  const worker = join(outdir, "worker");
  // Wrangler uploads every module under the Worker directory and every file under the assets directory.
  const apart = () => {
    if (within(worker, assets) || within(assets, worker))
      throw new Error(`The assets directory ${assets} must not overlap the Worker directory ${worker}.`);
  };
  // A watcher (wrangler dev) prints a failed build's whole process object on every change. Refuse stale generated
  // output with one line instead: remove the Worker output, so nothing old or stale can start, and say what to run.
  const refuse = (error: unknown): void => {
    if (!options.watch || !(error instanceof StaleGeneratedError)) throw error;
    apart();
    rmSync(worker, { recursive: true, force: true });
    console.error(
      `${error.summary} Run your generate script (mantle generate ...). ${worker} is removed, so Wrangler reports its entry missing; a running wrangler dev holds requests and rebuilds when ${error.dir} changes.`,
    );
  };
  let dirs: string[];
  try {
    dirs = generatedDirs(own);
  } catch (error) {
    refuse(error);
    return;
  }
  apart();
  const clientEntries = clientEntryFiles(source);
  const client = join(assets, CLIENT_DIR);
  const ownsClient = cleanClient(outdir, assets, source, clientEntries.length > 0);
  // before copyPublic, which would otherwise copy the app's file into the directory the build then empties
  if (clientEntries.length && existsSync(join("public", CLIENT_DIR)))
    throw new Error(
      `public/${CLIENT_DIR} is reserved for the browser entries in ${relative(process.cwd(), join(dirname(source), "client"))}; move those files elsewhere under public/.`,
    );
  const copied = copyPublic(outdir, assets);
  // A `bun-*` server runs as TypeScript: nothing gives it the map, so its build writes no hashed copies (Workers only).
  const bun = dirs.some(dir => generatedTarget(join(dir, "generated.ts"))?.startsWith("bun-"));
  const hashed = await bundleClient(clientEntries, client, outdir, ownsClient, !bun);
  if (bun) {
    // Packages are external here, so only the app's own imports of the Admin server are seen; one reached through another package is not.
    if (
      Object.values(own.inputs).some(input =>
        input.imports.some(imported => /^@aotter\/mantle-admin\/server(?:\/|$)/.test(imported.path)),
      )
    )
      await bundleAdmin(source, outdir, join(assets, "admin"));
    else
      console.warn(
        "note: no Admin built: the entry's own modules do not import @aotter/mantle-admin/server (an import through another package is not seen).",
      );
    return;
  }
  apart();
  let metafile: Metafile;
  // The full build also sees generated output reached through a package, which the check above does not.
  try {
    metafile = await bundle(entry, worker, hashed);
  } catch (error) {
    refuse(error);
    return;
  }
  const admin = Object.keys(metafile.inputs).some(input =>
    /(?:^|\/)mantle-admin\/(?:dist|src)\/server\/index\.[jt]s$/.test(input.replaceAll("\\", "/")),
  );
  if (admin) await bundleAdmin(source, outdir, join(assets, "admin"));
  assetHeaders(assets, copied.includes("_headers"), [
    ...(admin ? [adminRule] : []),
    ...(Object.keys(hashed).length ? [hashedRule] : []),
  ]);
}

/** Where the application's browser entries are written, under the assets directory (served at `/assets/client/<name>.js`). */
const CLIENT_DIR = join("assets", "client");
/** Their content-hashed copies, in a directory of their own because `_headers` matches by path. */
const HASHED = "/assets/client/h/";

/**
 * The browser entries: `.ts` and `.tsx` files directly in `client/` beside the Worker entry (subdirectories hold their
 * helpers). Dotfiles, declaration files and `*.test.*` / `*.spec.*` files are not entries. A name every object already
 * has (`constructor`, `__proto__`, `toString`) is refused, so `clientAssets[name]` is only ever an entry or undefined.
 */
function clientEntryFiles(source: string): string[] {
  const dir = join(dirname(source), "client");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir, { withFileTypes: true })
    .filter(
      entry =>
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !entry.name.startsWith(".") &&
        !/\.d\.ts$|\.(?:test|spec)\.tsx?$/.test(entry.name),
    )
    .map(entry => entry.name)
    .sort();
  // compared without case: `B.ts` and `b.ts` are one file on a case-insensitive filesystem
  const seen = new Map<string, string>();
  for (const file of files) {
    const name = file.replace(/\.tsx?$/, "");
    if (name in Object.prototype)
      throw new Error(
        `${relative(process.cwd(), join(dir, file))}: every JavaScript object has "${name}", so it cannot name a browser entry in @aotter/mantle/client-assets; rename the file.`,
      );
    const key = name.toLowerCase(),
      other = seen.get(key);
    if (other)
      throw new Error(
        `${relative(process.cwd(), dir)} has ${other} and ${file}: both would be built to ${key}.js (names are compared without case).`,
      );
    seen.set(key, file);
  }
  return files.map(file => join(dir, file));
}

/**
 * Whether `<assets>/assets/client` is the directory the previous build wrote. With entries, `bundleClient` overwrites it
 * and then removes what it did not write; with none left, it is removed here, so a deleted entry is not served again.
 * The record `<outdir>/.mantle-client` is trusted only when it names exactly this build's `<assets>/assets/client`; an
 * unreadable record or any other path is ignored and never deleted.
 */
function cleanClient(outdir: string, assets: string, source: string, entries: boolean): boolean {
  const record = join(outdir, ".mantle-client");
  if (!existsSync(record)) return false;
  let dir: unknown;
  try {
    ({ dir } = JSON.parse(readFileSync(record, "utf8")) as { dir?: unknown });
  } catch {}
  rmSync(record, { force: true });
  const own = join(assets, CLIENT_DIR);
  if (typeof dir !== "string" || physical(dir) !== physical(own) || !within(own, dir)) return false;
  assertCleanable("The browser entry output directory", own, source);
  if (!entries) rmSync(own, { recursive: true, force: true });
  return entries;
}

/**
 * Application seam: applications depend on this. Do not remove or narrow it because Core has no internal use (CONTRIBUTING.md, "Application seams").
 * `mantle bundle` builds each browser entry (`client/<name>.ts|tsx` beside the Worker entry) into `<assets>/assets/client/<name>.js`:
 * one minified ES2022 browser file per entry, `react` resolved from the application, no source map, stable name.
 * With `hash` (a Worker), also a content-hashed copy of each file under `<assets>/assets/client/h/`; returns their
 * paths by entry name, the map `@aotter/mantle/client-assets` gives the Worker. `owned`: `out` is the previous build's.
 * It is overwritten in place and only then are the files this build did not write removed, so a name both builds have
 * never disappears while a build runs (a request then, under `wrangler dev`, would get a 404 the browser caches).
 */
async function bundleClient(
  entries: string[],
  out: string,
  outdir: string,
  owned: boolean,
  hash: boolean,
): Promise<Record<string, ClientAsset>> {
  if (!entries.length) return {};
  if (!owned && existsSync(out))
    throw new Error(
      `${relative(process.cwd(), out)} exists and was not written by mantle bundle; it is reserved for the browser entries.`,
    );
  assertCleanable("The browser entry output directory", out, entries[0]!);
  // recorded first: a build that fails halfway is cleaned by the next one
  mkdirSync(outdir, { recursive: true });
  writeFileSync(join(outdir, ".mantle-client"), JSON.stringify({ dir: resolve(out) }));
  const { metafile } = await build({
    entryPoints: entries,
    outdir: out,
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
    absWorkingDir: process.cwd(),
    metafile: true,
  });
  const written = new Set(Object.keys(metafile.outputs).map(file => resolve(file)));
  // The hash is of the file alone: the browser files never name each other, so the order does not matter. A name is
  // its content, so a copy already there with the same bytes is left as it is.
  const copy = (file: string) => {
    const bytes = readFileSync(file),
      extension = extname(file);
    const name = `${basename(file, extension)}-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}${extension}`;
    const target = join(out, "h", name);
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) writeFileSync(target, bytes);
    written.add(resolve(target));
    return HASHED + name;
  };
  const hashed: Record<string, ClientAsset> = {};
  if (hash) {
    mkdirSync(join(out, "h"), { recursive: true });
    // code-unit order, the same on every machine (localeCompare follows the build machine's locale)
    for (const [file, output] of Object.entries(metafile.outputs).sort(([a], [b]) => (a < b ? -1 : 1)))
      if (output.entryPoint)
        hashed[basename(file, ".js")] = {
          js: copy(file),
          ...(output.cssBundle ? { css: copy(output.cssBundle) } : {}),
        };
  }
  // after writing: what an earlier build wrote and this one did not (a deleted entry, a previous hashed copy)
  for (const entry of readdirSync(out, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    if (!entry.isDirectory() && !written.has(resolve(entry.parentPath, entry.name)))
      rmSync(join(entry.parentPath, entry.name));
  if (!hash) rmSync(join(out, "h"), { recursive: true, force: true });
  warnClientAssets(metafile);
  return hashed;
}

/**
 * `@aotter/mantle/client-assets` is the Worker's: in a browser file it is the package's empty map. Warns when a browser
 * file still holds it after tree shaking; an import that reaches it only through a module whose use of it is removed
 * (a page component imported for its types or another export) holds nothing of it.
 */
function warnClientAssets(metafile: Metafile): void {
  for (const [file, output] of Object.entries(metafile.outputs))
    if (
      Object.entries(output.inputs).some(
        ([input, { bytesInOutput }]) =>
          bytesInOutput > 0 &&
          /(?:^|\/)mantle\/(?:dist|src)\/kernel\/client-assets\.[jt]s$/.test(input.replaceAll("\\", "/")),
      )
    )
      console.warn(
        `note: ${relative(process.cwd(), file)} uses @aotter/mantle/client-assets, which is empty in a browser file: mantle bundle gives the map only to the Worker. Write the hashed URL into the HTML the Worker renders instead.`,
      );
}

/**
 * The app's own static files: `public/` in the working directory is copied into the assets directory, so
 * `public/assets/logo.svg` is served at `/assets/logo.svg`. Files copied by the previous build are removed first (the
 * list lives in `<outdir>/.mantle-public`, outside the uploaded assets), so a deleted file is not served again; files
 * that another build step wrote into the assets directory are left alone. `public/admin` is refused: Admin owns it.
 * When the assets directory is `public/` itself (`--assets public`) or overlaps it, nothing is copied: the files are
 * already where Wrangler uploads them. Returns the paths it copied.
 */
function copyPublic(outdir: string, assets: string): string[] {
  const record = join(outdir, ".mantle-public"),
    source = resolve("public"),
    target = resolve(assets);
  if (existsSync(record)) {
    const previous = JSON.parse(readFileSync(record, "utf8")) as { assets: string; files: string[] };
    // only from the directory they were copied to: a changed --assets never touches the new directory's own files
    if (previous.assets === target) for (const path of previous.files) rmSync(join(assets, path), { force: true });
  }
  if (!existsSync(source) || within(source, target) || within(target, source)) {
    rmSync(record, { force: true });
    return [];
  }
  if (existsSync(join(source, "admin")))
    throw new Error("public/admin is reserved for Admin's build; move those files elsewhere under public/.");
  const files = (readdirSync(source, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter(entry => entry.isFile() || entry.isSymbolicLink())
    .map(entry => relative(source, join(entry.parentPath, entry.name)));
  cpSync(source, assets, { recursive: true });
  mkdirSync(outdir, { recursive: true });
  writeFileSync(record, JSON.stringify({ assets: target, files }));
  return files;
}

/** Admin's chunks are content-hashed and answered by the edge (`run_worker_first` excludes `/admin/assets/*`), so the
 * headers `adminShell` would add live in `_headers`. One day, not a year: the edge sends the rule on its own 404 for a
 * missing chunk too, and a browser keeps that 404 for as long as the rule says (#2088). `immutable` stays so a reload
 * does not revalidate the chunks while they are fresh. */
const adminRule =
  "/admin/assets/*\n  X-Content-Type-Options: nosniff\n  Cache-Control: public, max-age=86400, immutable\n";
/** The browser entries' hashed copies: one day, as Admin's chunks and for the same reason (ADR-lite #2097): the edge
 * sends the rule on its 404 too, which a request during a deploy's propagation or a rebuild can get for a current name.
 * `! Cache-Control` drops a broader rule's value, which `_headers` would otherwise join to this one. */
const hashedRule = `${HASHED}*\n  ! Cache-Control\n  Cache-Control: public, max-age=86400, immutable\n`;
/** What only `mantle bundle` writes, including the one-year Admin rule an earlier build wrote (#2088). */
const ownRules = [adminRule, adminRule.replace("86400", "31536000"), hashedRule].map(rule => rule.trim());

/** `<assets>/_headers` with this build's rules. A file made only of rules `mantle bundle` writes is its own and is
 * rewritten (nothing removes it between builds). A `_headers` copied from `public/` this build gets the missing rules
 * appended to the copy (the next build copies it afresh); `public/_headers` itself, or one another step wrote, is only
 * told them. A rule whose path the file already names is the application's and is kept as it is. With no rules, a file
 * of its own outside `public/` is removed (an earlier build's rules no longer apply). */
function assetHeaders(assets: string, copied: boolean, rules: string[]): void {
  const file = join(assets, "_headers");
  if (!existsSync(file)) {
    if (rules.length) writeFileSync(file, rules.join("\n"));
    return;
  }
  const text = readFileSync(file, "utf8");
  if (
    !copied &&
    text
      .trim()
      .split(/\n\s*\n/)
      .every(block => ownRules.includes(block.trim()))
  ) {
    // never public/_headers itself (`--assets public`), which may hold a rule the application copied from the note below
    if (!rules.length) {
      if (!within(resolve("public"), assets) && !within(assets, resolve("public"))) rmSync(file);
    } else if (text !== rules.join("\n")) writeFileSync(file, rules.join("\n"));
    return;
  }
  if (!rules.length) return;
  const missing = rules.filter(rule => !text.includes(rule.slice(0, rule.indexOf("\n"))));
  if (!missing.length) return;
  const paths = missing.map(rule => rule.slice(0, rule.indexOf("\n"))).join(" and ");
  if (!copied)
    return console.warn(`note: ${relative(process.cwd(), file)} has no ${paths} rule; add:\n${missing.join("\n")}`);
  rmSync(file); // a copied symlink would write through to public/
  writeFileSync(file, `${text.trimEnd()}\n\n${missing.join("\n")}`);
  console.log(`Appended the ${paths} rule to ${relative(process.cwd(), file)}; public/_headers is unchanged.`);
}

/**
 * Admin from `<dirname(entry)>/admin.tsx`, or the built-in entry; an optional `admin.mcp.tsx` selects the host-safe graph.
 * Uses `@aotter/mantle-admin/build` as the app installed
 * it. The built-in entry is skipped when the installed Admin and its direct dependencies are unchanged since the last
 * build; an application entry always builds, because what it imports is only known by building it.
 */
async function bundleAdmin(entry: string, outdir: string, out: string): Promise<void> {
  const source = join(dirname(entry), "admin.tsx"),
    custom = existsSync(source);
  const mcpSource = join(dirname(entry), "admin.mcp.tsx"),
    customMcp = existsSync(mcpSource);
  assertCleanable("The Admin output directory", out, entry);
  const require = createRequire(entry);
  let builder: string;
  try {
    builder = require.resolve("@aotter/mantle-admin/build");
  } catch {
    throw new Error(
      `The Worker serves Admin, but @aotter/mantle-admin/build does not resolve from ${relative(process.cwd(), entry)}. Install @aotter/mantle-admin at the version of @aotter/mantle-admin/server.`,
    );
  }
  const stamp = join(outdir, ".admin-inputs");
  // the installed path too: a patched or linked Admin keeps its version but not its path
  const manifest = realpathSync(
    lookup(require, "@aotter/mantle-admin") ?? require.resolve("@aotter/mantle-admin/package.json"),
  );
  const key =
    custom || customMcp
      ? undefined
      : JSON.stringify({ out: resolve(out), path: dirname(manifest), packages: installed(manifest) });
  if (
    key &&
    existsSync(join(out, "index.html")) &&
    existsSync(join(out, "mcp-app.html")) &&
    existsSync(stamp) &&
    readFileSync(stamp, "utf8") === key
  ) {
    console.log(`Admin inputs unchanged; kept ${relative(process.cwd(), out)}.`);
    return;
  }
  rmSync(stamp, { force: true });
  const { buildAdmin } = (await import(pathToFileURL(builder).href)) as {
    buildAdmin(options: { entry?: string; mcpEntry?: string; outDir: string }): Promise<void>;
  };
  await buildAdmin({ entry: custom ? source : undefined, ...(customMcp ? { mcpEntry: mcpSource } : {}), outDir: out });
  if (key) writeFileSync(stamp, key);
}

/** The package.json a bare import of `name` finds, read from disk (`exports` may hide it, and require caches realpaths). */
const lookup = (require: NodeRequire, name: string) =>
  require.resolve
    .paths(name)
    ?.map(dir => join(dir, name, "package.json"))
    .find(file => existsSync(file));

/** The package's version and the installed version of each of its dependencies and peers (React comes from the application). */
function installed(manifest: string): Record<string, string | null> {
  const {
    name,
    version,
    dependencies = {},
    peerDependencies = {},
  } = JSON.parse(readFileSync(manifest, "utf8")) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
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
  constructor(
    readonly dir: string,
    reasons: string[],
  ) {
    const summary = `Generated output in ${dir} is stale (${reasons.join("; ")}).`;
    super(`${summary} Run your generate script (mantle generate ...) and rebuild.`);
    this.summary = summary;
  }
}

/** The generated directories among a build's inputs, refusing stale ones. */
function generatedDirs(metafile: Metafile): string[] {
  const dirs = [
    ...new Set(
      Object.keys(metafile.inputs)
        .map(input => resolve(input, ".."))
        .filter(dir => existsSync(resolve(dir, INPUTS_FILE))),
    ),
  ];
  for (const dir of dirs) {
    const stale = staleInputs(resolve(dir, "generated.ts"));
    if (stale.length) throw new StaleGeneratedError(relative(process.cwd(), dir), stale);
  }
  return dirs;
}

/** `clientAssets`: what `@aotter/mantle/client-assets` exports in this Worker (`bundleClient`'s map). */
export async function bundle(
  entry: string,
  outdir: string,
  clientAssets: Record<string, ClientAsset> = {},
): Promise<Metafile> {
  entry = realpathSync(entry);
  assertCleanable("Bundle outdir", outdir, entry);
  rmSync(outdir, { recursive: true, force: true });
  const result = await build({
    absWorkingDir: process.cwd(),
    entryPoints: [entry],
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    // workerd leaves process.env.NODE_ENV undefined, so packages such as react-dom would otherwise ship their development build
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
    metafile: true,
    chunkNames: "chunks/[name]-[hash]",
    plugins: [
      {
        // An application that does not import it bundles nothing of it.
        name: "client-assets",
        setup(builder) {
          builder.onResolve({ filter: /^@aotter\/mantle\/client-assets$/ }, () => ({
            path: "client-assets",
            namespace: "mantle-client-assets",
          }));
          builder.onLoad({ filter: /.*/, namespace: "mantle-client-assets" }, () => ({
            contents: `export const clientAssets = ${JSON.stringify(clientAssets)};`,
            loader: "js",
          }));
        },
      },
      {
        name: "optional-peers",
        setup(builder) {
          builder.onResolve(
            { filter: /^(?:better-auth|@better-auth\/(?:core|oauth-provider)|@modelcontextprotocol\/server)(?:\/|$)/ },
            async args => {
              if (args.pluginData?.optionalPeer) return;
              const resolved = await builder.resolve(args.path, {
                importer: args.importer,
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: { optionalPeer: true },
              });
              // Unselected request paths may reference absent peers; installed peers still bundle normally.
              return resolved.errors.length ? { path: args.path, external: true } : resolved;
            },
          );
        },
      },
    ],
  });
  pruneUnreachable(result.metafile, entry);
  if (
    Object.keys(result.metafile.inputs).some(input =>
      /(?:^|\/)mantle\/(?:src|dist)\/testing\//.test(resolve(input).replaceAll("\\", "/")),
    )
  )
    throw new Error("@aotter/mantle/testing is only for tests and cannot be bundled for production.");
  // A build is what `wrangler dev` and deploys run: generated code must match the manifests it came from.
  // Any bundled module from a generated directory finds its fingerprint (type-only imports leave generated.ts out).
  generatedDirs(result.metafile);
  const appSources = Object.keys(result.metafile.inputs)
    .filter(input => !/node_modules|(?:^|\/)generated\/|^\.\.\//.test(input) && /\.[cm]?[jt]s$/.test(input))
    .map(input => [input, readFileSync(input, "utf8")] as const);
  for (const [input, source] of appSources) {
    const tables = authTableSql(source);
    if (tables.length)
      console.warn(
        `note: ${input} queries Better Auth's ${tables.join(", ")} table with SQL. Read users through userOf(caller) or readIdentity(auth) (@aotter/mantle/auth, @aotter/mantle/auth/identity), which follow each instance's table mapping and ban state.`,
      );
  }
  const roles = appSources.flatMap(([, source]) => extraRoles(source));
  if (roles.length)
    console.warn(
      `note: Better Auth roles beyond admin and user: ${[...new Set(roles)].join(", ")}. Mantle grants by the admin layer and app code; keep extra roles only if the app needs them.`,
    );
  guardStartup(result.metafile, entry);
  return result.metafile;
}
