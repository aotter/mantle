import { test } from "node:test";
import { checkMcpApp } from "@aotter/mantle-admin/testing";
import { salesReportCatalogue } from "./src/mcp-report.ts";

test("the explicit sales renderer displays in the official AppBridge", { timeout: 300_000 }, async () => {
  await checkMcpApp({ catalogue: salesReportCatalogue, html: "dist/client/admin/mcp-app.html" });
});
