/** Optional provider integration. Better Auth owns signatures, PKCE, redirects and token rotation. */
import type { AuthContext, BetterAuthOptions } from "@better-auth/core";
import type { oauthProvider } from "@better-auth/oauth-provider";
import type { AuthInstance } from "./caller.js";
import { nativeAuthRead } from "./adapter.js";
import { ContractError } from "../kernel/contracts.js";

const pair = (field: string, value: string) => ({ field, value });
const array = (value: unknown): string[] | null => {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) && parsed.every(x => typeof x === "string") ? parsed : null; } catch { return null; }
};

/** Fail closed for unbound tokens; reconsent cannot resurrect an issued JWT. */
export async function assertActiveUserGrant(auth: AuthInstance, claims: Record<string, unknown>, audience: string | readonly string[]) {
  const { sub, azp, sid, mantle_consent_id: id, mantle_consent_reference: reference, mantle_skip_consent: skip } = claims;
  if (![sub, azp, sid].every(x => typeof x === "string" && x.length) || !(skip === true && id === null || typeof id === "string" && id.length)) throw new ContractError("UNAUTHENTICATED", "OAuth token is not bound to a user session.");
  const { exec, param, now, table, column } = nativeAuthRead(auth.options);
  const c = (field: string) => `c.${column("oauthConsent", field)}`, s = (field: string) => `s.${column("session", field)}`, client = (field: string) => `client.${column("oauthClient", field)}`;
  const { rows } = await exec(`SELECT ${s("userId")} AS id, ${c("id")} AS "consentId", ${c("referenceId")} AS reference, ${c("resources")} AS resources, ${c("scopes")} AS scopes,
      ${client("skipConsent")} AS "skipConsent", ${client("disabled")} AS disabled, ${client("scopes")} AS "clientScopes"
    FROM ${table("oauthClient")} client JOIN ${table("session")} s ON ${s("id")} = ${param(1)} AND ${s("userId")} = ${param(2)} AND ${s("expiresAt")} > ${param(3)}
    LEFT JOIN ${table("oauthConsent")} c ON ${c("id")} = ${param(4)} AND ${c("userId")} = ${s("userId")} AND ${c("clientId")} = ${client("clientId")}
    WHERE ${client("clientId")} = ${param(5)}`, [sid, sub, now(Date.now()), id, azp]);
  const grant = rows[0];
  const provider = auth.options.plugins?.find(plugin => plugin.id === "oauth-provider") as { options?: { scopes?: string[] } } | undefined;
  const firstParty = skip === true && id === null && !!grant?.skipConsent;
  const resources = firstParty ? (typeof claims.aud === "string" ? [claims.aud] : array(claims.aud)) : array(grant?.resources);
  const scopes = firstParty ? array(grant?.clientScopes) ?? provider?.options?.scopes : array(grant?.scopes);
  const requested = typeof audience === "string" ? [audience] : audience;
  const tokenAudiences = typeof claims.aud === "string" ? [claims.aud] : array(claims.aud) ?? [];
  const tokenScopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : array(claims.scope);
  if (!grant || grant.disabled || !firstParty && (!grant.consentId || (grant.reference ?? null) !== reference) || !resources || !scopes || !tokenScopes || !requested.some(x => resources.includes(x) && tokenAudiences.includes(x)) || !tokenScopes.every(x => scopes.includes(x))) throw new ContractError("UNAUTHENTICATED", "OAuth authorization grant is no longer active.");
  return { id: grant.id as string };
}

/** Add first to oauthProvider/mcp extensions; Better Auth retains ownership of referenceId. */
export const oauthGrantExtension: NonNullable<Parameters<typeof oauthProvider>[0]["extensions"]>[number] = {
  claims: { accessToken: async ({ ctx, user, client, referenceId }) => {
    if (client.skipConsent) return { mantle_consent_id: null, mantle_skip_consent: true };
    const consent = user && await ctx.context.adapter.findOne<{ id: string }>({ model: "oauthConsent", where: [pair("userId", user.id), pair("clientId", client.clientId), { field: "referenceId", value: referenceId ?? null }] });
    return { mantle_consent_id: consent?.id ?? null, mantle_consent_reference: referenceId ?? null };
  } },
};

/** A verification value that is an authorization code, with its user and client; else undefined. */
function authCode(text: string): { userId: string; query: { client_id: string } } | undefined {
  let value;
  try { value = JSON.parse(text); } catch { return; }
  return value?.type === "authorization_code" && typeof value.userId === "string" && typeof value.query?.client_id === "string" ? value : undefined;
}

export interface OAuthConsentRequest { readonly clientName: string; readonly redirectUri: string; readonly scopes: readonly string[]; readonly oauthQuery: string }
export interface OAuthConsentInfo { readonly id: string; readonly clientId: string; readonly clientName: string; readonly scopes: readonly string[] }

/** Signed-query and consent APIs over the same application-owned instance and adapter (including renamed tables). */
export function oauthConsents(auth: AuthInstance & { handler(request: Request): Promise<Response> }) {
  const adapter = async () => (await auth.$context as AuthContext).adapter;
  return {
    getOAuthConsentRequest: async (request: Request): Promise<OAuthConsentRequest | null> => {
      const url = new URL(request.url), clientId = url.searchParams.get("client_id");
      if (!clientId || !url.search) return null;
      const api = auth.api as unknown as { getOAuthClientPublicPrelogin(input: { headers: Headers; body: { client_id: string; oauth_query: string } }): Promise<{ client_name?: string; redirect_uris?: string[] }> };
      const oauthQuery = url.search.slice(1);
      const client = await api.getOAuthClientPublicPrelogin({ headers: request.headers, body: { client_id: clientId, oauth_query: oauthQuery } });
      return { clientName: client.client_name ?? clientId, redirectUri: url.searchParams.get("redirect_uri") ?? client.redirect_uris?.[0] ?? "", scopes: (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean), oauthQuery };
    },
    completeOAuthConsent: async (request: Request, accept: boolean): Promise<string> => {
      const oauth_query = (await request.formData()).get("oauth_query");
      if (typeof oauth_query !== "string" || !oauth_query) throw new ContractError("INPUT_VALIDATION_FAILED", "Missing signed authorization request.");
      const headers = new Headers(request.headers); headers.set("content-type", "application/json"); headers.delete("content-length");
      const response = await auth.handler(new Request(new URL(`${auth.options.basePath ?? "/api/auth"}/oauth2/consent`, request.url).href, { method: "POST", headers, body: JSON.stringify({ accept, oauth_query }) }));
      const body = await response.json() as { url?: unknown };
      if (!response.ok || typeof body.url !== "string") throw new ContractError("INPUT_VALIDATION_FAILED", "Invalid authorization request.");
      return body.url;
    },
    listOAuthConsents: async (userId: string): Promise<OAuthConsentInfo[]> => {
      const { exec, param, table, column } = nativeAuthRead(auth.options);
      const c = (field: string) => `c.${column("oauthConsent", field)}`, client = (field: string) => `client.${column("oauthClient", field)}`;
      const { rows } = await exec(`SELECT ${c("id")} AS id, ${c("clientId")} AS "clientId", COALESCE(${client("name")}, ${c("clientId")}) AS "clientName", ${c("scopes")} AS scopes
        FROM ${table("oauthConsent")} c LEFT JOIN ${table("oauthClient")} client ON ${client("clientId")} = ${c("clientId")}
        WHERE ${c("userId")} = ${param(1)} ORDER BY ${c("updatedAt")} DESC, ${c("id")} ASC`, [userId]);
      return rows.map(row => ({ id: row.id as string, clientId: row.clientId as string, clientName: row.clientName as string, scopes: array(row.scopes) ?? [] }));
    },
    revokeOAuthConsent: async (userId: string, consentId: string): Promise<boolean> => {
      const db = await adapter();
      const consent = await db.findOne<{ clientId: string }>({ model: "oauthConsent", where: [pair("id", consentId), pair("userId", userId)] });
      if (!consent) return false;
      const where = [pair("userId", userId), pair("clientId", consent.clientId)];
      // Delete first: even if cleanup fails, every issued JWT fails the live-grant check immediately.
      await db.deleteMany({ model: "oauthConsent", where });
      for (const model of ["oauthRefreshToken", "oauthAccessToken"]) await db.updateMany({ model, where: [...where, { field: "revoked", value: null }], update: { revoked: new Date() } });
      // An unredeemed code would mint a new token lineage after reconsent.
      const code = (v: string) => { const x = authCode(v); return x?.userId === userId && x.query.client_id === consent.clientId; };
      const codes = [{ field: "value", operator: "contains" as const, value: JSON.stringify(userId) }, { field: "value", operator: "contains" as const, value: JSON.stringify(consent.clientId) }];
      for (let offset = 0; ;) {
        const page = await db.findMany<{ id: string; value: string }>({ model: "verification", where: codes, limit: 100, offset, sortBy: { field: "id", direction: "asc" } });
        const ids = page.filter(v => code(v.value)).map(v => v.id);
        if (ids.length) await db.deleteMany({ model: "verification", where: [{ field: "id", operator: "in", value: ids }] });
        if (page.length < 100) break;
        offset += page.length - ids.length;
      }
      return true;
    },
  };
}

/** Optional scheduled storage hygiene, not boot work or an authorization rule. Owned/CIMD clients survive. */
export async function pruneLegacyOAuthClients(auth: AuthInstance): Promise<number> {
  const { adapter } = await auth.$context as AuthContext;
  return adapter.deleteMany({ model: "oauthClient", where: [
    { field: "clientDiscoveryId", value: null }, { field: "userId", value: null }, { field: "referenceId", value: null },
    { field: "createdAt", operator: "lt", value: new Date(Date.now() - 90 * 86400_000) },
  ] });
}
