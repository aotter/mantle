import type { Context, Env, Hono } from "hono";
import type { Auth } from "../auth/createAuth.js";
import { rejectCrossOriginMutation } from "../auth/rejectCrossOriginMutation.js";
import {
  detectConsentLocale,
  renderConsentHtml,
  type ConsentModel,
} from "./consentHtml.js";

export interface MountAuthorizeOptions {
  /** Better Auth-backed identity used to gate the consent UI. */
  readonly auth: Auth;
  /** Path that anonymous /authorize visitors get redirected to.
   *  Defaults to `/admin/sign-in`. The original `/authorize?...` URL
   *  is appended as `?return=...` so the sign-in page can bounce
   *  back after Better Auth completes. */
  readonly loginPath?: string;
}

/**
 * Mount the `/authorize` consent UI on the consumer's Hono app. The
 * Hono app must be passed to `createOAuthProvider({ defaultHandler })`;
 * the lib injects `OAUTH_PROVIDER` helpers onto env BEFORE forwarding
 * the request here, so we read `c.env.OAUTH_PROVIDER` directly.
 *
 * `/token` + `/register` + `/.well-known/oauth-*` are intercepted by
 * the OAuthProvider itself and never reach defaultHandler — do not
 * mount them here.
 */
export function mountAuthorize<E extends Env>(app: Hono<E>, options: MountAuthorizeOptions): void {
  const { auth, loginPath = "/admin/sign-in" } = options;

  const consentHandler = async (c: Context<E>): Promise<Response> => {
    const locale = detectConsentLocale(c.req.header("accept-language") ?? null);
    const helpers = (c.env as { OAUTH_PROVIDER?: OauthHelpers }).OAUTH_PROVIDER;
    if (!helpers) {
      return new Response(
        "OAUTH_PROVIDER missing on env — is the worker exported via createOAuthProvider()?",
        { status: 500 },
      );
    }

    const session = await auth.getSession(c.req.raw);
    if (!session) {
      if (c.req.method !== "GET") {
        return new Response("unauthenticated", { status: 401 });
      }
      const u = new URL(c.req.url);
      const returnTo = encodeURIComponent(u.pathname + u.search);
      return new Response(null, {
        status: 302,
        headers: { location: `${loginPath}?return=${returnTo}` },
      });
    }

    if (c.req.method === "POST") {
      // CSRF defense that does NOT depend on the session cookie's
      // SameSite attribute (which is forced to `none` globally when an
      // Apple social method is registered). A cross-site auto-submitting
      // form would otherwise mint an authorization code for an
      // attacker-registered client using the victim's session. Reject
      // any request a browser flags as cross-site / cross-origin; browsers
      // always send these on a real consent submit, and non-browser
      // clients can't ride a victim's cookie cross-site anyway. (#389)
      const rejected = rejectCrossOriginMutation(c.req.raw);
      if (rejected) return rejected;
      const form = await c.req.raw.formData();
      const oauthRequestJson = form.get("oauth_request");
      if (typeof oauthRequestJson !== "string") {
        return new Response("missing oauth_request", { status: 400 });
      }
      if (form.get("decision") !== "approve") {
        return new Response("authorization denied", { status: 400 });
      }
      let reqInfo: AuthRequest;
      try {
        reqInfo = JSON.parse(oauthRequestJson) as AuthRequest;
      } catch {
        return new Response("invalid oauth_request json", { status: 400 });
      }
      // The form-field oauth_request is caller-editable — a malicious
      // submit could swap redirectUri / scope post-consent. Re-validate
      // clientId + redirectUri against the registered client record;
      // refuse if either drifted. Fail closed when no registered URIs
      // exist — a misconfigured client with no allowlist must not get
      // a free pass.
      const registered = await helpers.lookupClient(reqInfo.clientId);
      if (!registered) {
        return new Response("unknown client", { status: 400 });
      }
      if (
        !Array.isArray(registered.redirectUris) ||
        registered.redirectUris.length === 0 ||
        !registered.redirectUris.includes(reqInfo.redirectUri)
      ) {
        return new Response("redirect_uri mismatch", { status: 400 });
      }

      // If claude.ai forgets to request a scope, default to ["mcp"]
      // so the token grant is non-empty (claude.ai post-token
      // verification rejects empty-scope tokens in some flows).
      const grantedScope =
        reqInfo.scope && reqInfo.scope.length > 0 ? reqInfo.scope : ["mcp"];
      const { redirectTo } = await helpers.completeAuthorization({
        request: reqInfo,
        userId: session.user.id,
        metadata: {},
        scope: grantedScope,
        // The provider's token-exchange callback derives token-specific API
        // props from verified grant fields and the effective token scope.
        props: {},
      });
      return new Response(null, { status: 302, headers: { location: redirectTo } });
    }

    let model: ConsentModel | null = null;
    try {
      const reqInfo = await helpers.parseAuthRequest(c.req.raw);
      const clientInfo = await helpers.lookupClient(reqInfo.clientId);
      model = {
        clientName: clientInfo?.clientName ?? "(unknown client)",
        redirectUri: reqInfo.redirectUri,
        scopes: reqInfo.scope ?? [],
        oauthRequestJson: JSON.stringify(reqInfo),
      };
    } catch {
      // parseAuthRequest throws on malformed requests; fall through to
      // the "invalid authorization request" branch in renderConsentHtml.
    }
    return new Response(renderConsentHtml(locale, model), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  app.get("/oauth/authorize", consentHandler);
  app.post("/oauth/authorize", consentHandler);
}

interface AuthRequest {
  readonly responseType: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope?: readonly string[];
  readonly state?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: string;
  readonly [extra: string]: unknown;
}

interface OauthHelpers {
  parseAuthRequest(req: Request): Promise<AuthRequest>;
  lookupClient(clientId: string): Promise<{
    clientName?: string;
    redirectUris?: readonly string[];
  } | null>;
  completeAuthorization(opts: {
    request: AuthRequest;
    userId: string;
    metadata: Record<string, unknown>;
    scope: readonly string[];
    props: Record<string, unknown>;
  }): Promise<{ redirectTo: string }>;
}
