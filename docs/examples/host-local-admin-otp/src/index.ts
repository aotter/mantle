import {
  ConsoleEmailSender,
  createAuth,
  createMantleWorker,
  type MantleCloudflareEnv,
} from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

export interface Env extends MantleCloudflareEnv {
  readonly ASSETS: Fetcher;
  readonly BETTER_AUTH_SECRET: string;
  readonly ADMIN_EMAIL: string;
}

const sender = new ConsoleEmailSender();

export default createMantleWorker<Env>({
  plan,
  cacheScope: "local-admin-otp",
  siteDefaults: (env) => ({
    brand: "Local Admin",
    title: "Local Admin",
    origin: originOf(env),
  }),
  auth: (env) => {
    const origin = originOf(env);
    const secret = required(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET");
    const ownerEmail = required(env.ADMIN_EMAIL, "ADMIN_EMAIL");
    return createAuth({
      database: env.DB,
      baseURL: origin,
      secret,
      methods: [{ kind: "email-otp", sender }],
      bootstrapOwner: { match: "email", value: ownerEmail },
      oauthProvider: {
        loginPage: "/admin/sign-in",
        consentPage: "/oauth/consent",
        scopes: ["mcp"],
        mcpResource: `${origin}/mcp`,
      },
    });
  },
});

function originOf(env: Env): string {
  return env.PUBLIC_ORIGIN?.replace(/\/+$/, "") ?? "http://127.0.0.1:8787";
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required. Copy .dev.vars.example to .dev.vars.`);
  }
  return value;
}
