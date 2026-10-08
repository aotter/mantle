import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/postgres/setup.ts"],
    typecheck: { enabled: false },
  },
});
