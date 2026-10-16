/**
 * `@aotter/mantle-admin/app` as the MCP App's build sees it (`@aotter/mantle-admin/build` resolves the public entry to this one):
 * what renders in a host. `<MantleAdmin>` mounts the browser Admin, with its router, sign-in and `/admin/api` transport, so the
 * App's bundle must not reach it.
 */
export { defineAdmin } from "./define-admin";
export { AdminLink } from "./slots";

export const MantleAdmin = (): never => {
  throw new Error("<MantleAdmin> renders the browser Admin; it is not part of the MCP App.");
};
