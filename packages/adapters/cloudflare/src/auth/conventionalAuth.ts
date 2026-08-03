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
  "Admin auth is not configured yet. Configure Mantle hosted auth or self-managed GitHub OAuth.";
const PLATFORM_AUTH_PROVIDER_ID = "mantle-platform";

export interface ConventionalAuthEnv {
  readonly DB: D1Database;
  readonly PUBLIC_ORIGIN?: string;
  readonly BETTER_AUTH_SECRET?: string;
  readonly MANTLE_PLATFORM_AUTH_ISSUER?: string;
  readonly MANTLE_PLATFORM_AUTH_CLIENT_ID?: string;
  readonly MANTLE_PLATFORM_AUTH_CLIENT_SECRET?: string;
  readonly MANTLE_SITE_OWNER_EMAIL?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly ADMIN_GITHUB_LOGIN?: string;
}

/** Choose Mantle hosted auth, self-managed GitHub OAuth, or a fail-closed facade. */
export function createConventionalAuth(env: ConventionalAuthEnv): Auth {
  const baseURL = value(env.PUBLIC_ORIGIN)?.replace(/\/+$/, "") ?? "http://localhost:8787";
  const secret = value(env.BETTER_AUTH_SECRET);
  const issuer = normalizedPlatformIssuer(env.MANTLE_PLATFORM_AUTH_ISSUER);
  const platformClientId = value(env.MANTLE_PLATFORM_AUTH_CLIENT_ID);
  const platformClientSecret = value(env.MANTLE_PLATFORM_AUTH_CLIENT_SECRET);
  const ownerEmail = value(env.MANTLE_SITE_OWNER_EMAIL);
  const githubClientId = value(env.GITHUB_CLIENT_ID);
  const githubClientSecret = value(env.GITHUB_CLIENT_SECRET);
  const adminGithubLogin = value(env.ADMIN_GITHUB_LOGIN);
  const hostedReady = Boolean(secret && issuer && platformClientId && ownerEmail);
  const githubReady = Boolean(
    secret && githubClientId && githubClientSecret && adminGithubLogin,
  );

  if (!hostedReady && !githubReady) {
    return createSetupIncompleteAuth({ message: AUTH_NOT_CONFIGURED });
  }

  const methods: AuthMethodConfig[] = hostedReady
    ? [{
        kind: "oauth",
        providerId: PLATFORM_AUTH_PROVIDER_ID,
        displayName: "Mantle Platform",
        clientId: platformClientId!,
        ...(platformClientSecret ? { clientSecret: platformClientSecret } : {}),
        discoveryUrl: `${issuer}/.well-known/openid-configuration`,
        issuer: issuer!,
        requireIssuerValidation: true,
        scopes: ["openid", "profile", "email"],
        redirectURI: `${baseURL}/api/auth/oauth2/callback/${PLATFORM_AUTH_PROVIDER_ID}`,
        pkce: true,
      }]
    : [{
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
    bootstrapOwner: hostedReady
      ? { match: "email", value: ownerEmail! }
      : { match: "github-login", value: adminGithubLogin! },
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

function normalizedPlatformIssuer(raw: string | undefined): string | null {
  const issuer = value(raw)?.replace(/\/+$/, "") ?? null;
  if (!issuer) return null;
  return issuer.endsWith("/api/auth") ? issuer : `${issuer}/api/auth`;
}

function value(raw: string | undefined): string | null {
  return raw?.trim() || null;
}
