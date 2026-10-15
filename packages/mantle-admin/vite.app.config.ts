import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const admin = resolve(import.meta.dirname, "admin/src");
const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as { version: string };

/** `@aotter/mantle-admin/app`: Admin's source as an ES library for an application's own Vite build; packages stay imports. */
export default defineConfig({
  define: { __MANTLE_VERSION__: JSON.stringify(version) },
  plugins: [react()],
  resolve: { alias: { "@": admin } },
  build: {
    outDir: resolve(import.meta.dirname, "dist/admin-app"),
    emptyOutDir: true,
    copyPublicDir: false,
    lib: { entry: resolve(admin, "app/index.ts"), formats: ["es"], fileName: () => "index.js" },
    rollupOptions: { external: (id) => /^[^./\0]/.test(id) && !id.startsWith("@/") && !id.startsWith(admin) },
  },
});
