import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PREVIEW_CSP } from "./src/app/frame-policy.ts";

const root = import.meta.dirname;
const { version } = JSON.parse(readFileSync(resolve(root, "../package.json"), "utf8")) as { version: string };

/**
 * The Admin SPA, `@aotter/mantle-ui/admin`: static files under `dist/admin/`, served at `/admin/` by `createAdminSurface`'s
 * `assets` (the generated Cloudflare preset binds them as the Worker's static assets).
 */
export default defineConfig({
  root,
  base: "/admin/",
  define: { __MANTLE_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss(), previewDocument()],
  build: { outDir: resolve(root, "../dist/admin"), emptyOutDir: true },
  resolve: { alias: { "@": resolve(root, "src") } },
});

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
