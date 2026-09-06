import { afterEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_MIGRATIONS } from "@aotter/mantle-runtime";
import { createAuth } from "../src/auth/createAuth.js";
import { sqliteD1 } from "./fakes/sqlite-d1.js";

const ORIGIN = "https://site.example.com";
const RESOURCE = `${ORIGIN}/mcp`;
const CLIENT_ID = "https://client.example.com/oauth/client.json";

afterEach(() => vi.unstubAllGlobals());

describe("Better Auth 1.7 MCP smoke", () => {
  it("discovers CIMD clients, retains their metadata, and prunes only expired DCR rows", async () => {
    const { db, sqlite } = sqliteD1();
    sqlite.exec(CANONICAL_MIGRATIONS[0]!.sql);
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
      scope: "mcp",
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
        scopes: ["mcp"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ["mcp"],
        clientRegistrationAllowedScopes: ["mcp"],
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
      scope: "mcp",
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
      scopes: ["mcp"],
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
    const accessToken = String((await token.json() as { access_token?: string }).access_token);
    await expect(auth.verifyOAuthAccessToken(
      new Request(RESOURCE, { headers: { authorization: `Bearer ${accessToken}` } }),
      { audience: RESOURCE, scopes: ["mcp"] },
    )).resolves.toMatchObject({
      ok: true,
      userId: expect.any(String),
      clientId: CLIENT_ID,
      scopes: ["mcp"],
    });

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
      scope: "mcp",
    });

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
