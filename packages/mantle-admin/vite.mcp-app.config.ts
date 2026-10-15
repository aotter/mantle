import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as { version: string };

// One self-contained HTML file (ADR-0029 D7): hosts load MCP App resources
// in a sandbox with no network access to extra assets by default.
export default defineConfig({
  root: resolve(import.meta.dirname, "src/mcp-app"),
  // `appInfo.version` in `ui/initialize`, so a host can tell App builds apart
  define: { __MANTLE_VERSION__: JSON.stringify(version) },
  plugins: [{
    name: "mantle-app-native-date",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "../kit/components/ui/calendar.js" && importer?.endsWith("/mantle-ui/dist/react/fields.js")) return resolve(import.meta.dirname, "src/mcp-app/native-date.tsx");
    },
  }, react(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/mcp-app"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "src/mcp-app/interaction.html"), output: { entryFileNames: "interaction.js" } },
  },
});
