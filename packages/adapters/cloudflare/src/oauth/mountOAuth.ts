import type { Env, Hono } from "hono";
import type { Auth, OAuthConsentRequest } from "../auth/createAuth.js";
import { rejectCrossOriginMutation } from "../auth/rejectCrossOriginMutation.js";
import {
  detectConsentLocale,
  renderConnectedAppsHtml,
  renderConsentHtml,
} from "./consentHtml.js";

export interface MountAuthorizeOptions {
  readonly auth: Auth;
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

/** Mount Mantle's small server-rendered consent page. Better Auth owns the
 * signed authorization query, client lookup, decision, and redirect. */
export function mountAuthorize<E extends Env>(
  app: Hono<E>,
  options: MountAuthorizeOptions,
): void {
  const { auth } = options;

  app.get("/oauth/consent", async (c) => {
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
