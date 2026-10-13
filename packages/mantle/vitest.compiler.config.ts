import { defineConfig } from "vitest/config";
export default defineConfig({test:{include:["compiler-tests/**/*.test.ts"],typecheck:{enabled:false}}});
