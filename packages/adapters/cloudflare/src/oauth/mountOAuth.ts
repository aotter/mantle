import type { Env, Hono } from "hono";
import type { AdminAssetServer } from "@aotter/mantle-admin";
import type { Auth, OAuthConsentRequest } from "../auth/createAuth.js";
import { rejectCrossOriginMutation } from "../auth/rejectCrossOriginMutation.js";
import {
  detectConsentLocale,
  renderConnectedAppsHtml,
  renderConsentHtml,
} from "./consentHtml.js";

export interface MountAuthorizeOptions {
  readonly auth: Auth;
  readonly adminAssets?: AdminAssetServer;
}

function oauthPageHeaders(nonce: string): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    "content-security-policy":
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

const OAUTH_SPA_HEADERS = {
  "cache-control": "private, no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

async function adminOAuthPage(
  request: Request,
  assets: AdminAssetServer | undefined,
): Promise<Response | null> {
  if (!assets) return null;
  const asset = await assets.fetch(
    new Request(new URL("/_mantle/admin/index.html", request.url)),
  );
  if (!asset) return null;
  const headers = new Headers(asset.headers);
  for (const [name, value] of Object.entries(OAUTH_SPA_HEADERS)) headers.set(name, value);
  return new Response(asset.body, { status: asset.status, headers });
}

/** Mount Mantle's Admin-SPA OAuth pages with a no-assets HTML fallback.
 * Better Auth owns the signed query, client lookup, decision, and redirect. */
export function mountAuthorize<E extends Env>(
  app: Hono<E>,
  options: MountAuthorizeOptions,
): void {
  const { auth, adminAssets } = options;

  app.get("/oauth/consent/data", async (c) => {
    if (!await auth.getSession(c.req.raw)) {
      return Response.json({ consent: null }, {
        status: 401,
        headers: { "cache-control": "private, no-store" },
      });
    }
    let consent: OAuthConsentRequest | null = null;
    try {
      consent = await auth.getOAuthConsentRequest(c.req.raw);
    } catch {
      // Keep invalid signed requests secret-free.
    }
    return Response.json({ consent }, {
      status: consent ? 200 : 400,
      headers: { "cache-control": "private, no-store" },
    });
  });

  app.get("/oauth/consent", async (c) => {
    const adminPage = await adminOAuthPage(c.req.raw, adminAssets);
    if (adminPage) return adminPage;
    const locale = detectConsentLocale(c.req.header("accept-language") ?? null);
    const nonce = crypto.randomUUID();
    let model: OAuthConsentRequest | null = null;
    try {
      model = await auth.getOAuthConsentRequest(c.req.raw);
    } catch {
      // Invalid, expired, or unauthenticated signed queries render the same
      // non-sensitive failure page.
    }
    return c.html(
      renderConsentHtml(locale, model, nonce),
      model ? 200 : 400,
      oauthPageHeaders(nonce),
    );
  });

  app.post("/oauth/consent", async (c) => {
    const rejected = rejectCrossOriginMutation(c.req.raw);
    if (rejected) return rejected;
    const body = await c.req.text();
    const decision = new URLSearchParams(body).get("decision");
    if (decision !== "approve" && decision !== "deny") {
      return new Response("invalid consent decision", { status: 400 });
    }
    try {
      const redirect = await auth.completeOAuthConsent(
        new Request(c.req.raw, { body }),
        decision === "approve",
      );
      return c.redirect(redirect, 302);
    } catch {
      return new Response("invalid authorization request", { status: 400 });
    }
  });

  app.get("/oauth/consents", async (c) => {
    if (!auth.listOAuthConsents || !auth.revokeOAuthConsent) return c.notFound();
    const adminPage = await adminOAuthPage(c.req.raw, adminAssets);
    if (adminPage) return adminPage;
    const session = await auth.getSession(c.req.raw);
    if (!session) {
      return c.redirect("/admin/sign-in?return=%2Foauth%2Fconsents", 302);
    }
    const locale = detectConsentLocale(c.req.header("accept-language") ?? null);
    const nonce = crypto.randomUUID();
    const consents = await auth.listOAuthConsents(session.user.id);
    return c.html(
      renderConnectedAppsHtml(locale, consents, nonce),
      200,
      oauthPageHeaders(nonce),
    );
  });

  app.get("/oauth/consents/data", async (c) => {
    if (!auth.listOAuthConsents || !auth.revokeOAuthConsent) return c.notFound();
    const session = await auth.getSession(c.req.raw);
    if (!session) {
      return Response.json({ consents: [] }, {
        status: 401,
        headers: { "cache-control": "private, no-store" },
      });
    }
    return Response.json({ consents: await auth.listOAuthConsents(session.user.id) }, {
      headers: { "cache-control": "private, no-store" },
    });
  });

  app.post("/oauth/consents/revoke", async (c) => {
    if (!auth.revokeOAuthConsent) return c.notFound();
    const rejected = rejectCrossOriginMutation(c.req.raw);
    if (rejected) return rejected;
    const session = await auth.getSession(c.req.raw);
    if (!session) return new Response("unauthorized", { status: 401 });
    const consentId = (await c.req.formData()).get("consent_id");
    if (typeof consentId !== "string" || consentId.length === 0) {
      return new Response("invalid consent id", { status: 400 });
    }
    if (!await auth.revokeOAuthConsent(session.user.id, consentId)) {
      return new Response("consent not found", { status: 404 });
    }
    return c.redirect("/oauth/consents", 303);
  });
}
