/** Fixture: an application's Better Auth module as the docs recommend writing it. Imported only through authLoader. */
import { betterAuth } from "better-auth/minimal";
import { emailOTP, jwt } from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { oauthProvider } from "@better-auth/oauth-provider";
import { d1Adapter, type D1Like } from "../../../src/auth/adapter.js";

export const createAuth = (db: D1Like) => betterAuth({
  database: d1Adapter(db),
  secret: "fixture-secret-fixture-secret-fixture",
  baseURL: "https://app.example",
  plugins: [emailOTP({ sendVerificationOTP: async () => {} }), admin(), jwt(), oauthProvider({ loginPage: "/login", consentPage: "/consent" })],
});
export const auth = createAuth({ prepare: () => { throw new Error("fixture database"); } } as never);
