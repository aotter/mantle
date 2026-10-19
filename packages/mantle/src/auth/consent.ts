/** OAuth consent and connected-app routes with their pages, loaded with ./oauth.js on the first consent request. */
import type { Caller } from "../kernel/contracts.js";
import type { oauthConsents, OAuthConsentRequest, OAuthConsentInfo } from "./oauth.js";
import type { AuthRoutesOptions } from "./routes.js";
import { PRIVATE, json, readBody, redirect, text } from "./route-http.js";

type AuthRoutesAuth = ReturnType<typeof oauthConsents>;

export function consentSurface(auth: AuthRoutesAuth, options: AuthRoutesOptions): (request: Request, caller: Caller, route: string) => Promise<Response> {
  const { listOAuthConsents: list, revokeOAuthConsent: revoke } = auth;
  return async (request, caller, route) => {
    const person = caller.kind === "user" && caller.credential === "session" ? caller.subject : null;
    const locale = /zh[-_]tw/i.test(request.headers.get("accept-language") ?? "") ? "zh-TW" : "en";

    if (route === "GET /oauth/consent/data") {
      if (!person) return json({ consent: null }, 401);
      const model = await auth.getOAuthConsentRequest(request).catch(() => null); // an invalid signed query stays secret-free
      return json({ consent: model }, model ? 200 : 400);
    }
    if (route === "GET /oauth/consent") {
      const model = await auth.getOAuthConsentRequest(request).catch(() => null);
      return html(consentHtml(locale, model), model ? 200 : 400);
    }
    if (route === "POST /oauth/consent") {
      if (!person) return text("sign in to answer this request", 401);
      const body = await readBody(request);
      const decision = new URLSearchParams(body).get("decision");
      if (decision !== "approve" && decision !== "deny") return text("invalid consent decision", 400);
      // the redirect is the one Better Auth validated against the client's registration; nothing in the request names it
      const location = await auth.completeOAuthConsent(new Request(request, { body }), decision === "approve").catch(() => null);
      const target = location && URL.canParse(location) ? new URL(location) : null;
      if (!target || /^(javascript|data|vbscript|blob):$/i.test(target.protocol)) return text("invalid authorization request", 400);
      // the parsed form, so a browser cannot read `https:\\evil.test` differently from the check
      return redirect(target.href);
    }
    if (!list || !revoke) return text("not found", 404);
    if (route === "GET /oauth/consents") {
      if (options.connectedAppsPage) return redirect(options.connectedAppsPage);
      if (!person) return text("sign in to see your connected apps", 401);
      return html(connectedAppsHtml(locale, await list(person)), 200);
    }
    if (route === "GET /oauth/consents/data") {
      if (!person) return json({ consents: [] }, 401);
      return json({ consents: await list(person) });
    }
    if (route === "POST /oauth/consents/revoke") {
      if (!person) return text("sign in to revoke a connection", 401);
      const body = await readBody(request);
      const id = new URLSearchParams(body).get("consent_id");
      if (!id) return text("invalid consent id", 400);
      if (!await revoke(person, id)) return text("consent not found", 404);
      return redirect("/oauth/consents", 303);
    }
    return text("not found", 404);
  };
}

// ---- the pages a service without Admin shows: Admin is an optional subpath (ADR-0032 decision 13), OAuth is not tied to it

/**
 * No `form-action`: browsers check it against every redirect of a form's navigation, so a callback that redirects again
 * (www.cursor.com answers 308 to cursor.com) would hang the approval. The page runs no script and escapes every value.
 */
function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      ...PRIVATE, "content-type": "text/html; charset=UTF-8", "referrer-policy": "same-origin", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

const T = {
  en: {
    lang: "en", title: "Authorize", eyebrow: "Connect an MCP client", heading: (c: string) => `Connect ${c}?`,
    body: (c: string) => `${c} will be able to use this site's tools through MCP. What it can view or change is still limited by your account permissions.`,
    returnsTo: "Returns to", scopes: "Requested access", approve: "Connect", deny: "Cancel", invalid: "Invalid authorization request", invalidBody: "Missing or malformed consent payload. Return to your MCP client and try again.",
    apps: "MCP connections", appsBody: "These MCP clients can use this site's tools. Every action is still checked against your current account permissions.", empty: "No MCP clients are connected.", revoke: "Disconnect",
  },
  "zh-TW": {
    lang: "zh-Hant-TW", title: "授權", eyebrow: "連結 MCP 客戶端", heading: (c: string) => `要連結 ${c} 嗎？`,
    body: (c: string) => `${c} 將能透過 MCP 使用這個網站提供的工具；它能查看或變更哪些內容，仍會依照你的帳號權限決定。`,
    returnsTo: "完成後返回", scopes: "要求的權限", approve: "連結", deny: "取消", invalid: "無效的授權請求", invalidBody: "缺少或格式錯誤的授權資訊，請返回 MCP 客戶端重試。",
    apps: "MCP 連線", appsBody: "這些 MCP 客戶端可以使用網站提供的工具；每次操作仍會依照你當下的帳號權限檢查。", empty: "目前沒有已連結的 MCP 客戶端。", revoke: "中斷連線",
  },
} as const;
type Locale = keyof typeof T;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (l: Locale, title: string, main: string) =>
  `<!doctype html><html lang="${T[l].lang}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title>` +
  `<style>:root{color-scheme:light dark;font:1rem/1.5 system-ui,sans-serif}body{margin:0;padding:2rem 1rem}main{max-width:32rem;margin:10vh auto}code{overflow-wrap:anywhere}button{font:inherit;padding:.5rem 1rem;cursor:pointer}</style></head><body><main>${main}</main></body></html>`;

function consentHtml(l: Locale, model: OAuthConsentRequest | null): string {
  const t = T[l];
  if (!model) return page(l, t.title, `<p>${t.eyebrow}</p><h1>${t.invalid}</h1><p>${t.invalidBody}</p>`);
  const client = esc(model.clientName);
  // where the answer goes and what is asked, so a look-alike client name cannot hide either
  const host = URL.canParse(model.redirectUri) ? new URL(model.redirectUri).host || new URL(model.redirectUri).protocol : model.redirectUri;
  return page(l, t.title, `<p>${t.eyebrow}</p><h1>${t.heading(client)}</h1><p>${t.body(client)}</p>` +
    `<p>${t.returnsTo} <code>${esc(host)}</code></p><p>${t.scopes}</p><ul>${model.scopes.map((sc) => `<li><code>${esc(sc)}</code></li>`).join("")}</ul><form method="post" action="/oauth/consent">` +
    `<input type="hidden" name="oauth_query" value="${esc(model.oauthQuery)}"/><button type="submit" name="decision" value="approve">${t.approve}</button> ` +
    `<button type="submit" name="decision" value="deny">${t.deny}</button></form>`);
}

function connectedAppsHtml(l: Locale, consents: readonly OAuthConsentInfo[]): string {
  const t = T[l];
  const apps = consents.length === 0 ? `<p>${t.empty}</p>` : consents.map((c) =>
    `<section><h2>${esc(c.clientName)}</h2><code>${esc(c.clientId)}</code><form method="post" action="/oauth/consents/revoke">` +
    `<input type="hidden" name="consent_id" value="${esc(c.id)}"/><button type="submit">${t.revoke}</button></form></section>`).join("");
  return page(l, t.apps, `<h1>${t.apps}</h1><p>${t.appsBody}</p>${apps}`);
}
