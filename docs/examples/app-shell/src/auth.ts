/** Application-owned Better Auth; this module loads only on an auth request. */
import { betterAuth } from "better-auth/minimal";
import { admin, emailOTP, jwt } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { oauthGrantExtension } from "@aotter/mantle/auth/oauth";
import { d1Adapter } from "@aotter/mantle/auth/adapter";
import { d1BootstrapAdmin } from "@aotter/mantle/auth/identity";
import { authHardening, hashEmailOtp } from "@aotter/mantle/auth/hardening";
import { APIError } from "better-auth/api";
import type { BetterAuthOptions } from "better-auth/types";

const ac = createAccessControl(defaultStatements);
/** Schema generation (`mantle generate --auth src/auth.ts`) reads these options without constructing Better Auth. */
export function authOptions(env: Env) {
  const origin = env.PUBLIC_ORIGIN || "https://example.invalid";
  const secret = env.BETTER_AUTH_SECRET || "schema-generation-placeholder-secret";
  // The first verified sign-in with ADMIN_EMAIL becomes the admin while no admin exists.
  const bootstrap = env.ADMIN_EMAIL ? d1BootstrapAdmin(env.DB, { match: "email", value: env.ADMIN_EMAIL }, () => ({ options: { plugins } })) : async () => {};
  // Sign-up gate: runs only when Better Auth creates a user (never at schema generation). src/signup.ts loads lazily
  // because it may import generated code; ADMIN_EMAIL is always allowed so the first officer can sign in.
  const admit = async (user: { email: string }) => {
    if (user.email === env.ADMIN_EMAIL?.trim().toLowerCase() || await (await import("./signup.js")).allowSignUp(env, user.email)) return;
    // Throw rather than return false: email-OTP sign-in does not handle a refused create (it would be a 500).
    throw new APIError("FORBIDDEN", { message: "Sign-up is limited to invited members." });
  };
  const plugins = [
    // Two roles: admin (the admin layer: Admin console, admin MCP, `surface: admin`) and user (every signed-in member).
    admin({ defaultRole: "user", adminRoles: ["admin"], ac, roles: { admin: ac.newRole(defaultStatements), user: ac.newRole({ user: [], session: [] }) } }),
    emailOTP({ storeOTP: { hash: otp => hashEmailOtp(secret, otp) }, sendVerificationOTP: async ({ email, otp }) => {
      // AGENT: replace with a real sender (see docs/handbook/guides/email.md) before deploying.
      if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) throw new Error("Configure a production email sender.");
      console.log(`${email}: one-time code is ${otp}`);
    } }),
    // --- MCP / OAuth (optional): delete these three plugins, `disabledPaths` and the MCP block in service.ts if the app has no MCP.
    jwt({ disableSettingJwtHeader: true }),
    mcp({ loginPage: "/admin/sign-in", consentPage: "/admin/oauth/consent", resource: `${origin}/mcp`, scopes: ["mcp"], extensions: [oauthGrantExtension], allowPublicClientPrelogin: true, clientRegistrationClientSecretExpiration: "90d" }),
    cimd({ fetchClientMetadataResource: (input, init) => fetch(input, { ...init, redirect: "manual" }), metadataProfile: "mcp-2026-07-28" }),
    // --- end MCP / OAuth
  ];
  return { database: d1Adapter(env.DB), secret, baseURL: origin, basePath: "/api/auth", plugins,
    // The jwt plugin's cookie-to-JWT endpoint is unused; OAuth tokens come from the provider.
    disabledPaths: ["/token"],
    // Trusted client IP header and Better Auth's database rate limiter (3 OTP requests per minute per IP).
    ...authHardening({ ipAddressHeaders: ["cf-connecting-ip"], baseURL: origin, errorURL: "/admin/sign-in" }),
    databaseHooks: { user: { create: { before: admit, after: bootstrap }, update: { after: bootstrap } } },
    session: { storeSessionInDatabase: true }, verification: { storeInDatabase: true },
  } satisfies BetterAuthOptions;
}
export function createAuth(env: Env) {
  if (!env.BETTER_AUTH_SECRET || !env.PUBLIC_ORIGIN || !env.ADMIN_EMAIL) throw new Error("Authentication setup is incomplete.");
  return betterAuth(authOptions(env));
}
