/** Fixture: an application's Better Auth module as docs/next/auth.md recommends. Imported only through authLoader. */
import { betterAuth } from "better-auth/minimal";
import { emailOTP, jwt } from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthOptions } from "better-auth";
import { d1Adapter, type D1Like } from "../../../src/auth/adapter.js";

type Env = { DB: D1Like; ORIGIN: string };
export const authOptions = (env: Env) => ({
  database: d1Adapter(env.DB),
  secret: "fixture-secret-fixture-secret-fixture",
  baseURL: `${env.ORIGIN}/api/auth`,
  // Native adapters create a configured resource row on its first OAuth lookup; generation only reads these options.
  plugins: [emailOTP({ sendVerificationOTP: async () => {} }), admin(), jwt(), oauthProvider({ loginPage: "/login", consentPage: "/consent", resources: [`${env.ORIGIN}/mcp`] })],
}) satisfies BetterAuthOptions;
export const createAuth = (env: Env) => betterAuth(authOptions(env));
