import { getMigrations } from "better-auth/db/migration";
import { createDpopReplayStore, type DpopReplayStore } from "better-auth/oauth2";
import { decodeMemberCursor, encodeMemberCursor } from "../admin/consent.js";
import type { StaffUserInfo } from "../admin/identity.js";
import { runMigrations } from "../core/index.js";
import { STAFF_ROLES, type StaffRole } from "../spec/domain/index.js";
import { dbOf } from "./db.js";
import { staffInvitationEmail } from "./emailTemplates.js";

import { backgroundTaskRetention, buildAuth } from "./buildAuth.js";
import { normalizeAuthBasePath, normalizeAuthResponseCookies } from "./methods.js";
import { assertActiveUserGrant, getProviderAccessTokenForRequest, mapRegisteredOAuthClient, parseStoredStringArray, verifyOAuthJwt, verifyOAuthJwtWithLocalJwks } from "./oauthTokens.js";
import { type AuthMethodInfo, type CreateMantleAuthOptions, type MantleAuth, STAFF_ROLE_SET } from "./types.js";
const LEGACY_DCR_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const LEGACY_DCR_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

export function createMantleAuth(config: CreateMantleAuthOptions): MantleAuth {
  const db = dbOf(config.driver);
  const auth = buildAuth(config);
  const ready = auth.$context.then(() => undefined);
  // Observe eager initialization even for low-level callers; keep the original
  // rejection available to callers awaiting ready and Better Auth's handlers.
  void ready.catch(() => {});
  // Auth owns its schema even when content uses a different semantic store.
  // Keep schema work lazy: static/plan-only routes must not prepare tables.
  let schemaReady: Promise<void> | null = null;
  const prepareAuth = (): Promise<void> => schemaReady ??= (async () => {
    const context = await auth.$context;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(context.tables)));
    const id = `auth-schema:1:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
    try {
      const applied = await db.first<{ id: string }>("SELECT id FROM _mantle_migrations WHERE id = ?1", id);
      if (applied?.id === id) return;
    } catch (error) {
      // A new, auth-only or pre-#1150 database has no ledger yet; the runner creates it.
      if (!/no such table: _mantle_migrations/i.test(String(error))) throw error;
    }
    const { compileMigrations } = await getMigrations(context.options);
    await runMigrations(config.driver, [{
      id,
      sql: `${await compileMigrations()}\nCREATE INDEX IF NOT EXISTS user_role_idx ON user (role) WHERE role IS NOT NULL;`,
    }]);
  })().catch(error => { schemaReady = null; throw error; });

  const basePath = normalizeAuthBasePath(config.basePath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = auth.api as any;
  const localJwksCacheKey = {};
  let dpopReplayStore: DpopReplayStore | null = null;
  const getDpopReplayStore = async (): Promise<DpopReplayStore> => {
    if (dpopReplayStore) return dpopReplayStore;
    const context = await auth.$context;
    dpopReplayStore = createDpopReplayStore(context.internalAdapter);
    return dpopReplayStore;
  };
  const verifyAccessToken = config.oauthProvider
    ? async (token: string, audience: string) => {
        await prepareAuth();
        const context = await auth.$context;
        const claims = await verifyOAuthJwtWithLocalJwks(
          token,
          audience,
          context.baseURL,
          async () => api.getJwks(),
          localJwksCacheKey,
        );
        if (config.oauthProvider?.mcpResource && (audience === config.oauthProvider.mcpResource || config.oauthProvider.resources?.includes(audience))) {
          await assertActiveUserGrant(config.driver, claims, audience);
        }
        return claims;
      }
    : null;
  let nextDcrCleanupAt = 0;

  const pruneExpiredDynamicClients = async (): Promise<void> => {
    const now = Date.now();
    if (!config.oauthProvider?.mcpResource || now < nextDcrCleanupAt) return;
    // Set before awaiting so concurrent OAuth requests do not fan out writes.
    nextDcrCleanupAt = now + LEGACY_DCR_CLEANUP_INTERVAL_MS;
    try {
      await db.run("DELETE FROM oauthClient WHERE clientDiscoveryId IS NULL AND userId IS NULL AND referenceId IS NULL AND createdAt < ?", new Date(now - LEGACY_DCR_TTL_MS).toISOString());
    } catch (error) {
      // Cleanup is bounded storage hygiene, not an authorization decision.
      console.error("[better-auth] legacy DCR cleanup failed", error);
    }
  };

  const readUserRole = async (userId: string): Promise<string | null> => {
    await prepareAuth();
    const row = await db.first<{ role: string | null }>("SELECT role FROM user WHERE id = ? LIMIT 1", userId);
    return row?.role ?? null;
  };
  // A session user is a fresh database read unless a KV session cache or a
  // cookie cache serves it; a cached snapshot only follows cache propagation.
  // Plugins merge their `init` options into the context, not `auth.options`.
  let cachedSessions: Promise<boolean> | undefined;
  const sessionsAreCached = (): Promise<boolean> => cachedSessions ??= config.sessionCache
    ? Promise.resolve(true)
    : auth.$context.then((context) => Boolean(
        (context.options as { session?: { cookieCache?: { enabled?: boolean } } }).session?.cookieCache?.enabled));

  return {
    basePath,
    ready,
    ...(config.oauthProvider?.mcpResource
      ? { mcpResource: config.oauthProvider.mcpResource }
      : {}),
    handler: (request, context) => {
      const serve = async (): Promise<Response> => {
        await prepareAuth();
        const pathname = new URL(request.url).pathname;
        if (pathname.startsWith(`${basePath}/oauth2/`)) {
          await pruneExpiredDynamicClients();
        }
        // Better Auth's admin endpoints authorize from the session snapshot.
        // Refuse them while that snapshot's role disagrees with the database.
        if (pathname.startsWith(`${basePath}/admin/`) && await sessionsAreCached()) {
          let session;
          try {
            // Read the snapshot the admin middleware will authorize from (it skips the cookie cache).
            session = await api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
          } catch {
            return Response.json({ code: "SERVICE_UNAVAILABLE", message: "Could not verify the staff role." }, { status: 503 });
          }
          if (session && ((session.user as { role?: string | null }).role ?? null) !== await readUserRole(session.user.id)) {
            return Response.json({ code: "FORBIDDEN", message: "Staff role changed; sign in again." }, { status: 403 });
          }
        }
        return normalizeAuthResponseCookies(await auth.handler(request));
      };
      const retain = context?.waitUntil;
      return retain ? backgroundTaskRetention.run(retain, serve) : serve();
    },
    getSession: async (request) => {
      let session;
      try {
        session = await api.getSession({ headers: request.headers });
      } catch {
        // Existing sessions resolve from KV without paying the schema-ledger read.
        // A fresh database with a stale cookie prepares once, then retries safely.
        await prepareAuth();
        session = await api.getSession({ headers: request.headers });
      }
      // A cached snapshot never vouches for a staff role, so callers re-read it
      // and a demoted user is locked out immediately (ADR-0014 §5). A cached
      // non-staff role may be trusted: at worst a fresh promotion waits for
      // the cache, which fails closed.
      const role = (session?.user as { role?: string | null } | undefined)?.role;
      return session
        ? {
            ...session,
            user: {
              ...session.user,
              ...(Object.hasOwn(session.user, "role") && (!await sessionsAreCached() || !STAFF_ROLE_SET.has(role ?? ""))
                ? { roleCurrent: true as const }
                : {}),
            },
          }
        : null;
    },
    getUserRole: readUserRole,
    getUser: async (userId) => {
      await prepareAuth();
      const row = await db.first<{
          id: string;
          email: string;
          name: string;
          image: string | null;
          role: string | null;
          githubLogin: string | null;
          emailVerified: number;
          createdAt: string;
        }>("SELECT id, email, name, image, role, githubLogin, emailVerified, createdAt FROM user WHERE id = ? LIMIT 1", userId);
      if (!row) return null;
      const createdAt = new Date(row.createdAt);
      if (Number.isNaN(createdAt.getTime())) {
        throw new Error("Auth user row has an invalid createdAt timestamp.");
      }
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        image: row.image,
        role: row.role,
        githubLogin: row.githubLogin,
        emailVerified: row.emailVerified !== 0,
        createdAt,
      };
    },
    getProviderAccessToken: async (request, providerId) => {
      await prepareAuth();
      const session = await api.getSession({ headers: request.headers });
      const userId = session?.user?.id;
      const account = userId
        ? await db.first<{ id: string }>("SELECT id FROM account WHERE userId = ? AND providerId = ? LIMIT 1", userId, providerId)
        : null;
      if (!account) {
        throw new Error(`getProviderAccessToken: provider '${providerId}' is not linked to the current user.`);
      }
      return getProviderAccessTokenForRequest(api, request, account.id, providerId);
    },
    verifyOAuthAccessToken: async (tokenOrRequest, options) => {
      return verifyOAuthJwt(
        tokenOrRequest,
        options,
        verifyAccessToken,
        getDpopReplayStore,
      );
    },
    getOAuthConsentRequest: async (request) => {
      if (!config.oauthProvider) return null;
      const url = new URL(request.url);
      const clientId = url.searchParams.get("client_id");
      if (!clientId || !url.search) return null;
      await prepareAuth();
      const oauthQuery = url.search.slice(1);
      const client = await api.getOAuthClientPublicPrelogin({
        headers: request.headers,
        body: { client_id: clientId, oauth_query: oauthQuery },
      });
      const redirectUri = url.searchParams.get("redirect_uri") ??
        (Array.isArray(client?.redirect_uris) &&
            typeof client.redirect_uris[0] === "string"
          ? client.redirect_uris[0]
          : "");
      return {
        clientName: typeof client?.client_name === "string"
          ? client.client_name
          : clientId,
        redirectUri,
        scopes: (url.searchParams.get("scope") ?? "")
          .split(/\s+/u)
          .filter(Boolean),
        oauthQuery,
      };
    },
    completeOAuthConsent: async (request, accept) => {
      if (!config.oauthProvider) {
        throw new Error("completeOAuthConsent: oauthProvider is not configured.");
      }
      const form = await request.formData();
      const oauthQuery = form.get("oauth_query");
      if (typeof oauthQuery !== "string" || oauthQuery.length === 0) {
        throw new Error("completeOAuthConsent: oauth_query is missing.");
      }
      await prepareAuth();
      const headers = new Headers(request.headers);
      headers.set("content-type", "application/json");
      headers.delete("content-length");
      const response = await auth.handler(new Request(
        new URL(`${basePath}/oauth2/consent`, request.url),
        {
          method: "POST",
          headers,
          body: JSON.stringify({ accept, oauth_query: oauthQuery }),
        },
      ));
      if (!response.ok) {
        throw new Error(`completeOAuthConsent: Better Auth returned ${response.status}.`);
      }
      const result = await response.json() as { url?: unknown };
      if (!result || typeof result.url !== "string") {
        throw new Error("completeOAuthConsent: Better Auth omitted the redirect URL.");
      }
      return result.url;
    },
    ...(config.oauthProvider
      ? {
          listOAuthConsents: async (userId: string) => {
            await prepareAuth();
            const result = await db.all<{
                id: string;
                clientId: string;
                clientName: string;
                scopes: string;
              }>(`SELECT consent.id, consent.clientId,
                        COALESCE(client.name, consent.clientId) AS clientName,
                        consent.scopes
                   FROM oauthConsent AS consent
                   LEFT JOIN oauthClient AS client ON client.clientId = consent.clientId
                  WHERE consent.userId = ?
                  ORDER BY consent.updatedAt DESC, consent.id ASC`, userId);
            return result.map((row) => ({
              id: row.id,
              clientId: row.clientId,
              clientName: row.clientName,
              scopes: parseStoredStringArray(row.scopes) ?? [],
            }));
          },
          revokeOAuthConsent: async (userId: string, consentId: string) => {
            await prepareAuth();
            const consent = await db.first<{ clientId: string }>("SELECT clientId FROM oauthConsent WHERE id = ? AND userId = ? LIMIT 1", consentId, userId);
            if (!consent) return false;
            const revokedAt = new Date().toISOString();
            await db.batch([
              { sql: "UPDATE oauthRefreshToken SET revoked = ? WHERE userId = ? AND clientId = ? AND revoked IS NULL", binds: [revokedAt, userId, consent.clientId] },
              { sql: "UPDATE oauthAccessToken SET revoked = ? WHERE userId = ? AND clientId = ? AND revoked IS NULL", binds: [revokedAt, userId, consent.clientId] },
              { sql: `DELETE FROM verification
                    WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.type') END = 'authorization_code'
                      AND CASE WHEN json_valid(value) THEN json_extract(value, '$.userId') END = ?
                      AND CASE WHEN json_valid(value) THEN json_extract(value, '$.query.client_id') END = ?`, binds: [userId, consent.clientId] },
              { sql: "DELETE FROM oauthConsent WHERE userId = ? AND clientId = ?", binds: [userId, consent.clientId] },
            ]);
            return true;
          },
        }
      : {}),
    methods: config.methods.map<AuthMethodInfo>((m) => {
      switch (m.kind) {
        case "social":
          return { kind: "social", provider: m.provider };
        case "oauth":
          return {
            kind: "oauth",
            providerId: m.options.providerId,
            ...(m.displayName ? { displayName: m.displayName } : {}),
          };
        case "email-otp":
        case "magic-link":
          return { kind: m.kind };
      }
    }),
    listLinkedAccounts: async (userId) => {
      await prepareAuth();
      const result = await db.all<{
          id: string;
          providerId: string;
          accountId: string;
          createdAt: string;
          updatedAt: string;
        }>("SELECT id, providerId, accountId, createdAt, updatedAt FROM account WHERE userId = ? ORDER BY createdAt ASC, id ASC", userId);
      return result.map((row) => ({
        id: row.id,
        providerId: row.providerId,
        accountId: row.accountId,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      }));
    },
    unlinkAccount: async (userId, providerId) => {
      await prepareAuth();
      const result = await db.run("DELETE FROM account WHERE userId = ? AND providerId = ?", userId, providerId);
      return (result.meta?.changes ?? 0) > 0;
    },
    listUsers: async (request) => {
      await prepareAuth();
      const { users } = await api.listUsers({
        headers: request.headers,
        query: { filterField: "role", filterOperator: "in", filterValue: [...STAFF_ROLES], sortBy: "createdAt", sortDirection: "asc" },
      }) as { users: StaffUserInfo[] };
      return users.map(({ id, email, name, role, githubLogin, emailVerified, createdAt }) => ({ id, email, name, role, githubLogin: githubLogin ?? null, emailVerified, createdAt: new Date(createdAt) }));
    },
    listMembers: async ({ search, cursor, cursorDirection = "forward", limit }) => {
      await prepareAuth();
      const parsedCursor = cursor ? decodeMemberCursor(cursor) : null;
      const backward = cursorDirection === "backward";
      const conditions = [
        `(role IS NULL OR role NOT IN (${STAFF_ROLES.map(() => "?").join(",")}))`,
      ];
      const bindings: unknown[] = [...STAFF_ROLES];
      const term = search?.trim().toLowerCase();
      if (term) {
        conditions.push("(LOWER(id) LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\')");
        const like = `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
        bindings.push(like, like, like);
      }
      if (parsedCursor) {
        const operator = backward ? "<" : ">";
        conditions.push(`(createdAt ${operator} ? OR (createdAt = ? AND id ${operator} ?))`);
        bindings.push(parsedCursor[0], parsedCursor[0], parsedCursor[1]);
      }
      bindings.push(limit + 1);
      const result = await db.all<{
          id: string;
          email: string;
          name: string;
          emailVerified: number;
          createdAt: string;
        }>(`SELECT id, email, name, emailVerified, createdAt FROM user WHERE ${conditions.join(" AND ")} ORDER BY createdAt ${backward ? "DESC" : "ASC"}, id ${backward ? "DESC" : "ASC"} LIMIT ?`, ...bindings);
      const rows = result.slice(0, limit);
      if (backward) rows.reverse();
      const items = rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        emailVerified: row.emailVerified !== 0,
        createdAt: new Date(row.createdAt),
      }));
      const hasMore = result.length > limit;
      return {
        items,
        previousCursor:
          (backward ? hasMore : Boolean(parsedCursor)) && rows[0]
            ? encodeMemberCursor(rows[0].createdAt, rows[0].id)
            : null,
        nextCursor:
          (backward ? Boolean(parsedCursor) : hasMore) && rows.at(-1)
            ? encodeMemberCursor(rows.at(-1)!.createdAt, rows.at(-1)!.id)
            : null,
      };
    },
    setUserRole: async (request, userId, role) => {
      if (role !== null && !STAFF_ROLE_SET.has(role)) {
        throw new Error(`setUserRole: '${role}' is not a staff role — expected one of [${STAFF_ROLES.join(", ")}] or null.`);
      }
      await prepareAuth();
      try {
        // Better Auth's default role is not staff, so it is what revoking stores
        await api.setRole({ headers: request.headers, body: { userId, role: role ?? "user" } });
        return true;
      } catch (error) {
        if ((error as { status?: unknown }).status === "NOT_FOUND") return false;
        throw error;
      }
    },
    inviteUser: async (request, email, role) => {
      if (!STAFF_ROLE_SET.has(role)) {
        throw new Error(`inviteUser: '${role}' is not a staff role — expected one of [${STAFF_ROLES.join(", ")}].`);
      }
      await prepareAuth();
      const normalized = email.trim().toLowerCase();
      const headers = request.headers;
      const { users } = await api.listUsers({ headers, query: { filterField: "email", filterValue: normalized, limit: 1 } }) as { users: { id: string }[] };
      if (users[0]) return { kind: "exists", id: users[0].id };
      // `name` is the address's local part until the invitee's first sign-in brings a real one; the row starts unverified
      const { user } = await api.createUser({ headers, body: { email: normalized, name: normalized.split("@")[0] || normalized, role } }) as { user: { id: string } };
      return { kind: "created", id: user.id };
    },
    ...(config.staffInvitationSender ? {
      sendStaffInvitation: async (email: string, role: StaffRole) => {
        const normalized = email.trim().toLowerCase();
        await config.staffInvitationSender!.send({
          to: normalized,
          ...staffInvitationEmail(role, new URL("/admin/sign-in", config.baseURL).href),
          locale: "en",
          category: "auth.staff-invitation",
        });
      },
    } : {}),
    revokeInvite: async (userId) => {
      await prepareAuth();
      const result = await db.run("DELETE FROM user WHERE id = ? AND emailVerified = 0 AND NOT EXISTS (SELECT 1 FROM account WHERE account.userId = user.id)", userId);
      return (result.meta?.changes ?? 0) > 0;
    },
    deleteUser: async (userId) => {
      await prepareAuth();
      // no session to act as, so Better Auth's own delete, which also clears cached sessions
      const context = await auth.$context;
      if (!await context.internalAdapter.findUserById(userId)) return false;
      await context.internalAdapter.deleteUser(userId);
      return true;
    },
    registerOAuthClient: async (input) => {
      if (!config.oauthProvider) {
        throw new Error("registerOAuthClient: oauthProvider is not configured.");
      }
      await prepareAuth();
      const created = await api.adminCreateOAuthClient({
        headers: new Headers(input.requestHeaders),
        body: {
          redirect_uris: [...input.redirectUris],
          ...(input.scope ? { scope: input.scope.join(" ") } : {}),
          ...(input.clientName ? { client_name: input.clientName } : {}),
          ...(input.clientUri ? { client_uri: input.clientUri } : {}),
          ...(input.logoUri ? { logo_uri: input.logoUri } : {}),
          ...(input.contacts ? { contacts: [...input.contacts] } : {}),
          ...(input.tosUri ? { tos_uri: input.tosUri } : {}),
          ...(input.policyUri ? { policy_uri: input.policyUri } : {}),
          ...(input.postLogoutRedirectUris
            ? { post_logout_redirect_uris: [...input.postLogoutRedirectUris] }
            : {}),
          ...(input.tokenEndpointAuthMethod
            ? { token_endpoint_auth_method: input.tokenEndpointAuthMethod }
            : {}),
          ...(input.grantTypes ? { grant_types: [...input.grantTypes] } : {}),
          ...(input.responseTypes ? { response_types: [...input.responseTypes] } : {}),
          ...(input.applicationType ? { application_type: input.applicationType } : {}),
          ...(input.skipConsent !== undefined ? { skip_consent: input.skipConsent } : {}),
          ...(input.enableEndSession !== undefined
            ? { enable_end_session: input.enableEndSession }
            : {}),
          ...(input.requirePKCE !== undefined ? { require_pkce: input.requirePKCE } : {}),
          ...(input.subjectType ? { subject_type: input.subjectType } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      });
      return mapRegisteredOAuthClient(created);
    },
  };
}
