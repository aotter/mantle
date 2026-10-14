import { test, expect } from "bun:test";
import { SQL } from "bun";
import { betterAuth } from "better-auth/minimal";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { bunSqlAdapter } from "../src/auth/adapter.js";
import { authSchemaSql } from "../src/infrastructure/authSchema.js";
import { assertActiveUserGrant, oauthConsents, oauthGrantExtension } from "../src/auth/oauth.js";

const url = process.env.MANTLE_NEXT_BUN_PG_URL;
(url ? test : test.skip)("native PostgreSQL live grant, native JSON/date fields and revocation cascade", async () => {
  const schema = `oauth_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(url!); await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const sql = new SQL(url!, { max: 1 }); await sql.unsafe(`SET search_path TO "${schema}"`);
  try {
    const options: import("@better-auth/core").BetterAuthOptions = { baseURL: "https://oauth.test", secret: "oauth-postgres-secret-oauth-postgres-secret", database: bunSqlAdapter(sql), plugins: [jwt({ disableSettingJwtHeader: true }), oauthProvider({ loginPage: "/login", consentPage: "/oauth/consent", extensions: [oauthGrantExtension] })] };
    for (const ddl of authSchemaSql(options, "postgres")) await sql.unsafe(ddl);
    const auth = betterAuth(options), { adapter } = await auth.$context;
    const now = new Date(), expiresAt = new Date(Date.now()+60000);
    const user = await adapter.create<{ id: string }>({ model: "user", data: { name: "User", email: "pg@example.test", emailVerified: true, createdAt: now, updatedAt: now } });
    const session = await adapter.create<{ id: string }>({ model: "session", data: { userId: user.id, token: "native-pg-session", expiresAt, createdAt: now, updatedAt: now } });
    await adapter.create({ model: "oauthClient", data: { clientId: "client", name: "PG client", redirectUris: ["https://client.test/cb"], createdAt: now, updatedAt: now } });
    const consent = await adapter.create<{ id: string }>({ model: "oauthConsent", data: { userId: user.id, clientId: "client", scopes: ["mcp"], resources: ["https://resource.test/mcp"], createdAt: now, updatedAt: now } });
    const claims = { sub: user.id, azp: "client", sid: session.id, mantle_consent_id: consent.id, mantle_consent_reference: null, aud: "https://resource.test/mcp", scope: "mcp" };
    await assertActiveUserGrant(auth as never, claims, claims.aud);
    await expect(assertActiveUserGrant(auth as never, { ...claims, scope: "mcp other" }, claims.aud)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const consents = oauthConsents(auth as never);
    expect(await consents.listOAuthConsents(user.id)).toMatchObject([{ clientId: "client", clientName: "PG client", scopes: ["mcp"] }]);
    expect(await consents.revokeOAuthConsent("other", consent.id)).toBe(false);
    expect(await consents.revokeOAuthConsent(user.id, consent.id)).toBe(true);
    await expect(assertActiveUserGrant(auth as never, claims, claims.aud)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await adapter.findMany({ model: "verification", where: [{ field: "identifier", value: "pending" }] })).toEqual([]);
  } finally { await sql.close(); await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); }
}, 30_000);
