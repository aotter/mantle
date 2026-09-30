/** OAuth access tokens: JWT and DPoP verification, provider tokens, and the registered-client projection. */
import {
enforceDpopBinding,
isDpopBindingError,
parseAccessTokenAuthorization,
verifyJwsAccessToken,
type DpopReplayStore
} from "better-auth/oauth2";
import { type DatabaseDriver } from "../core/index.js";
import { dbOf } from "./db.js";

export type { OAuthProviderExtension } from "@better-auth/oauth-provider";
export type { AuthUserInfo,InviteUserResult,ListMembersArgs,MemberListResult,MemberUserInfo,StaffUserInfo } from "../admin/identity.js";

import { OAuthAccessTokenVerification,ProviderAccessToken,RegisteredOAuthClient } from "./types.js";
export async function getProviderAccessTokenForRequest(
  api: {
    getAccessToken(input: {
      headers: Headers;
      body: { accountId: string };
    }): Promise<unknown>;
  },
  request: Request,
  accountId: string,
  providerId: string,
): Promise<ProviderAccessToken> {
  const value = (await api.getAccessToken({
    headers: request.headers,
    body: { accountId },
  })) as {
    accessToken?: unknown;
    accessTokenExpiresAt?: unknown;
    scopes?: unknown;
  };
  if (typeof value?.accessToken !== "string") {
    throw new Error(`getProviderAccessToken: provider '${providerId}' returned no access token.`);
  }
  return {
    accessToken: value.accessToken,
    ...(value.accessTokenExpiresAt instanceof Date
      ? { accessTokenExpiresAt: value.accessTokenExpiresAt }
      : {}),
    scopes: Array.isArray(value.scopes)
      ? value.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
  };
}

function scopesFromClaim(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === "string");
  }
  return [];
}

export function parseStoredStringArray(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function assertActiveUserGrant(
  driver: DatabaseDriver,
  claims: Record<string, unknown>,
  audience: string,
): Promise<void> {
  const db = dbOf(driver);
  const userId = claims["sub"];
  const clientId = claims["azp"];
  const sessionId = claims["sid"];
  const consentId = claims["mantle_consent_id"];
  if (
    typeof userId !== "string" ||
    typeof clientId !== "string" ||
    typeof sessionId !== "string" ||
    typeof consentId !== "string" || !consentId
  ) {
    throw new Error("OAuth token is not bound to a user session.");
  }
  const result = await db.first<{ resources: string | null; scopes: string }>("SELECT c.resources, c.scopes FROM oauthConsent AS c " +
        "JOIN session AS s ON s.id = ? AND s.userId = c.userId AND s.expiresAt > ? " +
        "WHERE c.id = ? AND c.userId = ? AND c.clientId = ?", sessionId, new Date().toISOString(), consentId, userId, clientId);
  const tokenScopes = scopesFromClaim(claims["scope"]);
  const resources = parseStoredStringArray(result?.resources);
  const scopes = parseStoredStringArray(result?.scopes);
  const active = resources?.includes(audience) === true && scopes !== null &&
    tokenScopes.every((scope) => scopes.includes(scope));
  if (!active) throw new Error("OAuth authorization grant is no longer active.");
}

type LocalJwksFetcher = Exclude<
  Parameters<typeof verifyJwsAccessToken>[1]["jwksFetch"],
  string
>;

export function verifyOAuthJwtWithLocalJwks(
  token: string,
  audience: string,
  issuer: string,
  jwksFetch: LocalJwksFetcher,
  jwksCacheKey?: object,
): Promise<Record<string, unknown>> {
  return verifyJwsAccessToken(token, {
    jwksFetch,
    ...(jwksCacheKey ? { jwksCacheKey } : {}),
    verifyOptions: { audience, issuer },
  });
}

export async function verifyOAuthJwt(
  tokenOrRequest: string | Request,
  options: {
    readonly audience: string;
    readonly scopes?: readonly string[];
  },
  verify: ((token: string, audience: string) => Promise<Record<string, unknown>>) | null,
  getDpopReplayStore?: () => Promise<DpopReplayStore>,
): Promise<OAuthAccessTokenVerification> {
  const request = typeof tokenOrRequest === "string" ? null : tokenOrRequest;
  const authorization = parseAccessTokenAuthorization(
    request?.headers.get("authorization") ?? `Bearer ${tokenOrRequest}`,
  );
  const token = authorization?.token;
  // JWT compact serialization has exactly three non-empty parts.
  // Reject opaque tokens before any network/JWKS work.
  if (
    !verify ||
    !token ||
    token.split(".").length !== 3 ||
    token.split(".").some((part) => part.length === 0)
  ) {
    return { ok: false, status: 401, reason: "invalid-token" };
  }
  try {
    const claims = await verify(token, options.audience);
    await enforceDpopBinding({
      payload: claims,
      authorization,
      proofJwt: request?.headers.get("dpop"),
      method: request?.method ?? "GET",
      url: request?.url ?? options.audience,
      ...(request && authorization.scheme === "DPoP" && getDpopReplayStore
        ? { replayStore: await getDpopReplayStore() }
        : {}),
    });
    if (typeof claims["sub"] !== "string" || claims["sub"].length === 0) {
      return { ok: false, status: 401, reason: "invalid-token" };
    }
    const scopes = scopesFromClaim(claims["scope"]);
    const missingScopes = (options.scopes ?? []).filter(
      (scope) => !scopes.includes(scope),
    );
    if (missingScopes.length > 0) {
      return {
        ok: false,
        status: 403,
        reason: "insufficient-scope",
        missingScopes,
      };
    }
    return {
      ok: true,
      userId: claims["sub"],
      clientId: typeof claims["azp"] === "string" ? claims["azp"] : null,
      credentialId: typeof claims["jti"] === "string" ? claims["jti"] : null,
      scopes,
    };
  } catch (error) {
    if (isDpopBindingError(error)) {
      return { ok: false, status: 401, reason: "invalid-dpop-proof" };
    }
    return { ok: false, status: 401, reason: "invalid-token" };
  }
}

export function mapRegisteredOAuthClient(value: unknown): RegisteredOAuthClient {
  const row = value as {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
    scope?: string;
    client_name?: string;
    client_uri?: string;
    token_endpoint_auth_method?: string;
    application_type?: "web" | "native";
  };
  if (!row.client_id || !Array.isArray(row.redirect_uris)) {
    throw new Error("registerOAuthClient: Better Auth returned an invalid client.");
  }
  return {
    clientId: row.client_id,
    ...(row.client_secret && row.token_endpoint_auth_method !== "none"
      ? { clientSecret: row.client_secret }
      : {}),
    redirectUris: row.redirect_uris,
    ...(row.scope ? { scope: row.scope.split(" ").filter(Boolean) } : {}),
    ...(row.client_name ? { clientName: row.client_name } : {}),
    ...(row.client_uri ? { clientUri: row.client_uri } : {}),
    ...(row.token_endpoint_auth_method
      ? { tokenEndpointAuthMethod: row.token_endpoint_auth_method }
      : {}),
    ...(row.application_type ? { applicationType: row.application_type } : {}),
  };
}

