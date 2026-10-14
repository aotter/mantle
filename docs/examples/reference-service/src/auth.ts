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
import type { BetterAuthOptions } from "better-auth/types";

const ac = createAccessControl(defaultStatements);
/** Schema generation reads these options without constructing Better Auth. */
export function authOptions(env: Env) {
  const origin = env.PUBLIC_ORIGIN || "https://example.invalid";
  const secret = env.BETTER_AUTH_SECRET || "schema-generation-placeholder-secret";
  const bootstrap = env.ADMIN_EMAIL ? d1BootstrapAdmin(env.DB, { match: "email", value: env.ADMIN_EMAIL }, () => ({ options: { plugins } })) : async () => {};
  const plugins = [
    admin({ defaultRole: "user", adminRoles: ["admin"], ac, roles: { admin: ac.newRole(defaultStatements), user: ac.newRole({ user: [], session: [] }) } }),
    emailOTP({ storeOTP: { hash: otp => hashEmailOtp(secret, otp) }, sendVerificationOTP: async ({ email, otp }) => {
      if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) throw new Error("Configure a production email sender.");
      console.log(`${email}: one-time code is ${otp}`);
    } }),
    jwt({ disableSettingJwtHeader: true }),
    mcp({ loginPage: "/admin/sign-in", consentPage: "/admin/oauth/consent", resource: `${origin}/mcp`, scopes: ["mcp"], extensions: [oauthGrantExtension], allowPublicClientPrelogin: true, clientRegistrationClientSecretExpiration: "90d" }),
    cimd({ fetchClientMetadataResource: (input, init) => fetch(input, { ...init, redirect: "manual" }), metadataProfile: "mcp-2026-07-28" }),
  ];
  return { database: d1Adapter(env.DB), secret, baseURL: origin, basePath: "/api/auth", plugins,
    // The jwt plugin's cookie-to-JWT endpoint is unused; OAuth tokens come from the provider (Better Auth oauth-provider docs).
    disabledPaths: ["/token"],
    ...authHardening({ ipAddressHeaders: ["cf-connecting-ip"], baseURL: origin, errorURL: "/admin/sign-in" }),
    databaseHooks: { user: { create: { after: bootstrap }, update: { after: bootstrap } } },
    session: { storeSessionInDatabase: true }, verification: { storeInDatabase: true },
  } satisfies BetterAuthOptions;
}
export function createAuth(env: Env) {
  if (!env.BETTER_AUTH_SECRET || !env.PUBLIC_ORIGIN || !env.ADMIN_EMAIL) throw new Error("Authentication setup is incomplete.");
  return betterAuth(authOptions(env));
}
