import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // the Admin SPA's own `@/` alias (admin/vite.config.ts); nothing outside admin/ uses it
  resolve: { alias: { "@": resolve(import.meta.dirname, "admin/src") } },
  define: { __MANTLE_VERSION__: JSON.stringify("test") },
  test: {
    include: ["test/**/*.test.{ts,tsx}", "admin/{src,test}/**/*.test.{ts,tsx}"],
    typecheck: { enabled: false },
  },
});
