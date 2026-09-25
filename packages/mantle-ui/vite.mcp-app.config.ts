import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained HTML file (ADR-0029 D7): hosts load MCP App resources
// in a sandbox with no network access to extra assets by default.
export default defineConfig({
  root: resolve(import.meta.dirname, "src/mcp-app"),
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/mcp-app"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "src/mcp-app/interaction.html"), output: { entryFileNames: "interaction.js" } },
  },
});
