import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Real-browser tests launch Chrome and a Vite server each; they are load-sensitive, so they run on demand
// (`pnpm test:browser`, before releases) rather than in every PR run (#1465, 2026-10-13).
// The two sandbox boundaries (design preview, MCP App host bridge) and the system wiring fit (#1666).
const browser = ["test/custom-admin-browser.test.ts", "test/frontend-mcp-app-browser.test.ts", "admin/test/preview-boundary.test.ts", "admin/test/atom-graph-browser.test.ts", "admin/test/load-more-browser.test.ts", "test/mcp-app-browser.test.ts", "test/testing.test.ts", "test/registry-compat.test.ts"];
const withBrowser = process.env.MANTLE_BROWSER_TESTS === "1";

export default defineConfig({
  // the Admin SPA's own `@/` alias (vite.app.config.ts); nothing outside admin/ uses it
  resolve: { alias: { "@": resolve(import.meta.dirname, "admin/src") } },
  define: { __MANTLE_VERSION__: JSON.stringify("test") },
  test: {
    include: withBrowser ? browser : ["test/**/*.test.{ts,tsx}", "admin/{src,test}/**/*.test.{ts,tsx}"],
    exclude: withBrowser ? [] : browser,
    typecheck: { enabled: false },
    // several tests run tsc or import the built library, which takes seconds while the workspace tests run in parallel
    testTimeout: 60_000,
  },
});
