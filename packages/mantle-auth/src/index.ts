/**
 * `@aotter/mantle-auth` — optional Better Auth identity for Mantle.
 *
 * Portable across hosts: it takes a `DatabaseDriver` port for its own SQL and
 * the schema migration, and the same database in whatever form Better Auth
 * accepts. No host binding types are imported here per ADR-0011.
 */
export * from "./createMantleAuth.js";
export { ConsoleEmailSender } from "./ConsoleEmailSender.js";
export {
  appleClientSecret,
  type AppleClientSecretArgs,
} from "./appleClientSecret.js";
