/** OAuth consent and connected-app routes with their pages, loaded with ./oauth.js on the first consent request. */
import type { Caller } from "../kernel/contracts.js";
import type { oauthConsents, OAuthConsentRequest, OAuthConsentInfo } from "./oauth.js";
import type { AuthRoutesOptions } from "./routes.js";
import { PRIVATE, json, readBody, redirect, text } from "./route-http.js";
import { messages as T, systemDark, tokens } from "./consent-presentation.generated.js";

type AuthRoutesAuth = ReturnType<typeof oauthConsents>;

export function consentSurface(
  auth: AuthRoutesAuth,
  options: AuthRoutesOptions,
): (request: Request, caller: Caller, route: string) => Promise<Response> {
  const { listOAuthConsents: list, revokeOAuthConsent: revoke } = auth;
  return async (request, caller, route) => {
    const person = caller.kind === "user" && caller.credential === "session" ? caller.subject : null;

    if (route === "GET /oauth/consent/data") {
      if (!person) return json({ consent: null }, 401);
      const model = await auth.getOAuthConsentRequest(request).catch(() => null); // an invalid signed query stays secret-free
      return json({ consent: model }, model ? 200 : 400);
    }
    if (route === "GET /oauth/consent") {
      const view = pagePreferences(request);
      const model = await auth.getOAuthConsentRequest(new Request(view.url.href, request)).catch(() => null);
      return html(consentHtml(view, model), model ? 200 : 400);
    }
    if (route === "POST /oauth/consent") {
      if (!person) return text("sign in to answer this request", 401);
      const body = await readBody(request);
      const decision = new URLSearchParams(body).get("decision");
      if (decision !== "approve" && decision !== "deny") return text("invalid consent decision", 400);
      // the redirect is the one Better Auth validated against the client's registration; nothing in the request names it
      const location = await auth
        .completeOAuthConsent(new Request(request, { body }), decision === "approve")
        .catch(() => null);
      const target = location && URL.canParse(location) ? new URL(location) : null;
      if (!target || /^(javascript|data|vbscript|blob):$/i.test(target.protocol))
        return text("invalid authorization request", 400);
      // the parsed form, so a browser cannot read `https:\\evil.test` differently from the check
      return redirect(target.href);
    }
    if (!list || !revoke) return text("not found", 404);
    if (route === "GET /oauth/consents") {
      if (options.connectedAppsPage) return redirect(options.connectedAppsPage);
      if (!person) return text("sign in to see your connected apps", 401);
      return html(connectedAppsHtml(pagePreferences(request), await list(person)), 200);
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
      if (!(await revoke(person, id))) return text("consent not found", 404);
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
      ...PRIVATE,
      "content-type": "text/html; charset=UTF-8",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy":
        "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

type Locale = keyof typeof T;
const languages = Object.keys(T) as Locale[];
const themes = ["system", "light", "dark"] as const;
type Theme = (typeof themes)[number];

function pagePreferences(request: Request) {
  const url = new URL(request.url);
  // Strip only the UI prefix. URLSearchParams would reserialize the signed query, including its escaping.
  const match = /^\?mantle_ui=([a-zA-Z-]+)\.(system|light|dark)(&|$)/.exec(url.search);
  const chosen = languages.find(locale => locale === match?.[1]);
  const prefix = chosen ? match : null;
  const locale = chosen ?? browserLanguage(request.headers.get("accept-language") ?? "");
  const theme = (prefix?.[2] as Theme | undefined) ?? "system";
  if (prefix) url.search = url.search.slice(prefix[0].length);
  return { url, locale, theme };
}

function browserLanguage(header: string): Locale {
  const accepted = header.split(",").map(value => {
    const [tag, weight] = value.trim().toLowerCase().replaceAll("_", "-").split(";");
    return { tag: tag ?? "", weight: weight ? Number(weight.trim().replace(/^q=/, "")) : 1 };
  });
  for (const { tag, weight } of accepted.sort((a, b) => b.weight - a.weight)) {
    if (!(weight > 0)) continue;
    if (/^zh-(hant|tw|hk|mo)(-|$)/.test(tag)) return "zh-TW";
    if (/^zh(-|$)/.test(tag)) return "zh-CN";
    if (/^pt(-|$)/.test(tag)) return "pt-BR";
    if (/^iw(-|$)/.test(tag)) return "he";
    const locale = languages.find(locale => locale === tag.split("-")[0]);
    if (locale) return locale;
  }
  return "en";
}

type PagePreferences = ReturnType<typeof pagePreferences>;

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
function page({ url, locale: l, theme }: PagePreferences, title: string, main: string) {
  const t = T[l];
  const link = (nextLocale: Locale, nextTheme: Theme, label: string, current: boolean) =>
    `<a href="${esc(`?mantle_ui=${nextLocale}.${nextTheme}${url.search ? "&" + url.search.slice(1) : ""}`)}"${current ? ' aria-current="true"' : ""}>${label}</a>`;
  const prefs =
    `<nav aria-label="${t.language} / ${t.appearance}"><details name="preferences"><summary>${t.language}</summary><div>${languages.map(locale => link(locale, theme, T[locale].nativeLabel, locale === l)).join("")}</div></details>` +
    `<details name="preferences"><summary>${t.appearance}</summary><div>${themes.map(next => link(l, next, t[next], next === theme)).join("")}</div></details></nav>`;
  return (
    `<!doctype html><html lang="${t.lang}" dir="${t.dir}" data-theme="${theme}"${theme === "dark" ? ' class="dark"' : ""}><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title>` +
    `<style>${tokens}${systemDark}:root{font:.875rem/1.5 system-ui,sans-serif}` +
    "body{margin:0;min-height:100svh;display:grid;place-items:center;padding:1.5rem 1rem;box-sizing:border-box;background:var(--app-background);color:var(--foreground)}" +
    "main{width:100%;max-width:28rem;box-sizing:border-box;padding:1.5rem;background:var(--card);border:1px solid var(--border);border-radius:calc(var(--radius) + .25rem);box-shadow:0 12px 36px rgb(26 48 98/6%)}" +
    "main>:first-child{margin-top:0}main>:last-child{margin-bottom:0}h1{font-size:1.25rem;line-height:1.4;font-weight:600;margin:.25rem 0 .5rem}h2{font-size:1rem;font-weight:600;margin:0}p{margin:.75rem 0}.m{color:var(--muted-foreground)}" +
    "code{font:.75rem/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--foreground);background:var(--muted);border:1px solid var(--border);border-radius:.375rem;padding:.125rem .5rem;overflow-wrap:anywhere}" +
    "ul{list-style:none;display:flex;flex-wrap:wrap;gap:.5rem;margin:.5rem 0 0;padding:0}" +
    "button{font:inherit;font-weight:500;min-height:2.5rem;padding:0 1rem;color:var(--secondary-foreground);background:var(--secondary);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer}" +
    "button:hover{background-image:linear-gradient(rgb(128 128 128/14%) 0 0)}button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}[value=approve]{color:var(--primary-foreground);background-color:var(--primary);border-color:var(--primary)}" +
    "main>form{display:flex;gap:.5rem;margin-top:1.5rem}main>form button{flex:1}@media(max-width:40rem){main>form{flex-direction:column}}" +
    "section{display:grid;grid-template-columns:1fr auto;gap:.25rem 1rem;align-items:center;padding:1rem 0;border-top:1px solid var(--border)}section:last-child{padding-bottom:0}section>*{min-width:0;justify-self:start}section form{grid-area:1/2/3}section code{color:var(--muted-foreground);background:none;border:0;padding:0}" +
    "nav{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.5rem;margin-bottom:1rem}details{position:relative}summary{cursor:pointer;padding:.375rem .625rem;border:1px solid var(--border);border-radius:var(--radius)}details div{position:absolute;z-index:1;inset-inline-end:0;min-width:8rem;max-height:min(60vh,22rem);overflow:auto;padding:.25rem;background:var(--popover);border:1px solid var(--border);border-radius:var(--radius)}details a{display:block;padding:.375rem .625rem;color:var(--foreground);text-decoration:none;white-space:nowrap}details a:hover,details a[aria-current=true]{background:var(--secondary);border-radius:.375rem}a:focus-visible,summary:focus-visible{outline:2px solid var(--ring);outline-offset:2px}" +
    `</style></head><body><main>${prefs}${main}</main></body></html>`
  );
}

function consentHtml(view: PagePreferences, model: OAuthConsentRequest | null): string {
  const t = T[view.locale];
  if (!model) return page(view, t.invalid, `<p class="m">${t.eyebrow}</p><h1>${t.invalid}</h1><p>${t.invalidBody}</p>`);
  const client = esc(model.clientName);
  const heading = t.heading.replaceAll("{client}", () => client);
  // where the answer goes and what is asked, so a look-alike client name cannot hide either
  const host = URL.canParse(model.redirectUri)
    ? new URL(model.redirectUri).host || new URL(model.redirectUri).protocol
    : model.redirectUri;
  return page(
    view,
    heading,
    `<p class="m">${t.eyebrow}</p><h1>${heading}</h1><p>${t.body.replaceAll("{client}", () => client)}</p>` +
      `<p class="m">${t.returnsTo} <code>${esc(host)}</code></p><p class="m">${t.scopes}</p><ul>${model.scopes.map(sc => `<li><code>${esc(sc)}</code></li>`).join("")}</ul>` +
      (model.scopes.includes("offline_access") ? `<p class="m">${t.offline}</p>` : "") +
      `<form method="post" action="/oauth/consent">` +
      `<input type="hidden" name="oauth_query" value="${esc(model.oauthQuery)}"/><button type="submit" name="decision" value="approve">${t.approve}</button> ` +
      `<button type="submit" name="decision" value="deny">${t.deny}</button></form>`,
  );
}

function connectedAppsHtml(view: PagePreferences, consents: readonly OAuthConsentInfo[]): string {
  const t = T[view.locale];
  const apps =
    consents.length === 0
      ? `<p class="m">${t.empty}</p>`
      : consents
          .map(
            c =>
              `<section><h2>${esc(c.clientName)}</h2><code>${esc(c.clientId)}</code><form method="post" action="/oauth/consents/revoke">` +
              `<input type="hidden" name="consent_id" value="${esc(c.id)}"/><button type="submit">${t.revoke}</button></form></section>`,
          )
          .join("");
  return page(view, t.apps, `<h1>${t.apps}</h1><p>${t.appsBody}</p>${apps}`);
}
