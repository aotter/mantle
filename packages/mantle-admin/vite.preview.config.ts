import { defineConfig } from "vite";

// A synchronous bootstrap: the isolated bridge must exist before the Admin module boots.
export default defineConfig({
  build: {
    outDir: "dist/admin", emptyOutDir: false,
    lib: { entry: "admin/src/app/host-bridge.ts", formats: ["iife"], name: "MantleAdminPreview", fileName: () => "host-bridge.js" },
  },
});
