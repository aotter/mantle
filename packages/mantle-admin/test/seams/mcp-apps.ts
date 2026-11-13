/**
 * Application seams `admin-app-tools` and `upload-card-tool` (packages/mantle/tests/application-seams.ts): the Admin MCP
 * App renders an application's own tool, and the upload card serves a tool a host names. Public imports only, no casts.
 */
import { adminMcpApps, mediaUploadCard } from "@aotter/mantle-admin/mcp";

export const adminApp = adminMcpApps({
  uri: "ui://mantle-admin/notes",
  catalogue: { views: {}, actions: {} },
  tools: ["note_summary"],
  html: "<!doctype html><title>Admin</title>",
});

export const uploadCard = mediaUploadCard({
  media: () => ({ uploadOrigin: "https://media.notes.example" }),
  uri: "ui://mantle-admin/upload/notes",
  tool: "attach_note_image",
  forward: ["notebook"],
  inputTimeoutMs: 2_000,
});
