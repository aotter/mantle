import { afterEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_MIGRATIONS } from "@aotter/mantle-runtime";
import { createAuth } from "../src/auth/createAuth.js";
import { contextForVerifiedUser } from "../src/mount/resolveCaller.js";
import { sqliteD1 } from "./fakes/sqlite-d1.js";
import { createMantleWorker } from "../src/worker/createMantleWorker.js";
import { compileTestPlan } from "./compileTestPlan.js";

const ORIGIN = "https://site.example.com";
const RESOURCE = `${ORIGIN}/mcp`;
const CLIENT_ID = "https://client.example.com/oauth/client.json";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Better Auth 1.7 MCP smoke", () => {
  it("stores sessions in deployment KV while keeping OTP verification in D1", async () => {
    const { db, sqlite } = sqliteD1();
    const values = new Map<string, string>();
    const kv = {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value); },
      delete: async (key: string) => { values.delete(key); },
    } as unknown as KVNamespace;
    let otp = "";
    try {
      const auth = createAuth({
        database: db,
        sessionCacheKv: kv,
        baseURL: ORIGIN,
        secret: "x".repeat(40),
        methods: [{ kind: "email-otp", sender: { send: async ({ subject }) => {
          otp = subject.match(/\d{6}/u)?.[0] ?? "";
        } } }],
      });
      const email = "cache@example.com";
      expect((await auth.handler(jsonRequest(
        `${ORIGIN}/api/auth/email-otp/send-verification-otp`,
        { email, type: "sign-in" },
        "",
      ))).status).toBe(200);
      expect([...values.keys()].some(key => key.includes("verification"))).toBe(false);

      const response = await auth.handler(jsonRequest(
        `${ORIGIN}/api/auth/sign-in/email-otp`,
        { email, otp },
        "",
      ));
      expect(response.status).toBe(200);
      const cookies = mergeCookies("", response);
      const sessionKey = [...values.keys()].find(key => key.startsWith("better-auth:") && !key.includes("active-sessions"));
      expect(sessionKey).toBeDefined();
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM session").get()!.count).toBe(1);
      const cached = JSON.parse(values.get(sessionKey!)!) as { user: { id: string; role: string } };
      expect(await auth.setUserRole(cached.user.id, "owner")).toBe(true);
      expect(JSON.parse(values.get(sessionKey!)!).user.role).toBe("owner");

      const prepare = vi.spyOn(db, "prepare");
      expect((await createAuth({
        database: db,
        sessionCacheKv: kv,
        baseURL: ORIGIN,
        secret: "x".repeat(40),
        methods: [{ kind: "email-otp", sender: { send: async () => {} } }],
      }).getSession(new Request(ORIGIN, { headers: { cookie: cookies } })))?.user.role).toBe("owner");
      expect(prepare.mock.calls.some(([sql]) => String(sql).includes("_migrations"))).toBe(false);

      const empty = sqliteD1();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const cold = createAuth({
          database: empty.db,
          baseURL: ORIGIN,
          secret: "x".repeat(40),
          methods: [{ kind: "email-otp", sender: { send: async () => {} } }],
        });
        expect(await cold.getSession(new Request(ORIGIN, { headers: { cookie: cookies } }))).toBeNull();
        expect(empty.sqlite.prepare("SELECT COUNT(*) AS count FROM _migrations").get()!.count).toBe(1);
      } finally {
        log.mockRestore();
        empty.sqlite.close();
      }
    } finally {
      sqlite.close();
    }
  });

  it("initializes Better Auth and OAuth discovery on an empty Worker database", async () => {
    const { db, sqlite } = sqliteD1();
    const worker = createMantleWorker({
      plan: compileTestPlan([]),
      auth: () => createAuth({
        database: db, baseURL: ORIGIN, secret: "x".repeat(40),
        methods: [{ kind: "email-otp", sender: { send: async () => {} } }],
        oauthProvider: { loginPage: "/admin/sign-in", consentPage: "/oauth/consent", scopes: ["mcp"], mcpResource: RESOURCE },
      }),
    });
    const pending: Promise<unknown>[] = [];
    const prepare = vi.spyOn(db, "prepare");
    const catalog = await worker.fetch(new Request(`${ORIGIN}/api/views`), { DB: db }, {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext);
    expect(catalog.status).toBe(200);
    await Promise.all(pending);
    // Better Auth eagerly seeds its resource registry and explicitly defers
    // a missing-table seed to first access. No content preparation runs here.
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![0]).toContain('"oauthResource"');
    prepare.mockClear();
    expect((await worker.fetch(new Request(`${ORIGIN}/api/views`), { DB: db }, {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext)).status).toBe(200);
    await Promise.all(pending);
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    const response = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server/api/auth`), {
      DB: db,
    }, { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
    await Promise.all(pending);
    sqlite.close();
  });

  it("discovers CIMD clients, retains their metadata, and prunes only expired DCR rows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { db, sqlite } = sqliteD1();
    for (const migration of CANONICAL_MIGRATIONS) sqlite.exec(migration.sql);
    let otp = "";
    const metadata = {
      client_id: CLIENT_ID,
      client_name: "Example operations agent",
      client_uri: "https://client.example.com/app",
      logo_uri: "https://client.example.com/logo.png",
      contacts: ["ops@client.example.com"],
      software_id: "operations-agent",
      software_version: "1.2.3",
      redirect_uris: ["https://client.example.com/callback"],
      token_endpoint_auth_method: "none",
      grant_types: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
      response_types: ["code"],
      scope: "mcp offline_access",
    };
    const metadataFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return Response.json(metadata, {
        headers: { "cache-control": "public, max-age=60" },
      });
    });
    vi.stubGlobal("fetch", metadataFetch);
    const expired = new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000).toISOString();
    const insert = sqlite.prepare(`
      INSERT INTO oauthClient
        (id, clientId, redirectUris, createdAt, clientDiscoveryId, referenceId)
      VALUES (?, ?, '[]', ?, ?, ?)
    `);
    insert.run("expired-dcr", "expired-dcr", expired, null, null);
    insert.run("managed", "managed", expired, null, "operator-owned");
    insert.run("cimd", CLIENT_ID, expired, "cimd", null);

    const auth = createAuth({
      database: db,
      baseURL: ORIGIN,
      secret: "x".repeat(40),
      methods: [{
        kind: "email-otp",
        sender: {
          send: async ({ subject }) => {
            otp = subject.match(/\d{6}/u)?.[0] ?? "";
          },
        },
      }],
      oauthProvider: {
        loginPage: "/admin/sign-in",
        consentPage: "/oauth/consent",
        scopes: ["mcp", "offline_access"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ["mcp"],
        clientRegistrationAllowedScopes: ["mcp", "offline_access"],
        mcpResource: RESOURCE,
      },
    });
    expect(auth.mcpResource).toBe(RESOURCE);

    const discovery = await auth.handler(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server/api/auth`),
    );
    expect(discovery.status).toBe(200);
    await expect(discovery.json()).resolves.toMatchObject({
      authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`,
      client_id_metadata_document_supported: true,
    });

    const protectedResource = await auth.handler(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(protectedResource.status).toBe(200);
    await expect(protectedResource.json()).resolves.toMatchObject({
      resource: RESOURCE,
      authorization_servers: [`${ORIGIN}/api/auth`],
    });

    const authorize = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
    const verifier = "mantle-better-auth-1-7-smoke-verifier-0001";
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: metadata.redirect_uris[0],
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp offline_access",
      state: "state-1",
    }).toString();
    const response = await auth.handler(new Request(authorize));
    expect(response.status).toBe(302);
    const login = new URL(response.headers.get("location")!, ORIGIN);
    expect(login.pathname).toBe("/admin/sign-in");
    expect(metadataFetch).toHaveBeenCalledTimes(1);

    let cookies = mergeCookies("", response);
    const email = "operator@example.com";
    const sendOtp = await auth.handler(jsonRequest(
      `${ORIGIN}/api/auth/email-otp/send-verification-otp`,
      { email, type: "sign-in", oauth_query: login.search.slice(1) },
      cookies,
    ));
    expect(sendOtp.status).toBe(200);
    expect(otp).toMatch(/^\d{6}$/u);
    cookies = mergeCookies(cookies, sendOtp);

    const signIn = await auth.handler(jsonRequest(
      `${ORIGIN}/api/auth/sign-in/email-otp`,
      { email, otp, oauth_query: login.search.slice(1) },
      cookies,
    ));
    expect(signIn.status).toBe(200);
    cookies = mergeCookies(cookies, signIn);
    const consentUrl = new URL(
      String((await signIn.json() as { url?: string }).url),
      ORIGIN,
    );
    expect(consentUrl.pathname).toBe("/oauth/consent");

    const consent = await auth.getOAuthConsentRequest(
      new Request(consentUrl, { headers: { cookie: cookies } }),
    );
    expect(consent).toMatchObject({
      clientName: metadata.client_name,
      redirectUri: metadata.redirect_uris[0],
      scopes: ["mcp", "offline_access"],
    });
    const tampered = new URL(consentUrl);
    tampered.searchParams.set("scope", "mcp admin");
    await expect(auth.getOAuthConsentRequest(
      new Request(tampered, { headers: { cookie: cookies } }),
    )).rejects.toThrow();

    const clientRedirect = new URL(await auth.completeOAuthConsent(
      new Request(`${ORIGIN}/oauth/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: cookies,
        },
        body: new URLSearchParams({ oauth_query: consent!.oauthQuery }),
      }),
      true,
    ));
    expect(clientRedirect.origin + clientRedirect.pathname).toBe(
      metadata.redirect_uris[0],
    );
    const code = clientRedirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await auth.handler(new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: metadata.redirect_uris[0],
        code: code!,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    }));
    expect(token.status).toBe(200);
    const tokens = await token.json() as { access_token: string; refresh_token: string };
    const accessToken = tokens.access_token;
    expect(tokens.refresh_token).toEqual(expect.any(String));
    const verification = await auth.verifyOAuthAccessToken(
      new Request(RESOURCE, { headers: { authorization: `Bearer ${accessToken}` } }),
      { audience: RESOURCE, scopes: ["mcp"] },
    );
    expect(verification).toMatchObject({
      ok: true,
      userId: expect.any(String),
      clientId: CLIENT_ID,
      scopes: ["mcp", "offline_access"],
    });
    if (!verification.ok) throw new Error("expected a verified MCP access token");

    // Warm JWKS: exactly one native grant statement, then a fresh role read.
    const queries = vi.spyOn(db, "prepare");
    expect(await auth.verifyOAuthAccessToken(accessToken, { audience: RESOURCE, scopes: ["mcp"] }))
      .toMatchObject({ ok: true });
    expect(queries).toHaveBeenCalledTimes(1);
    const grantSql = queries.mock.calls[0]![0];
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString());
    const queryPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${grantSql}`).all(
      claims.sid, new Date().toISOString(), claims.mantle_consent_id, claims.sub, claims.azp,
    ).map((row) => String(row.detail));
    expect(queryPlan).toHaveLength(2);
    expect(queryPlan.every((detail) => /SEARCH .+ USING INDEX sqlite_autoindex_/.test(detail))).toBe(true);
    const caller = () => contextForVerifiedUser(verification.userId, {
      credential: "oauth", credentialId: null, clientId: CLIENT_ID, scopes: verification.scopes,
    }, auth, { env: {} });
    sqlite.prepare("UPDATE user SET role = 'owner' WHERE id = ?").run(verification.userId);
    expect((await caller()).staff).not.toBeNull();
    expect(queries).toHaveBeenCalledTimes(2);
    sqlite.prepare("UPDATE user SET role = 'user' WHERE id = ?").run(verification.userId);
    expect((await caller()).staff).toBeNull();
    expect(queries).toHaveBeenCalledTimes(3);

    // JWT signature stays valid: each authoritative predicate must revoke it now.
    // Defer FK checks while temporarily changing identities, then restore before commit.
    sqlite.exec("SAVEPOINT grant_predicates; PRAGMA defer_foreign_keys = ON;");
    for (const [table, id, field, invalid] of [
      ["session", claims.sid, "id", "another-session"],
      ["session", claims.sid, "userId", "another-user"],
      ["session", claims.sid, "expiresAt", new Date(0).toISOString()],
      ["oauthConsent", claims.mantle_consent_id, "id", "another-consent"],
      ["oauthConsent", claims.mantle_consent_id, "userId", "another-user"],
      ["oauthConsent", claims.mantle_consent_id, "clientId", "another-client"],
      ["oauthConsent", claims.mantle_consent_id, "resources", '["https://other.test/mcp"]'],
      ["oauthConsent", claims.mantle_consent_id, "resources", "invalid-json"],
      ["oauthConsent", claims.mantle_consent_id, "scopes", '["mcp"]'],
      ["oauthConsent", claims.mantle_consent_id, "scopes", '["mcp",42]'],
    ] as const) {
      const original = sqlite.prepare(`SELECT ${field} AS value FROM ${table} WHERE id = ?`).get(id)!.value;
      sqlite.prepare(`UPDATE ${table} SET ${field} = ? WHERE id = ?`).run(invalid, id);
      await expect(auth.verifyOAuthAccessToken(accessToken, { audience: RESOURCE, scopes: ["mcp"] }))
        .resolves.toEqual({ ok: false, status: 401, reason: "invalid-token" });
      sqlite.prepare(`UPDATE ${table} SET ${field} = ? WHERE id = ?`)
        .run(original, field === "id" ? invalid : id);
    }
    sqlite.exec("RELEASE grant_predicates; PRAGMA defer_foreign_keys = OFF;");
    queries.mockImplementationOnce(() => { throw new Error("D1 unavailable"); });
    await expect(auth.verifyOAuthAccessToken(accessToken, { audience: RESOURCE, scopes: ["mcp"] }))
      .resolves.toEqual({ ok: false, status: 401, reason: "invalid-token" });
    queries.mockRestore();

    const client = sqlite.prepare(`
      SELECT clientId, clientDiscoveryId, name, uri, icon, contacts,
             softwareId, softwareVersion, redirectUris
      FROM oauthClient WHERE clientId = ?
    `).get(CLIENT_ID) as Record<string, unknown>;
    expect(client).toMatchObject({
      clientId: CLIENT_ID,
      clientDiscoveryId: "cimd",
      name: metadata.client_name,
      uri: metadata.client_uri,
      icon: metadata.logo_uri,
      softwareId: metadata.software_id,
      softwareVersion: metadata.software_version,
    });
    expect(JSON.parse(String(client.contacts))).toEqual(metadata.contacts);
    expect(JSON.parse(String(client.redirectUris))).toEqual(metadata.redirect_uris);

    const remaining = sqlite.prepare(
      "SELECT clientId FROM oauthClient ORDER BY clientId",
    ).all().map((row) => String((row as { clientId: string }).clientId));
    expect(remaining).toEqual([CLIENT_ID, "managed"]);

    const registration = await auth.handler(new Request(
      `${ORIGIN}/api/auth/oauth2/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Legacy DCR agent",
          redirect_uris: ["https://legacy-client.example.com/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "mcp",
        }),
      },
    ));
    expect(registration.status).toBe(201);
    await expect(registration.json()).resolves.toMatchObject({
      client_name: "Legacy DCR agent",
      token_endpoint_auth_method: "none",
      scope: "mcp offline_access",
    });

    const consents = await auth.listOAuthConsents!(verification.userId);
    expect(consents).toEqual([{
      id: expect.any(String),
      clientId: CLIENT_ID,
      clientName: metadata.client_name,
      scopes: ["mcp", "offline_access"],
    }]);
    const originalConsentId = consents[0]!.id;
    expect(JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString()))
      .toMatchObject({ mantle_consent_id: originalConsentId });
    // Model a refresh row whose insertion was delayed across the revoke batch.
    sqlite.prepare("CREATE TEMP TABLE delayed_refresh AS SELECT * FROM oauthRefreshToken WHERE referenceId = ?")
      .run(originalConsentId);
    expect(await auth.revokeOAuthConsent!("another-user", consents[0]!.id)).toBe(false);
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    sqlite.prepare(`
      INSERT INTO oauthRefreshToken
        (id, token, clientId, userId, expiresAt, createdAt, scopes)
      VALUES ('refresh-1', 'refresh-token', ?, ?, ?, ?, '["mcp"]')
    `).run(CLIENT_ID, verification.userId, future, now);
    sqlite.prepare(`
      INSERT INTO oauthAccessToken
        (id, token, clientId, userId, expiresAt, createdAt, scopes)
      VALUES ('access-1', 'opaque-access-token', ?, ?, ?, ?, '["mcp"]')
    `).run(CLIENT_ID, verification.userId, future, now);
    sqlite.prepare(`
      INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "pending-code",
      "authorization-code",
      JSON.stringify({
        type: "authorization_code",
        userId: verification.userId,
        query: { client_id: CLIENT_ID },
      }),
      future,
      now,
      now,
    );
    sqlite.prepare(`
      INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
      VALUES ('unrelated-verification', 'otp', 'plain-value', ?, ?, ?)
    `).run(future, now, now);

    expect(await auth.revokeOAuthConsent!(verification.userId, consents[0]!.id)).toBe(true);
    await expect(auth.verifyOAuthAccessToken(
      new Request(RESOURCE, { headers: { authorization: `Bearer ${accessToken}` } }),
      { audience: RESOURCE, scopes: ["mcp"] },
    )).resolves.toEqual({ ok: false, status: 401, reason: "invalid-token" });
    expect(await auth.listOAuthConsents!(verification.userId)).toEqual([]);
    expect(sqlite.prepare(
      "SELECT revoked FROM oauthRefreshToken WHERE id = 'refresh-1'",
    ).get()).toMatchObject({ revoked: expect.any(String) });
    expect(sqlite.prepare(
      "SELECT revoked FROM oauthAccessToken WHERE id = 'access-1'",
    ).get()).toMatchObject({ revoked: expect.any(String) });
    expect(sqlite.prepare(
      "SELECT id FROM verification WHERE id = 'pending-code'",
    ).get()).toBeUndefined();
    expect(sqlite.prepare(
      "SELECT id FROM verification WHERE id = 'unrelated-verification'",
    ).get()).toEqual({ id: "unrelated-verification" });
    expect(await auth.revokeOAuthConsent!(verification.userId, consents[0]!.id)).toBe(false);

    const refreshAfterRevoke = await auth.handler(new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: tokens.refresh_token }),
    }));
    expect(refreshAfterRevoke.status).toBe(400);
    await expect(refreshAfterRevoke.json()).resolves.toMatchObject({ error: "invalid_grant" });

    // Reconnect through the real protocol, even in the same clock second.
    authorize.searchParams.set("state", "state-2");
    const reconnect = await auth.handler(new Request(authorize, { headers: { cookie: cookies } }));
    expect(reconnect.status).toBe(302);
    cookies = mergeCookies(cookies, reconnect);
    const reconnectConsent = await auth.getOAuthConsentRequest(new Request(
      new URL(reconnect.headers.get("location")!, ORIGIN),
      { headers: { cookie: cookies } },
    ));
    expect(reconnectConsent).not.toBeNull();
    const reconnected = new URL(await auth.completeOAuthConsent(new Request(`${ORIGIN}/oauth/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
      body: new URLSearchParams({ oauth_query: reconnectConsent!.oauthQuery }),
    }), true));
    const newToken = await auth.handler(new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: metadata.redirect_uris[0],
        code: reconnected.searchParams.get("code")!,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    }));
    expect(newToken.status).toBe(200);
    const newAccessToken = String((await newToken.json() as { access_token?: string }).access_token);
    const newConsents = await auth.listOAuthConsents!(verification.userId);
    expect(newConsents[0]!.id).not.toBe(originalConsentId);
    expect(JSON.parse(Buffer.from(newAccessToken.split(".")[1]!, "base64url").toString()))
      .toMatchObject({ mantle_consent_id: newConsents[0]!.id });
    await expect(auth.verifyOAuthAccessToken(newAccessToken, {
      audience: RESOURCE, scopes: ["mcp"],
    })).resolves.toMatchObject({ ok: true, userId: verification.userId });
    await expect(auth.verifyOAuthAccessToken(
      new Request(RESOURCE, { headers: { authorization: `Bearer ${accessToken}` } }),
      { audience: RESOURCE, scopes: ["mcp"] },
    )).resolves.toEqual({ ok: false, status: 401, reason: "invalid-token" });

    sqlite.exec("INSERT INTO oauthRefreshToken SELECT * FROM delayed_refresh; DROP TABLE delayed_refresh;");
    const delayedRefresh = await auth.handler(new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: tokens.refresh_token }),
    }));
    expect(delayedRefresh.status).toBe(200);
    const delayedTokens = await delayedRefresh.json() as { access_token: string; refresh_token: string };
    const delayedAccessToken = delayedTokens.access_token;
    expect(JSON.parse(Buffer.from(delayedAccessToken.split(".")[1]!, "base64url").toString()))
      .toMatchObject({ mantle_consent_id: originalConsentId });
    await expect(auth.verifyOAuthAccessToken(delayedAccessToken, {
      audience: RESOURCE, scopes: ["mcp"],
    })).resolves.toEqual({ ok: false, status: 401, reason: "invalid-token" });

    const rotatedRefresh = await auth.handler(new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: delayedTokens.refresh_token }),
    }));
    expect(rotatedRefresh.status).toBe(200);
    const rotatedAccessToken = (await rotatedRefresh.json() as { access_token: string }).access_token;
    expect(JSON.parse(Buffer.from(rotatedAccessToken.split(".")[1]!, "base64url").toString()))
      .toMatchObject({ mantle_consent_id: originalConsentId });
    await expect(auth.verifyOAuthAccessToken(rotatedAccessToken, {
      audience: RESOURCE, scopes: ["mcp"],
    })).resolves.toEqual({ ok: false, status: 401, reason: "invalid-token" });

    sqlite.prepare("UPDATE session SET expiresAt = ? WHERE userId = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), verification.userId);
    await expect(auth.verifyOAuthAccessToken(newAccessToken, {
      audience: RESOURCE, scopes: ["mcp"],
    })).resolves.toEqual({ ok: false, status: 401, reason: "invalid-token" });

    sqlite.prepare("UPDATE session SET expiresAt = ? WHERE userId = ?")
      .run(new Date(Date.now() + 60_000).toISOString(), verification.userId);
    const signOut = await auth.handler(jsonRequest(`${ORIGIN}/api/auth/sign-out`, {}, cookies));
    expect(signOut.status).toBe(200);
    await expect(auth.verifyOAuthAccessToken(newAccessToken, {
      audience: RESOURCE, scopes: ["mcp"],
    })).resolves.toEqual({ ok: false, status: 401, reason: "invalid-token" });

    metadataFetch.mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { location: "https://redirect-target.example.com/private" },
    }));
    const redirectingClient = new URL(authorize);
    redirectingClient.searchParams.set("client_id", "https://redirect-client.example.com/oauth/client.json");
    const refusedMetadata = await auth.handler(new Request(redirectingClient));
    expect(refusedMetadata.status).toBe(400);
    await expect(refusedMetadata.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(metadataFetch).toHaveBeenCalledTimes(2);

    sqlite.close();
  });
});

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(digest).toString("base64url");
}

function jsonRequest(url: string, body: unknown, cookie: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function mergeCookies(current: string, response: Response): string {
  const cookies = new Map(current.split("; ").filter(Boolean).map((value) => {
    const separator = value.indexOf("=");
    return [value.slice(0, separator), value] as const;
  }));
  const setCookies = (response.headers as Headers & { getSetCookie(): string[] })
    .getSetCookie();
  for (const setCookie of setCookies) {
    const value = setCookie.split(";", 1)[0]!;
    cookies.set(value.slice(0, value.indexOf("=")), value);
  }
  return [...cookies.values()].join("; ");
}
