import {
  createAuth,
  createSetupIncompleteAuth,
  isSetupIncompleteAuth,
  type Auth,
  type AuthMethodConfig,
} from "./createAuth.js";
import {
  OAUTH_AUTHORIZE_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_TOKEN_PATH,
} from "../oauth/oauthConstants.js";
import { applyCachePolicy } from "../oauth/cachePolicy.js";

const AUTH_NOT_CONFIGURED =
  "Admin auth is not configured yet. Configure self-managed GitHub OAuth or provide an explicit Auth factory.";

export interface ConventionalAuthEnv {
  readonly DB: D1Database;
  readonly PUBLIC_ORIGIN?: string;
  readonly BETTER_AUTH_SECRET?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly ADMIN_GITHUB_LOGIN?: string;
}

/** Choose self-managed GitHub OAuth or a fail-closed facade. */
export function createConventionalAuth(env: ConventionalAuthEnv): Auth {
  const baseURL = value(env.PUBLIC_ORIGIN)?.replace(/\/+$/, "") ?? "http://localhost:8787";
  const secret = value(env.BETTER_AUTH_SECRET);
  const githubClientId = value(env.GITHUB_CLIENT_ID);
  const githubClientSecret = value(env.GITHUB_CLIENT_SECRET);
  const adminGithubLogin = value(env.ADMIN_GITHUB_LOGIN);
  const githubReady = Boolean(
    secret && githubClientId && githubClientSecret && adminGithubLogin,
  );

  if (!githubReady) {
    return createSetupIncompleteAuth({ message: AUTH_NOT_CONFIGURED });
  }

  const methods: AuthMethodConfig[] = [{
    kind: "social",
    provider: "github",
    clientId: githubClientId!,
    clientSecret: githubClientSecret!,
  }];

  return createAuth({
    database: env.DB,
    baseURL,
    secret: secret!,
    methods,
    bootstrapOwner: { match: "github-login", value: adminGithubLogin! },
  });
}

/** Return the setup response only for Auth-owned private surfaces. */
export async function setupIncompleteAuthResponse(
  request: Request,
  auth: Auth,
): Promise<Response | null> {
  if (!isSetupIncompleteAuth(auth) || !isAuthProtectedPath(request, auth)) return null;
  return applyCachePolicy(request, await auth.handler(request));
}

function isAuthProtectedPath(request: Request, auth: Auth): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === "/admin"
    || pathname.startsWith("/admin/")
    || pathname === auth.basePath
    || pathname.startsWith(`${auth.basePath}/`)
    || pathname === OAUTH_AUTHORIZE_PATH
    || pathname === OAUTH_TOKEN_PATH
    || pathname === OAUTH_REGISTER_PATH
    || pathname.startsWith("/.well-known/oauth")
    || pathname === "/mcp"
    || pathname.startsWith("/mcp/");
}

function value(raw: string | undefined): string | null {
  return raw?.trim() || null;
}
