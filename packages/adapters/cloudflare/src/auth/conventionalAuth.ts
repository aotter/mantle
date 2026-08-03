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
const HOSTED_GITHUB_PROVIDER_ID = "github";

export interface ConventionalAuthEnv {
  readonly DB: D1Database;
  readonly PUBLIC_ORIGIN?: string;
  readonly BETTER_AUTH_SECRET?: string;
  readonly MANTLE_HOSTED_AUTH_ISSUER?: string;
  readonly MANTLE_HOSTED_AUTH_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly ADMIN_GITHUB_LOGIN?: string;
}

/** Choose Mantle hosted auth, self-managed GitHub OAuth, or a fail-closed facade. */
export function createConventionalAuth(env: ConventionalAuthEnv): Auth {
  const baseURL = value(env.PUBLIC_ORIGIN)?.replace(/\/+$/, "") ?? "http://localhost:8787";
  const secret = value(env.BETTER_AUTH_SECRET);
  const issuer = normalizedHostedIssuer(env.MANTLE_HOSTED_AUTH_ISSUER);
  const hostedClientId = normalizedHostedClientId(env.MANTLE_HOSTED_AUTH_CLIENT_ID, issuer);
  const githubClientId = value(env.GITHUB_CLIENT_ID);
  const githubClientSecret = value(env.GITHUB_CLIENT_SECRET);
  const adminGithubLogin = value(env.ADMIN_GITHUB_LOGIN);
  const hostedReady = Boolean(secret && issuer && hostedClientId && adminGithubLogin);
  const githubReady = Boolean(
    secret && githubClientId && githubClientSecret && adminGithubLogin,
  );

  if (!hostedReady && !githubReady) {
    return createSetupIncompleteAuth({ message: AUTH_NOT_CONFIGURED });
  }

  const methods: AuthMethodConfig[] = hostedReady
    ? [{
        kind: "oauth",
        providerId: HOSTED_GITHUB_PROVIDER_ID,
        displayName: "GitHub",
        clientId: hostedClientId!,
        authorizationUrl: `${issuer}/authorize`,
        tokenUrl: `${issuer}/token`,
        userInfoUrl: `${issuer}/userinfo`,
        scopes: ["profile", "email"],
        redirectURI: `${baseURL}/api/auth/oauth2/callback/${HOSTED_GITHUB_PROVIDER_ID}`,
        pkce: true,
        mapProfileToUser: mapHostedGithubProfile,
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

function normalizedHostedIssuer(raw: string | undefined): string | null {
  try {
    const url = new URL(value(raw) ?? "");
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizedHostedClientId(raw: string | undefined, issuer: string | null): string | null {
  try {
    const url = new URL(value(raw) ?? "");
    if (!issuer || url.origin !== issuer || !url.pathname.startsWith("/clients/") || url.search || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** @internal exported for focused contract tests. */
export function mapHostedGithubProfile(profile: Readonly<Record<string, unknown>>) {
  const githubLogin = validGithubLogin(profile.github_login);
  return githubLogin ? { githubLogin } : {};
}

function validGithubLogin(raw: unknown): string | null {
  return typeof raw === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(raw)
    ? raw
    : null;
}

function value(raw: string | undefined): string | null {
  return raw?.trim() || null;
}
