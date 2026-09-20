import { createAuth } from "../../src/auth/createAuth.js";
export function fixtureAuth(database: D1Database, origin: string, secret: string) {
  let otp = "";
  const auth = createAuth({ database, baseURL: origin, secret,
    methods: [{ kind: "email-otp", sender: { send: async ({ subject }) => { otp = subject.match(/\d{6}/u)?.[0] ?? ""; } } }],
    oauthProvider: { loginPage: "/admin/sign-in", consentPage: "/oauth/consent", scopes: ["mcp", "offline_access"],
      allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultScopes: ["mcp"], clientRegistrationAllowedScopes: ["mcp", "offline_access"], mcpResource: `${origin}/mcp` },
  });
  return { auth, async login(proof?: string) {
    const redirectUri = "https://client.example.test/callback";
    const registered = await json(await auth.handler(jsonRequest(`${origin}/api/auth/oauth2/register`, {
      client_name: "Synthetic parity client", redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "mcp",
    })));
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const authorize = new URL(`${origin}/api/auth/oauth2/authorize`);
    authorize.search = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: "S256", resource: `${origin}/mcp`, scope: "mcp offline_access", state: crypto.randomUUID() }).toString();
    const response = await auth.handler(new Request(authorize));
    if (response.status !== 302) throw new Error(`authorize: ${response.status}`);
    const login = new URL(response.headers.get("location")!, origin);
    let cookies = mergeCookies("", response);
    const email = `synthetic-${crypto.randomUUID()}@example.com`;
    const sent = await auth.handler(jsonRequest(`${origin}/api/auth/email-otp/send-verification-otp`, { email, type: "sign-in", oauth_query: login.search.slice(1) }, cookies));
    await json(sent); cookies = mergeCookies(cookies, sent);
    const signedIn = await auth.handler(jsonRequest(`${origin}/api/auth/sign-in/email-otp`, { email, otp, oauth_query: login.search.slice(1) }, cookies));
    cookies = mergeCookies(cookies, signedIn);
    const consentUrl = new URL(String((await json(signedIn)).url), origin);
    const consent = await auth.getOAuthConsentRequest(new Request(consentUrl, { headers: { cookie: cookies } }));
    if (!consent) throw new Error("missing consent");
    const callback = new URL(await auth.completeOAuthConsent(new Request(`${origin}/oauth/consent`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: cookies },
      body: new URLSearchParams({ oauth_query: consent.oauthQuery }),
    }), true));
    const tokens = await json(await auth.handler(new Request(`${origin}/api/auth/oauth2/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(proof ? { dpop: proof } : {}) },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: registered.client_id, redirect_uri: redirectUri,
        code: callback.searchParams.get("code")!, code_verifier: verifier, resource: `${origin}/mcp` }),
    })));
    // Fixture credentials are returned only through the secret-protected setup
    // endpoint; never included in records, logs, reports, or measured responses.
    const claims = JSON.parse(atob(tokens.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    await database.prepare("UPDATE user SET role = 'owner' WHERE id = ?").bind(claims.sub).run();
    return { accessToken: tokens.access_token, cookie: cookies, userId: claims.sub, sessionId: claims.sid, consentId: claims.mantle_consent_id };
  } };
}
async function json(response: Response): Promise<any> {
  if (!response.ok) {
    const error = await response.json() as { error?: string; code?: string };
    const code = error.error ?? error.code ?? "unknown";
    throw new Error(`auth fixture failed: ${response.status} ${/^[a-zA-Z_]+$/.test(code) ? code : "unknown"}`);
  }
  return response.json();
}
function jsonRequest(url: string, body: unknown, cookie = "") {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
}
function mergeCookies(current: string, response: Response) {
  const cookies = new Map(current.split("; ").filter(Boolean).map((v) => [v.slice(0, v.indexOf("=")), v]));
  for (const cookie of response.headers.getSetCookie()) { const v = cookie.split(";", 1)[0]!; cookies.set(v.slice(0, v.indexOf("=")), v); }
  return [...cookies.values()].join("; ");
}
function base64url(bytes: ArrayBuffer) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
