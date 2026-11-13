/** Required application seam `page-renders-tool` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { defineAdmin } from "@aotter/mantle-admin/app";

interface Types {
  readonly views: { readonly tasks: { readonly input: object; readonly row: object; readonly mcp: true } };
  readonly collections: { readonly tasks: { readonly data: object } };
  readonly operations: { readonly "add-task": { readonly input: object; readonly output: unknown } };
}

export const admin = defineAdmin<Types>(
  {},
  { pages: [{ path: "seam", title: "Seam", element: null, mcp: { renders: "seam_tool" } }] },
);
