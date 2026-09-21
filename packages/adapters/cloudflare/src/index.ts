/**
 * `@aotter/mantle-cloudflare` — Cloudflare Workers adapter for
 * mantle. The only place in the codebase that may import D1Database
 * / Fetcher; runtime stays portable per ADR-0011.
 */
export * from "./bindings/index.js";
export * from "./mount/index.js";
export * from "./handlers/index.js";
export * from "./oauth/index.js";
export * from "./worker/index.js";
export * from "./auth/createAuth.js";
export * from "./auth/conventionalAuth.js";
// Re-exported so existing Cloudflare consumers keep one import path while the
// implementation lives in the host-neutral @aotter/mantle-auth.
export {
  ConsoleEmailSender,
  appleClientSecret,
  type AppleClientSecretArgs,
} from "@aotter/mantle-auth";
