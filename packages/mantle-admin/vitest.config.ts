import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Real-browser tests launch Chrome and a Vite server each; they are load-sensitive, so they run on demand
// (`pnpm test:browser`, before releases) rather than in every PR run (#1465, 2026-10-13).
// The two sandbox boundaries: design preview and MCP App host bridge.
const browser = ["admin/test/preview-boundary.test.ts", "test/mcp-app-browser.test.ts"];
const withBrowser = process.env.MANTLE_BROWSER_TESTS === "1";

export default defineConfig({
  // the Admin SPA's own `@/` alias (admin/vite.config.ts); nothing outside admin/ uses it
  resolve: { alias: { "@": resolve(import.meta.dirname, "admin/src") } },
  define: { __MANTLE_VERSION__: JSON.stringify("test") },
  test: {
    include: withBrowser ? browser : ["test/**/*.test.{ts,tsx}", "admin/{src,test}/**/*.test.{ts,tsx}"],
    exclude: withBrowser ? [] : browser,
    typecheck: { enabled: false },
  },
});
