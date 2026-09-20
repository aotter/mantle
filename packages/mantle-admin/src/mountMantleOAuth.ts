import type { Env, Hono } from "hono";
import type { AdminAssetServer } from "./mountMantleAdmin.js";
import { rejectCrossOriginMutation } from "./rejectCrossOriginMutation.js";
import {
  detectOAuthFallbackLocale,
  renderConnectedAppsFallbackHtml,
  renderConsentFallbackHtml,
} from "./oauthFallbackHtml.js";

export interface OAuthConsentRequest {
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** Signed provider query returned unchanged with the consent decision. */
  readonly oauthQuery: string;
}

export interface OAuthConsentInfo {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly scopes: readonly string[];
}

/** Platform-neutral protocol seam implemented by the selected Auth adapter. */
export interface MantleOAuthAuth {
  readonly getSession: (request: Request) => Promise<{
    readonly user: { readonly id: string };
  } | null>;
  readonly getOAuthConsentRequest: (
    request: Request,
  ) => Promise<OAuthConsentRequest | null>;
  readonly completeOAuthConsent: (
    request: Request,
    accept: boolean,
  ) => Promise<string>;
  readonly listOAuthConsents?: (
    userId: string,
  ) => Promise<readonly OAuthConsentInfo[]>;
  readonly revokeOAuthConsent?: (
    userId: string,
    consentId: string,
  ) => Promise<boolean>;
}

export interface MantleOAuthOptions {
  readonly auth: MantleOAuthAuth;
  readonly assets?: AdminAssetServer;
}

function oauthFormAction(redirectUri?: string): string {
  if (!redirectUri) return "'self'";
  const callback = new URL(redirectUri);
  return `'self' ${callback.origin === "null" ? callback.protocol : callback.origin}`;
}

function oauthPageHeaders(
  redirectUri?: string,
): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    "content-security-policy":
      `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action ${oauthFormAction(redirectUri)}; frame-ancestors 'none'; base-uri 'none'`,
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

async function adminOAuthPage(
  request: Request,
  assets: AdminAssetServer | undefined,
  redirectUri?: string,
): Promise<Response | null> {
  if (!assets) return null;
  const asset = await assets.fetch(
    new Request(new URL("/_mantle/admin/index.html", request.url)),
  );
  if (!asset) return null;
  const headers = new Headers(asset.headers);
  headers.set("cache-control", "private, no-store");
  headers.set(
    "content-security-policy",
    `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action ${oauthFormAction(redirectUri)}; frame-ancestors 'none'; base-uri 'none'`,
  );
  headers.set("referrer-policy", "same-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(asset.body, { status: asset.status, headers });
}

/** Runtime-neutral OAuth request handler. Unknown paths return `null`. */
export async function handleMantleOAuth(
  request: Request,
  options: MantleOAuthOptions,
): Promise<Response | null> {
  const { auth, assets } = options;
  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/oauth/consent/data") {
    if (!await auth.getSession(request)) {
      return Response.json({ consent: null }, {
        status: 401,
        headers: { "cache-control": "private, no-store" },
      });
    }
    let consent: OAuthConsentRequest | null = null;
    try {
      consent = await auth.getOAuthConsentRequest(request);
    } catch {
      // Keep invalid signed requests secret-free.
    }
    return Response.json({ consent }, {
      status: consent ? 200 : 400,
      headers: { "cache-control": "private, no-store" },
    });
  }

  if (request.method === "GET" && pathname === "/oauth/consent") {
    let model: OAuthConsentRequest | null = null;
    try {
      model = await auth.getOAuthConsentRequest(request);
    } catch {
      // Invalid, expired, or unauthenticated signed queries render the same
      // non-sensitive failure page.
    }
    const adminPage = await adminOAuthPage(request, assets, model?.redirectUri);
    if (adminPage) return adminPage;
    const locale = detectOAuthFallbackLocale(request.headers.get("accept-language"));
    return new Response(renderConsentFallbackHtml(locale, model), {
      status: model ? 200 : 400,
      headers: {
        ...oauthPageHeaders(model?.redirectUri),
        "content-type": "text/html; charset=UTF-8",
      },
    });
  }

  if (request.method === "POST" && pathname === "/oauth/consent") {
    const rejected = rejectCrossOriginMutation(request);
    if (rejected) return rejected;
    const body = await request.text();
    const decision = new URLSearchParams(body).get("decision");
    if (decision !== "approve" && decision !== "deny") {
      return new Response("invalid consent decision", { status: 400 });
    }
    try {
      const redirect = await auth.completeOAuthConsent(
        new Request(request, { body }),
        decision === "approve",
      );
      return redirectResponse(redirect, 302);
    } catch {
      return new Response("invalid authorization request", { status: 400 });
    }
  }

  if (request.method === "GET" && pathname === "/oauth/consents") {
    if (!auth.listOAuthConsents || !auth.revokeOAuthConsent) return null;
    const adminPage = await adminOAuthPage(request, assets);
    if (adminPage) return redirectResponse("/admin/connected-apps", 302);
    const session = await auth.getSession(request);
    if (!session) {
      return redirectResponse("/admin/sign-in?return=%2Foauth%2Fconsents", 302);
    }
    const locale = detectOAuthFallbackLocale(request.headers.get("accept-language"));
    const consents = await auth.listOAuthConsents(session.user.id);
    return new Response(renderConnectedAppsFallbackHtml(locale, consents), {
      headers: { ...oauthPageHeaders(), "content-type": "text/html; charset=UTF-8" },
    });
  }

  if (request.method === "GET" && pathname === "/oauth/consents/data") {
    if (!auth.listOAuthConsents || !auth.revokeOAuthConsent) return null;
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ consents: [] }, {
        status: 401,
        headers: { "cache-control": "private, no-store" },
      });
    }
    return Response.json({ consents: await auth.listOAuthConsents(session.user.id) }, {
      headers: { "cache-control": "private, no-store" },
    });
  }

  if (request.method === "POST" && pathname === "/oauth/consents/revoke") {
    if (!auth.revokeOAuthConsent) return null;
    const rejected = rejectCrossOriginMutation(request);
    if (rejected) return rejected;
    const session = await auth.getSession(request);
    if (!session) return new Response("unauthorized", { status: 401 });
    const consentId = (await request.formData()).get("consent_id");
    if (typeof consentId !== "string" || consentId.length === 0) {
      return new Response("invalid consent id", { status: 400 });
    }
    if (!await auth.revokeOAuthConsent(session.user.id, consentId)) {
      return new Response("consent not found", { status: 404 });
    }
    return redirectResponse("/oauth/consents", 303);
  }

  return null;
}

function redirectResponse(location: string, status: 302 | 303): Response {
  return new Response(null, { status, headers: { location } });
}

/** Thin Hono bridge; non-Hono runtimes call `handleMantleOAuth` directly. */
export function mountMantleOAuth<E extends Env>(
  app: Hono<E>,
  options: MantleOAuthOptions,
): void {
  app.all("/oauth/*", async (c) =>
    await handleMantleOAuth(c.req.raw, options) ?? c.notFound(),
  );
}
