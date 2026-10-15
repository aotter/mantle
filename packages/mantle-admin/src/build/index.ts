/// <reference types="node" />
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";
import { PREVIEW_CSP } from "./preview-csp.js";

const dist = resolve(import.meta.dirname, "..");
/** The page template: index.html, main.js, styles.css and the public files (theme, icons, preview bridge, extension helper). */
const page = resolve(dist, "admin-build");
const ENTRY = "virtual:mantle-admin/entry";

export interface BuildAdminOptions {
  /** The application's Admin entry, which default-exports `defineAdmin(...)`. The built-in entry when omitted. */
  readonly entry?: string;
  /** Where Admin's static files go, served at `/admin/`: `<assets>/admin`. It is emptied first. */
  readonly outDir: string;
}

/**
 * Build Admin with Vite into `outDir`: the shell (`index.html`), the same-origin preview document (`preview.html`) and
 * its `host-bridge.js`, and hashed assets. `mantle bundle` calls this; it is not a CLI.
 */
export async function buildAdmin({ entry, outDir }: BuildAdminOptions): Promise<void> {
  const [{ build }, { default: react }, { default: tailwindcss }] = await Promise.all([import("vite"), import("@vitejs/plugin-react"), import("@tailwindcss/vite")]);
  const app = resolve(entry ?? resolve(dist, "admin-app/default-entry.js"));
  outDir = resolve(outDir);
  const kit = resolve(dirname(createRequire(import.meta.url).resolve("@aotter/mantle-ui/package.json")), "dist");
  // Tailwind generates the classes Admin, the kit and the application's own Admin code use.
  const sources = [resolve(dist, "admin-app"), kit, ...(entry ? [dirname(app)] : [])].map(source => `@source ${JSON.stringify(source)};`).join("\n");
  await build({
    root: page, base: "./", configFile: false, logLevel: "warn", publicDir: resolve(page, "public"),
    resolve: { dedupe: ["react", "react-dom"] },
    plugins: [{
      name: "mantle-admin-entry", enforce: "pre",
      resolveId: id => id === ENTRY ? app : undefined,
      transform: (code, id) => id.split("?")[0] === resolve(page, "styles.css") ? `${code}\n${sources}\n` : undefined,
    }, react(), tailwindcss(), extensionShared(outDir), previewDocument(outDir)],
    build: { outDir, emptyOutDir: true },
  });
}

/**
 * Admin extensions share Admin's React (ADR-lite 1376): an import map before any module, and `shared/*.js` modules that
 * re-export what Admin installs. The extension helper (`shared/extension.js`) is a public file.
 */
const SHARED_MODULES = {
  react: "react",
  "react/jsx-runtime": "react-jsx-runtime",
  "react-dom": "react-dom",
  "react-dom/client": "react-dom-client",
  "@aotter/mantle-ui/kit": "kit",
  "@aotter/mantle-admin/extension": "extension",
} as const;
const SHIMMED = ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@aotter/mantle-ui/kit"] as const;

function extensionShared(outDir: string): Plugin {
  const imports = Object.fromEntries(Object.entries(SHARED_MODULES).map(([specifier, file]) => [specifier, `./shared/${file}.js`]));
  return {
    name: "admin-extension-shared",
    transformIndexHtml: {
      order: "pre",
      // after <base>, so the relative addresses resolve beside the shell in canonical and preview mounts
      handler: html => html.replace(/(<base [^>]*>)/, `$1\n    <script type="importmap">${JSON.stringify({ imports })}</script>`),
    },
    async writeBundle() {
      const require = createRequire(import.meta.url);
      const dir = resolve(outDir, "shared");
      mkdirSync(dir, { recursive: true });
      for (const specifier of SHIMMED) {
        const module = specifier === "@aotter/mantle-ui/kit" ? await import(specifier) : require(specifier) as object;
        const names = Object.keys(module).filter(name => /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default");
        writeFileSync(resolve(dir, `${SHARED_MODULES[specifier]}.js`), [
          `const m = globalThis.__MANTLE_ADMIN_SHARED__?.[${JSON.stringify(specifier)}];`,
          `if (!m) throw new Error("Admin has not shared ${specifier}: load this module from Admin.");`,
          "export default m.default ?? m;",
          `export const { ${names.join(", ")} } = m;`,
          "",
        ].join("\n"));
      }
    },
  };
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
