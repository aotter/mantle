/** Required application seam `mcp-app-host-context`. Public imports only, no casts. */
import { applyHostContext } from "@aotter/mantle-admin/mcp-app";

export const present = (document: Document) =>
  applyHostContext({ locale: "en", safeAreaInsets: { top: 8, right: 0, bottom: 16, left: 0 } }, document);
