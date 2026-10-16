/// <reference types="node" />
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { InlineConfig, Plugin, PluginOption } from "vite";
import { PREVIEW_CSP } from "./preview-csp.js";

const dist = resolve(import.meta.dirname, "..");
/** The page template: index.html, main.js, styles.css and the public files (theme, icons, preview bridge). */
const page = resolve(dist, "admin-build");
const ENTRY = "virtual:mantle-admin/entry";

export interface BuildAdminOptions {
  /** The application's Admin entry, which default-exports `defineAdmin(...)`. The built-in entry when omitted. */
  readonly entry?: string;
  /** Where Admin's static files go, served at `/admin/`: `<assets>/admin`. It is emptied first. */
  readonly outDir: string;
}

/**
 * `react-dom` runs only beside the exact `react` it was released with, and the application owns both (Admin takes them as
 * peers). Two installs that drifted (`^` ranges resolved apart) would otherwise surface as React error #527 in the browser.
 * Both are read from where the application's Admin code resolves them.
 */
export function assertReactMatch(from: string): void {
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
 * React's JSX whatever `jsxImportSource` the application's tsconfig sets for its Worker.
 */
async function adminCore(entry: string | undefined) {
  const [{ normalizePath }, { default: react }, { default: tailwindcss }] = await Promise.all([import("vite"), import("@vitejs/plugin-react"), import("@tailwindcss/vite")]);
  const app = resolve(entry ?? resolve(dist, "admin-app/default-entry.js"));
  // where the application's code finds React, and where Vite bundles it from (Admin's own location)
  for (const from of new Set([...(entry ? [dirname(app)] : []), page])) assertReactMatch(from);
  const kit = resolve(dirname(createRequire(import.meta.url).resolve("@aotter/mantle-ui/package.json")), "dist");
  // Tailwind generates the classes Admin, the kit and the application's own Admin code use.
  const sources = [resolve(dist, "admin-app"), kit, ...(entry ? [dirname(app)] : [])].map(source => `@source ${JSON.stringify(source)};`).join("\n");
  const plugins: PluginOption[] = [{
    name: "mantle-admin-entry", enforce: "pre",
    resolveId: id => id === ENTRY ? app : undefined,
    // Vite ids use forward slashes on every platform
    transform: (code, id) => normalizePath(id.split("?")[0]!) === normalizePath(resolve(page, "styles.css")) ? `${code}\n${sources}\n` : undefined,
  }, react(), tailwindcss()];
  return {
    plugins,
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
 * its `host-bridge.js`, and hashed assets. `mantle bundle` calls this; it is not a CLI.
 */
export async function buildAdmin({ entry, outDir }: BuildAdminOptions): Promise<void> {
  const { build } = await import("vite");
  const { plugins, config } = await adminCore(entry);
  outDir = resolve(outDir);
  await build({ ...config, base: "./", logLevel: "warn", plugins: [...plugins, previewDocument(outDir)], build: { outDir, emptyOutDir: true } });
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
