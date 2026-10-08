import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// The kit and the extension helper as modules Admin serves to its extensions (ADR-lite 1376), beside the React
// re-exports the Admin build writes. React stays external: the import map resolves it to Admin's own instance.
const root = import.meta.dirname;
export default defineConfig({
  build: {
    outDir: resolve(root, "dist/admin/shared"),
    emptyOutDir: false,
    copyPublicDir: false,
    lib: { entry: { kit: resolve(root, "src/kit/index.ts"), extension: resolve(root, "src/extension/index.ts") }, formats: ["es"], fileName: (_format, name) => `${name}.js` },
    rollupOptions: { external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"] },
  },
  plugins: [{
    name: "admin-shared-kit-css",
    apply: "build",
    writeBundle() { copyFileSync(resolve(root, "dist/kit/kit.css"), resolve(root, "dist/admin/shared/kit.css")); },
  }],
});
