/**
 * `@aotter/mantle-cloudflare` — Cloudflare Workers adapter for
 * mantle. The only place in the codebase that may import D1Database
 * / KVNamespace / Fetcher; runtime stays portable per ADR-0011.
 */
export * from "./bindings/index.js";
export * from "./mount/index.js";
export * from "./handlers/index.js";
export * from "./oauth/index.js";
export * from "./auth/createAuth.js";
export * from "./auth/conventionalAuth.js";
export { ConsoleEmailSender } from "./auth/ConsoleEmailSender.js";
export {
  appleClientSecret,
  type AppleClientSecretArgs,
} from "./auth/appleClientSecret.js";
