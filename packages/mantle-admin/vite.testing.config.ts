import { resolve } from "node:path";
import { defineConfig } from "vite";

/** The MCP host page of `@aotter/mantle-admin/testing`: ext-apps' AppBridge bundled whole, so an application installs only `playwright-core`. */
export default defineConfig({
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: resolve(import.meta.dirname, "dist/testing"), emptyOutDir: false, copyPublicDir: false,
    lib: { entry: resolve(import.meta.dirname, "testing-host/host.ts"), formats: ["iife"], name: "MantleCompatibilityHost", fileName: () => "host.js" },
  },
});
