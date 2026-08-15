import {
  createAuth,
  createSetupIncompleteAuth,
  isSetupIncompleteAuth,
  type Auth,
} from "./createAuth.js";
import {
  OAUTH_AUTHORIZE_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_TOKEN_PATH,
} from "../oauth/oauthConstants.js";
import { applyCachePolicy } from "../oauth/cachePolicy.js";

export interface ConventionalAuthEnv {
  readonly DB: D1Database;
  readonly PUBLIC_ORIGIN?: string;
  readonly BETTER_AUTH_SECRET?: string;
  readonly MANTLE_AUTH_MODE?: string;
  readonly MANTLE_HOSTED_AUTH_ISSUER?: string;
  readonly MANTLE_HOSTED_AUTH_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly ADMIN_GITHUB_LOGIN?: string;
}

/** Choose hosted or self-managed GitHub Auth, otherwise fail closed. */
export function createConventionalAuth(env: ConventionalAuthEnv): Auth {
  const mode = value(env.MANTLE_AUTH_MODE);
  const secret = value(env.BETTER_AUTH_SECRET);
  const owner = githubLogin(env.ADMIN_GITHUB_LOGIN);
  const hostedIssuerRaw = value(env.MANTLE_HOSTED_AUTH_ISSUER);
  const hostedClientIdRaw = value(env.MANTLE_HOSTED_AUTH_CLIENT_ID);
  const hostedIssuer = hostedOrigin(hostedIssuerRaw);
  const hostedClientId = hostedClient(hostedClientIdRaw, hostedIssuer);
  const githubClientId = value(env.GITHUB_CLIENT_ID);
  const githubClientSecret = value(env.GITHUB_CLIENT_SECRET);
  const baseURL = value(env.PUBLIC_ORIGIN)?.replace(/\/+$/, "") ?? "http://localhost:8787";

  if (mode === "hosted") {
    if (!secret || !owner || !hostedIssuer || !hostedClientId || githubClientId || githubClientSecret) {
      return authConfigurationError("Hosted", [
        !secret ? "BETTER_AUTH_SECRET is not set" : null,
        !owner ? "ADMIN_GITHUB_LOGIN is not set or invalid" : null,
        !hostedIssuer
          ? `MANTLE_HOSTED_AUTH_ISSUER is ${hostedIssuerRaw ? "invalid" : "not set"}`
          : null,
        !hostedClientId
          ? `MANTLE_HOSTED_AUTH_CLIENT_ID is ${hostedClientIdRaw ? "invalid" : "not set"}`
          : null,
        githubClientId ? "GITHUB_CLIENT_ID is set" : null,
        githubClientSecret ? "GITHUB_CLIENT_SECRET is set" : null,
      ]);
    }
    return createAuth({
      database: env.DB,
      baseURL,
      secret,
      methods: [{
        kind: "oauth",
        providerId: "github",
        displayName: "GitHub",
        clientId: hostedClientId,
        authorizationUrl: `${hostedIssuer}/authorize`,
        tokenUrl: `${hostedIssuer}/token`,
        userInfoUrl: `${hostedIssuer}/userinfo`,
        scopes: ["profile", "email"],
        redirectURI: `${baseURL}/api/auth/oauth2/callback/github`,
        pkce: true,
        mapProfileToUser: (profile) => {
          const login = githubLogin(profile.github_login);
          return login ? { githubLogin: login } : {};
        },
      }],
      bootstrapOwner: { match: "github-login", value: owner },
    });
  }

  if (mode === "self-managed") {
    if (!secret || !owner || !githubClientId || !githubClientSecret || hostedIssuerRaw || hostedClientIdRaw) {
      return authConfigurationError("Self-managed", [
        !secret ? "BETTER_AUTH_SECRET is not set" : null,
        !owner ? "ADMIN_GITHUB_LOGIN is not set or invalid" : null,
        !githubClientId ? "GITHUB_CLIENT_ID is not set" : null,
        !githubClientSecret ? "GITHUB_CLIENT_SECRET is not set" : null,
        hostedIssuerRaw ? "MANTLE_HOSTED_AUTH_ISSUER is set" : null,
        hostedClientIdRaw ? "MANTLE_HOSTED_AUTH_CLIENT_ID is set" : null,
      ]);
    }
    return createAuth({
      database: env.DB,
      baseURL,
      secret,
      methods: [{
        kind: "social",
        provider: "github",
        clientId: githubClientId,
        clientSecret: githubClientSecret,
      }],
      bootstrapOwner: { match: "github-login", value: owner },
    });
  }

  return incomplete("MANTLE_AUTH_MODE must be hosted or self-managed.");
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

function incomplete(message: string): Auth {
  return createSetupIncompleteAuth({ message });
}

function authConfigurationError(
  mode: string,
  problems: readonly (string | null)[],
): Auth {
  const errors = problems.filter((problem): problem is string => problem !== null);
  return incomplete(`${mode} Auth configuration errors: ${errors.join("; ")}.`);
}

function hostedOrigin(raw: string | null): string | null {
  try {
    const url = new URL(value(raw) ?? "");
    if (!secureOrLoopback(url) || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function hostedClient(raw: string | null, issuer: string | null): string | null {
  try {
    const url = new URL(value(raw) ?? "");
    return issuer && secureOrLoopback(url) && url.origin === issuer && /^\/clients\/[A-Za-z0-9_-]{1,128}$/u.test(url.pathname) && !url.search && !url.hash
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function secureOrLoopback(url: URL): boolean {
  return !url.username && !url.password && (url.protocol === "https:" || (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  ));
}

function githubLogin(raw: unknown): string | null {
  return typeof raw === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(raw.trim())
    ? raw.trim()
    : null;
}

function value(raw: string | null | undefined): string | null {
  return raw?.trim() || null;
}
