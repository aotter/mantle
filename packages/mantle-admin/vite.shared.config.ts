import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Extensions share Admin's kit via its import map, not a second kit bundle or stylesheet. */
export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, "dist/admin/shared"),
    emptyOutDir: false,
    copyPublicDir: false,
    lib: { entry: resolve(import.meta.dirname, "src/extension/index.ts"), formats: ["es"], fileName: () => "extension.js" },
  },
});
