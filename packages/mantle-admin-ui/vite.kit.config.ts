import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf8"),
) as { dependencies: Record<string, string> };
const dependencies = Object.keys(packageJson.dependencies);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  build: {
    outDir: "./dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/kit.build.ts"),
      formats: ["es"],
      fileName: () => "kit.js",
      cssFileName: "kit",
    },
    rollupOptions: {
      external: (id) => dependencies.some(
        (dependency) => id === dependency || id.startsWith(`${dependency}/`),
      ),
    },
  },
});
