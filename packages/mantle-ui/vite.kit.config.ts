import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The kit's compiled stylesheet (ADR-0029): Tailwind over the kit sources,
// the shadcn theme and the Mantle tokens, as `@aotter/mantle-ui/kit.css`.
export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/kit"),
    emptyOutDir: false,
    copyPublicDir: false,
    rollupOptions: {
      input: { kit: resolve(import.meta.dirname, "src/kit/styles/kit.css") },
      output: { assetFileNames: "[name][extname]" },
    },
  },
});
