/** Reuse the static console descriptor; no plan, query or Admin handler is loaded by this projection. */
export function emitAdminDesign(): Record<string, string> {
  return { "admin-design.ts": `import { createAdminDesignSurface, type DesignOptions } from "@aotter/mantle-next/admin/design";
import { developerConsole } from "./admin-descriptors.js";
export function adminDesign(options: DesignOptions) {
  return createAdminDesignSurface(developerConsole, options);
}
` };
}
