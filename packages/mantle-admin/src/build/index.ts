/// <reference types="node" />
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { InlineConfig, Plugin, PluginOption } from "vite";
import { checkMcpApp, cspProblems, GUIDE, hitsOf, type McpCsp, type Source } from "./mcp-check.js";
import { PREVIEW_CSP } from "./preview-csp.js";

const dist = resolve(import.meta.dirname, "..");
/** The page template: index.html, main.js, styles.css and the public files (theme, icons, preview bridge). */
const page = resolve(dist, "admin-build");
const ENTRY = "virtual:mantle-admin/entry";

export interface BuildAdminOptions {
  /** The application's Admin entry, which default-exports `defineAdmin(...)`. The built-in entry when omitted. */
  readonly entry?: string;
  /** Optional host-safe entry, also default-exporting `defineAdmin(...)`. Defaults to `entry`; it must not import browser-only implementations. */
  readonly mcpEntry?: string;
  /** Where Admin's static files go, served at `/admin/`: `<assets>/admin`. It is emptied first. */
  readonly outDir: string;
}

/**
 * `react-dom` runs only beside the exact `react` it was released with, and the application owns both (Admin takes them as
 * peers). Two installs that drifted (`^` ranges resolved apart) would otherwise surface as React error #527 in the browser.
 * Both are read from where the application's Admin code resolves them.
 */
function assertReactMatch(from: string): void {
  const require = createRequire(resolve(from, "noop.js"));
  const read = (name: string) => {
    try { return (JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")) as { version: string }).version; }
    catch { throw new Error(`Admin needs ${name}, but it does not resolve from ${from}. Install react and react-dom in the application, both at the same exact version.`); }
  };
  const [react, reactDom] = [read("react"), read("react-dom")];
  if (react !== reactDom) throw new Error(`react ${react} and react-dom ${reactDom} are installed; Admin needs the same version of both (React error #527). Pin both to one exact version in the application's package.json, e.g. "react": "${reactDom}" and "react-dom": "${reactDom}", then reinstall.`);
}

/**
 * What a build and the dev server share: the entry resolved, Admin's and the application's classes seen by Tailwind, and
 * React's JSX whatever `jsxImportSource` the application's tsconfig sets for its Worker. `mcp` is the MCP App's build: its own
 * stylesheet, and Tailwind sees only the code the App runs.
 */
async function adminCore(entry: string | undefined, mcp = false) {
  const [{ normalizePath }, { default: react }, { default: tailwindcss }] = await Promise.all([import("vite"), import("@vitejs/plugin-react"), import("@tailwindcss/vite")]);
  const app = resolve(entry ?? resolve(dist, "admin-app/default-entry.js"));
  // where the application's code finds React, and where Vite bundles it from (Admin's own location)
  for (const from of new Set([...(entry ? [dirname(app)] : []), page])) assertReactMatch(from);
  const kit = resolve(dirname(createRequire(import.meta.url).resolve("@aotter/mantle-ui/package.json")), "dist");
  // Tailwind generates the classes Admin, the kit and the application's own Admin code use; the App's own code is one file.
  // the App renders the shared components, the fields and a few controls of the kit, not all of it
  const appKit = ["react/components.js", "react/fields.js", "kit/components/ui/{button,checkbox,input,popover,select,textarea}.js"].map(file => resolve(kit, file));
  const sources = [...(mcp ? [resolve(dist, "admin-app/mcp-mount.js"), ...appKit] : [resolve(dist, "admin-app"), kit]), ...(entry ? [dirname(app)] : [])].map(source => `@source ${JSON.stringify(source)};`).join("\n");
  const stylesheet = normalizePath(resolve(page, mcp ? "mcp-styles.css" : "styles.css"));
  const entryPlugin: Plugin = {
    name: "mantle-admin-entry", enforce: "pre",
    resolveId: id => id === ENTRY ? app : undefined,
    // Vite ids use forward slashes on every platform
    transform: (code, id) => normalizePath(id.split("?")[0]!) === stylesheet ? `${code}\n${sources}\n` : undefined,
  };
  const plugins: PluginOption[] = [entryPlugin, react(), tailwindcss()];
  return {
    app,
    kit,
    plugins,
    // what evaluates the entry in Node: no styles
    scripting: [entryPlugin, react()] as PluginOption[],
    // what the dev server may serve: Admin and the kit, wherever the package manager put them, and the application
    allow: [page, dist, kit, dirname(app), process.cwd()],
    config: {
      root: page, configFile: false, publicDir: resolve(page, "public"),
      resolve: { dedupe: ["react", "react-dom"] },
      // Admin's own settings, not the application's: no postcss.config.* found above the installed package
      css: { postcss: {} }, oxc: { jsx: { runtime: "automatic", importSource: "react" } },
    } satisfies InlineConfig,
  };
}

/**
 * Build Admin with Vite into `outDir`: the shell (`index.html`), the same-origin preview document (`preview.html`) and
 * its `host-bridge.js`, hashed assets, and the MCP App as one file (`mcp-app.html`), checked for what a host refuses.
 * The App uses `mcpEntry` when supplied, otherwise the same entry. `mantle bundle` calls this; it is not a CLI.
 */
export async function buildAdmin({ entry, mcpEntry, outDir }: BuildAdminOptions): Promise<void> {
  const { build } = await import("vite");
  const { plugins, config } = await adminCore(entry);
  outDir = resolve(outDir);
  await build({ ...config, base: "./", logLevel: "warn", plugins: [...plugins, previewDocument(outDir)], build: { outDir, emptyOutDir: true } });
  await buildMcpApp(mcpEntry ?? entry, outDir, mcpEntry !== undefined);
}

const NATIVE_CALENDAR = "\0mantle-admin/native-calendar";

/**
 * The App a host renders, from the application's own entry: its components in the `mcp-app` surface, its pages that declare
 * `mcp`, its CSS, in one file with no file beside it. `@aotter/mantle-admin/app` resolves to the entry without `<MantleAdmin>`, so
 * the browser's `/admin/api` transport is not reachable, and the result is checked (`checkMcpApp`): a build that a host would
 * break fails here, naming the module.
 */
async function buildMcpApp(entry: string | undefined, outDir: string, explicitEntry = false): Promise<void> {
  const [{ build, normalizePath }, { viteSingleFile }] = await Promise.all([import("vite"), import("vite-plugin-singlefile")]);
  const core = await adminCore(entry, true);
  const mount = resolve(dist, "admin-app/mcp-mount.js");
  const { csp, sources: slots, manifest, idle, problem } = await readDefinition(core);
  const fix = "The entry is imported in Node to read its definition; code that touches window or document at import must move into components or effects.";
  if (problem) {
    console.warn(`warning: Admin MCP App: ${entry ?? "the built-in entry"} ${problem}. ${fix}`);
    // what the entry declares must not vanish because it could not be read: the CSP, the components and pages the compatibility test
    // is to run, the plugins that add components
    const declares = entry ? /\b(csp|components|plugins|pages|mcp)\s*:/.exec(readFileSync(entry, "utf8"))?.[1] : undefined;
    if (entry && (explicitEntry || declares)) throw new Error(`The Admin MCP App cannot be built: ${entry}${declares ? ` declares ${declares}, but` : ":"} ${problem}. The build fails rather than drop it. ${fix}\nSee ${GUIDE}.`);
  }
  if (idle.length) console.warn(`warning: Admin MCP App: ${idle.join(", ")} ${idle.length === 1 ? "is a browser-only slot" : "are browser-only slots"} (the App renders cell:view: slots and pages[].mcp), so ${idle.length === 1 ? "this override runs" : "these overrides run"} in the browser Admin only.`);
  const invalid = cspProblems(csp);
  if (invalid.length) throw new Error(`The Admin MCP App cannot be built:\n${invalid.map(line => `  - ${line}`).join("\n")}\nSee ${GUIDE}.`);
  const sources: Source[] = [...slots];
  // each module the App is made of, as it is when bundled: the one that is named when the output breaks a rule
  const scan: Plugin = {
    name: "mantle-mcp-app-scan", enforce: "post",
    transform(code, id) {
      const hits = hitsOf(code);
      if (hits.length && !id.startsWith("\0")) sources.push({ module: normalizePath(id.split("?")[0]!), hits });
      return undefined;
    },
  };
  const replace: Plugin = {
    name: "mantle-mcp-app-replace", enforce: "pre",
    async resolveId(source, importer, options) {
      const from = importer ? normalizePath(importer) : "";
      // the App swaps the kit's calendar for a native date input
      if (source === "../kit/components/ui/calendar.js" && from.endsWith("/mantle-ui/dist/react/fields.js")) return NATIVE_CALENDAR;
      // and the public entry for the one without `<MantleAdmin>`, however the application reaches it
      if (!/mantle-admin|admin-app\/index\.js$/.test(source)) return undefined;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && normalizePath(resolved.id) === normalizePath(resolve(dist, "admin-app/index.js")) ? resolve(dist, "admin-app/mcp-app.js") : undefined;
    },
    load: id => id === NATIVE_CALENDAR ? `export { Calendar } from ${JSON.stringify(mount)};` : undefined,
  };
  const built = await build({
    ...core.config, base: "./", logLevel: "warn", plugins: [...core.plugins, replace, scan, viteSingleFile()],
    build: { write: false, copyPublicDir: false, rollupOptions: { input: resolve(page, "mcp-app.html") } },
  });
  const asset = (Array.isArray(built) ? built.flatMap(each => each.output) : "output" in built ? built.output : []).find(file => file.type === "asset" && file.fileName === "mcp-app.html");
  if (!asset || asset.type !== "asset") throw new Error("The Admin MCP App was not built.");
  const html = String(asset.source);
  const { errors, warnings } = checkMcpApp(html, csp, sources, { libraries: [resolve(dist, "admin-app"), core.kit].map(normalizePath) });
  for (const warning of warnings) console.warn(`warning: Admin MCP App: ${warning}`);
  if (errors.length) throw new Error(`The Admin MCP App would break in an MCP host:\n${errors.map(line => `  - ${line}`).join("\n")}\nSee ${GUIDE}.`);
  // the declared CSP rides in the file, so the server sends it with the HTML (`adminMcpApps`) and it is declared once
  const escape = (json: string) => json.replace(/[<'&]/g, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
  const declare = (name: string, value: unknown) => "<meta name=\"" + name + "\" content='" + escape(JSON.stringify(value)) + "'>";
  // what the application customised, for the generated compatibility test (`@aotter/mantle-admin/testing`)
  const meta = (csp ? declare("mantle-mcp-csp", csp) : "") + (manifest ? declare("mantle-mcp-app", manifest) : "");
  writeFileSync(resolve(outDir, "mcp-app.html"), meta ? html.replace(/<head>/i, head => head + meta) : html);
  console.log(`Admin MCP App: ${(Buffer.byteLength(html) / 1024).toFixed(1)} kB (mcp-app.html).`);
}

/**
 * The entry's `defineAdmin(...)` as Node reads it, for what the build needs of it: `mcp.csp`, and which slot a rule is broken in.
 * The entry is bundled for Node and imported, so an entry that cannot run there (it touches `window` on import) is read as
 * declaring nothing, and the build says so rather than failing it.
 */
async function readDefinition(core: Awaited<ReturnType<typeof adminCore>>): Promise<{ csp?: McpCsp; sources: Source[]; manifest?: { slots: string[]; pages: string[] }; idle: string[]; problem?: string }> {
  try {
    const { build } = await import("vite");
    const built = await build({
      ...core.config, logLevel: "silent", plugins: core.scripting, ssr: { noExternal: true },
      build: { ssr: core.app, write: false, minify: false, rollupOptions: { output: { format: "es", codeSplitting: false } } },
    });
    const chunk = (Array.isArray(built) ? built.flatMap(each => each.output) : "output" in built ? built.output : []).find(file => file.type === "chunk");
    if (!chunk || chunk.type !== "chunk") throw new Error("the entry was not bundled");
    // a file, not a data: URL, so the bundle's `import.meta.url` is a real one
    const file = resolve(mkdtempSync(join(tmpdir(), "mantle-admin-entry-")), "entry.mjs");
    writeFileSync(file, chunk.code);
    let admin: { mcp?: { csp?: McpCsp }; layers?: { [slot: string]: readonly unknown[] }; pages?: readonly { mcp?: { renders: string } }[] };
    try { ({ default: admin } = await import(pathToFileURL(file).href) as { default: typeof admin }); }
    finally { rmSync(dirname(file), { recursive: true, force: true }); }
    const sources = Object.entries(admin.layers ?? {}).flatMap(([slot, layers]) => {
      const hits = layers.flatMap(layer => typeof layer === "function" ? hitsOf(layer.toString()) : []);
      return hits.length ? [{ slot, hits }] : [];
    });
    // what the App shows of the application's customising, which the compatibility test renders: the `cell:view:` slots, and the Views its MCP pages are for
    const slots = Object.keys(admin.layers ?? {});
    const manifest = { slots: slots.filter(slot => slot.startsWith("cell:view:")), pages: (admin.pages ?? []).flatMap(page => page.mcp ? [page.mcp.renders] : []) };
    // record/collection slots are browser-only, unlike View cells
    const idle = slots.filter(slot => slot === "RecordView" || /^(?:cell:(?!view:)|input:|record\.aside:|record\.actions:)/.test(slot));
    return { ...(admin.mcp?.csp ? { csp: admin.mcp.csp } : {}), sources, manifest, idle };
  } catch (error) {
    return { sources: [], idle: [], problem: `it could not be run in Node to read its definition (mcp.csp, the slots and pages to test): ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface AdminViteOptions {
  /** The application's Admin entry, as for `buildAdmin`. The built-in entry when omitted. */
  readonly entry?: string;
  /** The running service, to which `/admin/api` and `/api/auth` are proxied. `http://localhost:8787`, `wrangler dev`'s address, by default. */
  readonly target?: string;
  /** The service's auth base path when it is not `/api/auth`, as the service's `authBasePath`. */
  readonly authBasePath?: string;
}

/**
 * Hot module replacement for Admin while you work on `src/admin.tsx`; optional, and nothing uses it by default (`wrangler dev`
 * rebuilds Admin with `mantle bundle`). Put it in a `vite.config.ts` and run `vite`; Admin is at `http://localhost:5173/admin/`:
 *
 * ```ts
 * import { defineConfig } from "vite";
 * import { adminVitePlugin } from "@aotter/mantle-admin/build";
 * export default defineConfig({ plugins: [adminVitePlugin({ entry: "src/admin.tsx" })] });
 * ```
 */
export async function adminVitePlugin({ entry, target = "http://localhost:8787", authBasePath = "/api/auth" }: AdminViteOptions = {}): Promise<PluginOption[]> {
  const { plugins, config, allow } = await adminCore(entry);
  const { configFile: _configFile, ...inherited } = config;
  return [{
    name: "mantle-admin-dev",
    // the page is served at /admin/ as it is in production; the service answers its API and sign-in
    // changeOrigin stays off: the service compares a write's Origin with its own Host, and both are the dev server's
    config: () => ({ ...inherited, base: "/admin/", server: { fs: { allow }, proxy: { "/admin/api": { target }, [authBasePath]: { target } } } }),
    // the service injects this into the shell it serves (`adminShell`)
    transformIndexHtml: (html: string) => authBasePath === "/api/auth" ? html : html.replace("</head>", `<meta name="mantle-auth-base" content="${authBasePath}"></head>`),
  }, ...plugins];
}

/** A separate opt-in document for the same-origin preview; the canonical index.html keeps its frame refusal. */
function previewDocument(outDir: string): Plugin {
  return {
    name: "admin-preview-document",
    writeBundle() {
      writeFileSync(resolve(outDir, "preview.html"), readFileSync(resolve(outDir, "index.html"), "utf8")
        .replace("<head>", `<head><meta name="mantle-admin-preview" content="1"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`));
    },
  };
}
