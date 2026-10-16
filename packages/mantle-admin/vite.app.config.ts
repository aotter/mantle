import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const admin = resolve(import.meta.dirname, "admin/src");
const dist = resolve(import.meta.dirname, "dist");
const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as { version: string };

/**
 * `@aotter/mantle-admin/app`: Admin's source as an ES library for an application's own Vite build; packages stay
 * imports. `mount` and `default-entry` are internal entries of the page `@aotter/mantle-admin/build` builds.
 */
export default defineConfig({
  define: { __MANTLE_VERSION__: JSON.stringify(version) },
  plugins: [react(), pageTemplate()],
  resolve: { alias: { "@": admin } },
  build: {
    outDir: resolve(dist, "admin-app"),
    emptyOutDir: true,
    copyPublicDir: false,
    lib: {
      entry: { index: resolve(admin, "app/index.ts"), hooks: resolve(admin, "app/hooks.ts"), mount: resolve(admin, "app/mount.tsx"), "default-entry": resolve(admin, "default-entry.tsx") },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: { external: (id) => /^[^./\0]/.test(id) && !id.startsWith("@/") && !id.startsWith(admin) },
  },
});

/**
 * The page template under `dist/admin-build`, which ships: shadcn's Tailwind stylesheet is inlined so the shadcn CLI
 * is not a dependency. `vite.preview.config.ts` adds its files to its `public/`.
 */
function pageTemplate(): Plugin {
  return {
    name: "admin-page-template",
    closeBundle() {
      const page = resolve(dist, "admin-build"), from = resolve(import.meta.dirname, "admin");
      mkdirSync(page, { recursive: true });
      for (const file of ["index.html", "main.js"]) cpSync(resolve(from, file), resolve(page, file));
      cpSync(resolve(from, "public"), resolve(page, "public"), { recursive: true });
      const shadcn = '@import "shadcn/tailwind.css";';
      const styles = readFileSync(resolve(from, "styles.css"), "utf8");
      if (!styles.includes(shadcn)) throw new Error(`admin/styles.css no longer has ${shadcn}`);
      const inlined = readFileSync(createRequire(import.meta.url).resolve("shadcn/tailwind.css"), "utf8");
      writeFileSync(resolve(page, "styles.css"), styles.replace(shadcn, inlined));
    },
  };
}
