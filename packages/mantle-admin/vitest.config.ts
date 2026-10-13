import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Real-browser tests launch Chrome and a Vite server each; they are load-sensitive, so they run on demand
// (`pnpm test:browser`, before releases) rather than in every PR run (#1465, 2026-10-13).
const browser = [
  "admin/test/collection-workbench-browser.test.ts", "admin/test/dark-descriptions.test.ts", "admin/test/developer-live-data-browser.test.ts",
  "admin/test/extensions-browser.test.ts", "admin/test/extensions-review-browser.test.ts", "admin/test/global-operations.test.ts",
  "admin/test/language-browser.test.ts", "admin/test/next-admin-browser.test.ts", "admin/test/preview-boundary.test.ts",
  "admin/test/row-operations-occ.test.ts", "admin/test/webmcp-browser.test.ts", "test/mcp-app-browser.test.ts",
];
const withBrowser = process.env.MANTLE_BROWSER_TESTS === "1";

export default defineConfig({
  // the Admin SPA's own `@/` alias (admin/vite.config.ts); nothing outside admin/ uses it
  resolve: { alias: { "@": resolve(import.meta.dirname, "admin/src") } },
  define: { __MANTLE_VERSION__: JSON.stringify("test") },
  test: {
    include: withBrowser ? browser : ["test/**/*.test.{ts,tsx}", "admin/{src,test}/**/*.test.{ts,tsx}"],
    exclude: withBrowser ? [] : browser,
    typecheck: { enabled: false },
    // one cold Chrome launch before the browser tests, whose own launches keep their budgets
    ...(withBrowser ? { globalSetup: ["test/chrome-warmup.ts"] } : {}),
  },
});
