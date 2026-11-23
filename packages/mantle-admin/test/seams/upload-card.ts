/** Required application seam `upload-card-tool` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { mediaUploadCard } from "@aotter/mantle-admin/mcp";

export const card = mediaUploadCard({
  media: () => ({ uploadOrigin: "https://media.example" }),
  uri: "ui://mantle-admin/upload/seam",
  tool: "upload_to_folder",
  forward: ["folder"],
  inputTimeoutMs: 2_000,
});
