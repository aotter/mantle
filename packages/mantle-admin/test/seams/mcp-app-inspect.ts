/** Required application seam `mcp-app-inspect` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { checkMcpApp } from "@aotter/mantle-admin/testing";

export const check = (html: string) =>
  checkMcpApp({
    catalogue: { views: { tasks: {} }, actions: {} },
    html,
    inspect: async ({ frame }) => {
      await frame.waitForSelector("body");
    },
  });
