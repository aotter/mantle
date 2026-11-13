/** Required application seam `admin-app-tools` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { adminMcpApps } from "@aotter/mantle-admin/mcp";

export const app = adminMcpApps({
  uri: "ui://mantle-admin/seam",
  catalogue: { views: {}, actions: {} },
  tools: ["seam_tool"],
  html: "<!doctype html>",
});
