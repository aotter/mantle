import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { PREVIEW_CSP } from "./src/app/frame-policy.ts";

const root = import.meta.dirname;
const { version } = JSON.parse(readFileSync(resolve(root, "../package.json"), "utf8")) as { version: string };

/**
 * The Admin SPA, `@aotter/mantle-ui/admin`: static files under `dist/admin/`, served at `/admin/` by `createAdminSurface`'s
 * `assets` (the generated Cloudflare preset binds them as the Worker's static assets).
 */
export default defineConfig(({ command }) => ({
  root,
  base: command === "build" ? "./" : "/admin/", // Lazy chunks resolve beside their own script in canonical and embedded mounts.
  define: { __MANTLE_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss(), extensionShared(), previewDocument()],
  build: { outDir: resolve(root, "../dist/admin"), emptyOutDir: true },
  resolve: { alias: { "@": resolve(root, "src") } },
}));

/**
 * Admin extensions share Admin's React (ADR-lite 1376): an import map before any module, and `shared/*.js` modules that
 * re-export what `app/extension-shared.ts` installs. `vite.shared.config.ts` adds the kit and the extension helper.
 */
export const SHARED_MODULES = {
  react: "react",
  "react/jsx-runtime": "react-jsx-runtime",
  "react-dom": "react-dom",
  "react-dom/client": "react-dom-client",
  "@aotter/mantle-ui/kit": "kit",
  "@aotter/mantle-ui/extension": "extension",
} as const;
const SHIMMED = ["react", "react/jsx-runtime", "react-dom", "react-dom/client"] as const;

function extensionShared(): Plugin {
  const imports = Object.fromEntries(Object.entries(SHARED_MODULES).map(([specifier, file]) => [specifier, `./shared/${file}.js`]));
  return {
    name: "admin-extension-shared",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      // after <base>, so the relative addresses resolve beside the shell in canonical and preview mounts
      handler: (html) => html.replace(/(<base [^>]*>)/, `$1\n    <script type="importmap">${JSON.stringify({ imports })}</script>`),
    },
    writeBundle() {
      const require = createRequire(import.meta.url);
      const dir = resolve(root, "../dist/admin/shared");
      mkdirSync(dir, { recursive: true });
      for (const specifier of SHIMMED) {
        const names = Object.keys(require(specifier) as object).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default");
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
function previewDocument(): Plugin {
  return {
    name: "admin-preview-document",
    apply: "build",
    writeBundle() {
      const dist = resolve(root, "../dist/admin");
      writeFileSync(resolve(dist, "preview.html"), readFileSync(resolve(dist, "index.html"), "utf8")
        .replace("<head>", `<head><meta name="mantle-admin-preview" content="1"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`));
    },
  };
}
