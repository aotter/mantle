import { test, expect } from "bun:test";
import { SQL } from "bun";
import { betterAuth } from "better-auth/minimal";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { postgresAdapter } from "../src/auth/adapter.js";
import { authSchemaSql } from "../src/infrastructure/authSchema.js";
import { assertActiveUserGrant, oauthConsents, oauthGrantExtension, oauthGrantRevocation } from "../src/auth/oauth.js";
import { authLoader, resolveCaller, type AuthInstance } from "../src/auth/caller.js";
import { JWT_BEARER, managedGrantTestExtension, managedTokenRequest } from "./apps/managed-grant.js";

const url = process.env.MANTLE_NEXT_BUN_PG_URL;
(url ? test : test.skip)(
  "native PostgreSQL live grant, offline grant after session end, native JSON/date fields and revocation cascade",
  async () => {
    const schema = `oauth_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new SQL(url!);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const sql = new SQL(url!, { max: 1 });
    await sql.unsafe(`SET search_path TO "${schema}"`);
    try {
      const options: import("@better-auth/core").BetterAuthOptions = {
        baseURL: "https://oauth.test",
        secret: "oauth-postgres-secret-oauth-postgres-secret",
        database: postgresAdapter(sql),
        plugins: [
          jwt({ disableSettingJwtHeader: true }),
          oauthProvider({ loginPage: "/login", consentPage: "/oauth/consent", extensions: [oauthGrantExtension] }),
        ],
      };
      for (const ddl of authSchemaSql(options, "postgres")) await sql.unsafe(ddl);
      const auth = betterAuth(options),
        { adapter } = await auth.$context;
      const now = new Date(),
        expiresAt = new Date(Date.now() + 60000);
      const user = await adapter.create<{ id: string }>({
        model: "user",
        data: { name: "User", email: "pg@example.test", emailVerified: true, createdAt: now, updatedAt: now },
      });
      const session = await adapter.create<{ id: string }>({
        model: "session",
        data: { userId: user.id, token: "native-pg-session", expiresAt, createdAt: now, updatedAt: now },
      });
      await adapter.create({
        model: "oauthClient",
        data: {
          clientId: "client",
          name: "PG client",
          redirectUris: ["https://client.test/cb"],
          createdAt: now,
          updatedAt: now,
        },
      });
      const consent = await adapter.create<{ id: string }>({
        model: "oauthConsent",
        data: {
          userId: user.id,
          clientId: "client",
          scopes: ["mcp"],
          resources: ["https://resource.test/mcp"],
          createdAt: now,
          updatedAt: now,
        },
      });
      const claims = {
        sub: user.id,
        azp: "client",
        sid: session.id,
        mantle_consent_id: consent.id,
        mantle_consent_reference: null,
        aud: "https://resource.test/mcp",
        scope: "mcp",
      };
      await assertActiveUserGrant(auth as never, claims, claims.aud);
      await expect(
        assertActiveUserGrant(auth as never, { ...claims, scope: "mcp other" }, claims.aud),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await adapter.update({
        model: "oauthConsent",
        where: [{ field: "id", value: consent.id }],
        update: { scopes: ["mcp", "offline_access"] },
      });
      const refresh = await adapter.create<{ id: string }>({
        model: "oauthRefreshToken",
        data: {
          token: "native-pg-refresh",
          clientId: "client",
          sessionId: session.id,
          userId: user.id,
          scopes: ["mcp", "offline_access"],
          createdAt: now,
          expiresAt,
        },
      });
      const offline = { ...claims, scope: "mcp offline_access" };
      await adapter.update({
        model: "session",
        where: [{ field: "id", value: session.id }],
        update: { expiresAt: new Date(0) },
      });
      await expect(assertActiveUserGrant(auth as never, claims, claims.aud)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
      await assertActiveUserGrant(auth as never, offline, claims.aud);
      await adapter.delete({ model: "session", where: [{ field: "id", value: session.id }] });
      await assertActiveUserGrant(auth as never, { ...offline, sid: null }, claims.aud);
      await adapter.update({
        model: "oauthRefreshToken",
        where: [{ field: "id", value: refresh.id }],
        update: { revoked: new Date() },
      });
      await expect(assertActiveUserGrant(auth as never, offline, claims.aud)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
      await adapter.update({
        model: "oauthRefreshToken",
        where: [{ field: "id", value: refresh.id }],
        update: { revoked: null },
      });
      await assertActiveUserGrant(auth as never, offline, claims.aud);
      const consents = oauthConsents(auth as never);
      expect(await consents.listOAuthConsents(user.id)).toMatchObject([
        { clientId: "client", clientName: "PG client", scopes: ["mcp", "offline_access"] },
      ]);
      expect(await consents.revokeOAuthConsent("other", consent.id)).toBe(false);
      expect(await consents.revokeOAuthConsent(user.id, consent.id)).toBe(true);
      await expect(assertActiveUserGrant(auth as never, offline, claims.aud)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
      expect(
        await adapter.findMany({ model: "verification", where: [{ field: "identifier", value: "pending" }] }),
      ).toEqual([]);
    } finally {
      await sql.close();
      await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    }
  },
  30_000,
);

(url ? test : test.skip)(
  "native PostgreSQL managed grant: issued without session or refresh token, resolved, listed and disconnected",
  async () => {
    const schema = `oauth_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new SQL(url!);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const sql = new SQL(url!, { max: 1 });
    await sql.unsafe(`SET search_path TO "${schema}"`);
    let handle: (request: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => handle(request) });
    try {
      const origin = `http://127.0.0.1:${server.port}`,
        resource = `${origin}/mcp`;
      const options: import("@better-auth/core").BetterAuthOptions = {
        baseURL: origin,
        secret: "oauth-postgres-secret-oauth-postgres-secret",
        database: postgresAdapter(sql),
        plugins: [
          jwt({ disableSettingJwtHeader: true }),
          oauthGrantRevocation({ managedGrants: true }),
          oauthProvider({
            loginPage: "/login",
            consentPage: "/oauth/consent",
            extensions: [oauthGrantExtension, managedGrantTestExtension],
            scopes: ["mcp", "offline_access"],
            resources: [resource],
            enforcePerClientResources: false,
            allowDynamicClientRegistration: true,
            allowUnauthenticatedClientRegistration: true,
          }),
        ],
      };
      for (const ddl of authSchemaSql(options, "postgres")) await sql.unsafe(ddl);
      const auth = betterAuth(options);
      handle = request => auth.handler(request);
      const { internalAdapter } = await auth.$context;
      const user = await internalAdapter.createUser({ email: "pg@example.test", name: "PG", emailVerified: true });
      const registered = await auth.handler(
        new Request(`${origin}/api/auth/oauth2/register`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            client_name: "PG assistant",
            redirect_uris: ["https://client.test/cb"],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", JWT_BEARER, "refresh_token"],
            response_types: ["code"],
            scope: "mcp offline_access",
          }),
        }),
      );
      expect(registered.status).toBe(201);
      const clientId = ((await registered.json()) as { client_id: string }).client_id;
      const response = await managedTokenRequest(`${origin}/api/auth`, {
        clientId,
        email: "pg@example.test",
        scope: "mcp offline_access",
        resource,
      });
      const token = (await response.json()) as { access_token: string; refresh_token?: string };
      expect(response.status, JSON.stringify(token)).toBe(200);
      expect(token.refresh_token).toBeUndefined();
      expect(await sql`SELECT count(*)::int AS n FROM "session"`).toEqual([{ n: 0 }]);
      expect(await sql`SELECT count(*)::int AS n FROM "oauthRefreshToken"`).toEqual([{ n: 0 }]);
      const loader = authLoader(async () => auth as unknown as AuthInstance);
      const use = () =>
        resolveCaller(
          new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${token.access_token}` } }),
          loader,
          {
            audience: resource,
          },
        );
      expect(await use()).toMatchObject({ subject: user.id, credential: "oauth", clientId });
      await sql`UPDATE "oauthClient" SET disabled = true`;
      await expect(use()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await sql`UPDATE "oauthClient" SET disabled = false`;
      expect(await use()).toMatchObject({ subject: user.id });
      const consents = oauthConsents(auth as never);
      const [listed] = await consents.listOAuthConsents(user.id);
      expect(listed).toMatchObject({ clientId, clientName: "PG assistant", scopes: ["mcp"] });
      expect(await consents.revokeOAuthConsent(user.id, listed!.id)).toBe(true);
      await expect(use()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect(await consents.listOAuthConsents(user.id)).toEqual([]);
    } finally {
      server.stop(true);
      await sql.close();
      await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    }
  },
  30_000,
);
