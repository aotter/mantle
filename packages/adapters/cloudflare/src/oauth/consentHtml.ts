/**
 * OAuth consent UI renderer. Self-contained HTML — no external assets,
 * no framework and no Admin UI dependency.
 * Supports zh-TW and en locales.
 */

import type { OAuthConsentInfo } from "../auth/createAuth.js";

export interface ConsentModel {
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly oauthQuery: string;
}

/** Detect consent UI locale from Accept-Language header. */
export function detectConsentLocale(acceptLanguage: string | null): "zh-TW" | "en" {
  if (!acceptLanguage) return "en";
  const lower = acceptLanguage.toLowerCase();
  if (lower.includes("zh-tw") || lower.includes("zh_tw")) return "zh-TW";
  return "en";
}

const STRINGS = {
  en: {
    title: "Authorize · mantle",
    eyebrow: "Authorize MCP access",
    heading: (client: string) => `Allow ${client} to access your CMS?`,
    redirectLabel: "Will redirect to",
    scopesLabel: "Requested scopes",
    approve: "Approve",
    approving: "Approving…",
    deny: "Deny",
    denying: "Denying…",
    invalidTitle: "Invalid authorization request",
    invalidBody: "Missing or malformed consent payload. Return to your MCP client and try again.",
    appsTitle: "Connected apps · mantle",
    appsEyebrow: "OAuth access",
    appsHeading: "Connected apps",
    appsBody: "Apps you authorized to access this site.",
    appsEmpty: "No connected apps.",
    revoke: "Revoke access",
    revoking: "Revoking…",
    back: "Back to admin",
  },
  "zh-TW": {
    title: "授權 · mantle",
    eyebrow: "授權 MCP 存取",
    heading: (client: string) => `允許 ${client} 存取您的 CMS？`,
    redirectLabel: "將重新導向至",
    scopesLabel: "請求的授權範圍",
    approve: "同意",
    approving: "授權中…",
    deny: "拒絕",
    denying: "拒絕中…",
    invalidTitle: "無效的授權請求",
    invalidBody: "缺少或格式錯誤的授權資訊，請返回 MCP 客戶端重試。",
    appsTitle: "已連結應用程式 · mantle",
    appsEyebrow: "OAuth 存取權",
    appsHeading: "已連結應用程式",
    appsBody: "您已授權存取此站台的應用程式。",
    appsEmpty: "目前沒有已連結的應用程式。",
    revoke: "撤銷存取權",
    revoking: "撤銷中…",
    back: "返回管理後台",
  },
} as const;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
  :root{--mantle-blue-deep:#1a3062;--app-background:#f6f8fc;--foreground:#172033;--card:#fff;--card-foreground:#172033;--border:#d7dce7;--muted:#f1f3f8;--muted-foreground:#596579;--primary:#1a3062;--primary-foreground:#fff;--secondary:#edf1fa;--secondary-foreground:#1a3062;--accent:#e2e8f5;--ring:#4d6aac;--radius:.625rem}
  *{box-sizing:border-box}
  body{margin:0;min-height:100svh;display:flex;align-items:center;justify-content:center;padding:1rem;font-family:ui-sans-serif,system-ui,sans-serif;color:var(--foreground);background:var(--app-background)}
  .card{max-width:32rem;width:100%;padding:2rem;border-radius:calc(var(--radius) + .125rem);color:var(--card-foreground);background:var(--card);border:1px solid var(--border);box-shadow:0 12px 36px color-mix(in srgb,var(--mantle-blue-deep) 8%,transparent);backdrop-filter:blur(48px) saturate(135%)}
  .eyebrow{font-size:.7rem;text-transform:uppercase;letter-spacing:.18em;font-weight:500;color:var(--muted-foreground);margin:0 0 .5rem}
  h1{font-size:1.5rem;line-height:1.3;font-weight:500;margin:0 0 .75rem;letter-spacing:-.02em}
  p{margin:0 0 1rem;font-size:.95rem;line-height:1.55}
  .muted{color:var(--muted-foreground);font-size:.875rem}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;padding:.125rem .4rem;border-radius:.25rem;background:var(--muted);overflow-wrap:anywhere}
  .scopes{margin:0 0 1.5rem;display:flex;flex-wrap:wrap;gap:.375rem}
  .scope{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.75rem;padding:.25rem .5rem;border-radius:.25rem;background:var(--muted)}
  .actions{display:flex;gap:.75rem}
  button{flex:1;display:flex;align-items:center;justify-content:center;gap:.5rem;padding:.625rem 1rem;border:0;border-radius:.5rem;font:inherit;font-weight:500;cursor:pointer;transition:opacity .15s,background .15s}
  button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
  button:disabled{cursor:not-allowed;opacity:.65}
  button[data-loading="true"]::before{content:"";width:.875rem;height:.875rem;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .65s linear infinite}
  button[value="approve"]{background:var(--primary);color:var(--primary-foreground)}
  button[value="approve"]:not(:disabled):hover{opacity:.9}
  button[value="deny"]{background:var(--secondary);color:var(--secondary-foreground)}
  button[value="deny"]:not(:disabled):hover{background:var(--accent)}
  .apps{display:grid;gap:.75rem;margin:1.5rem 0}
  .app{padding:1rem;border:1px solid var(--border);border-radius:.5rem}
  .app h2{font-size:1rem;margin:0 0 .25rem}
  .app .scopes{margin:.75rem 0}
  .app form{display:flex;justify-content:flex-end}
  .app button{flex:0 0 auto;background:var(--secondary);color:var(--secondary-foreground)}
  .app button:not(:disabled):hover{background:var(--accent)}
  .back{color:var(--primary);font-size:.875rem}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media(prefers-reduced-motion:reduce){button[data-loading="true"]::before{animation-duration:1.5s}}
  @media(max-width:30rem){.actions{flex-direction:column}}
`.trim();

function submitScript(nonce: string): string {
  return `<script nonce="${escapeHtml(nonce)}">for(const form of document.querySelectorAll("form[data-submit-lock]"))form.addEventListener("submit",function(event){const button=event.submitter;if(!button)return;const decision=this.elements.namedItem("decision");if(decision)decision.value=button.value;this.setAttribute("aria-busy","true");button.dataset.loading="true";button.textContent=button.dataset.loadingLabel;for(const action of this.querySelectorAll("button"))action.disabled=true;});</script>`;
}

export function renderConsentHtml(
  locale: "zh-TW" | "en",
  model: ConsentModel | null,
  nonce: string,
): string {
  const t = STRINGS[locale];
  const lang = locale === "zh-TW" ? "zh-Hant-TW" : "en";
  const head = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${t.title}</title><style>${CSS}</style></head><body><main class="card">`;
  const tail = `</main></body></html>`;

  if (!model) {
    return `${head}<p class="eyebrow">${t.eyebrow}</p><h1>${t.invalidTitle}</h1><p class="muted">${t.invalidBody}</p>${tail}`;
  }

  const scopesBlock =
    model.scopes.length > 0
      ? `<p class="eyebrow">${t.scopesLabel}</p><div class="scopes">${model.scopes.map((s) => `<span class="scope">${escapeHtml(s)}</span>`).join("")}</div>`
      : "";

  return (
    `${head}` +
    `<p class="eyebrow">${t.eyebrow}</p>` +
    `<h1>${t.heading(escapeHtml(model.clientName))}</h1>` +
    `<p class="muted">${t.redirectLabel} <code>${escapeHtml(model.redirectUri)}</code></p>` +
    `${scopesBlock}` +
    `<form class="actions" method="post" action="/oauth/consent" data-submit-lock>` +
    `<input type="hidden" name="oauth_query" value="${escapeHtml(model.oauthQuery)}"/>` +
    `<input type="hidden" name="decision"/>` +
    `<button type="submit" value="approve" data-loading-label="${t.approving}">${t.approve}</button>` +
    `<button type="submit" value="deny" data-loading-label="${t.denying}">${t.deny}</button>` +
    `</form>` +
    `${submitScript(nonce)}` +
    `${tail}`
  );
}

export function renderConnectedAppsHtml(
  locale: "zh-TW" | "en",
  consents: readonly OAuthConsentInfo[],
  nonce: string,
): string {
  const t = STRINGS[locale];
  const lang = locale === "zh-TW" ? "zh-Hant-TW" : "en";
  const apps = consents.length === 0
    ? `<p class="muted">${t.appsEmpty}</p>`
    : `<div class="apps">${consents.map((consent) => (
        `<section class="app"><h2>${escapeHtml(consent.clientName)}</h2>` +
        `<code>${escapeHtml(consent.clientId)}</code>` +
        (consent.scopes.length === 0
          ? ""
          : `<div class="scopes">${consent.scopes.map((scope) => `<span class="scope">${escapeHtml(scope)}</span>`).join("")}</div>`) +
        `<form method="post" action="/oauth/consents/revoke" data-submit-lock>` +
        `<input type="hidden" name="consent_id" value="${escapeHtml(consent.id)}"/>` +
        `<button type="submit" data-loading-label="${t.revoking}">${t.revoke}</button>` +
        `</form></section>`
      )).join("")}</div>`;
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"/>` +
    `<title>${t.appsTitle}</title><style>${CSS}</style></head><body><main class="card">` +
    `<p class="eyebrow">${t.appsEyebrow}</p><h1>${t.appsHeading}</h1>` +
    `<p class="muted">${t.appsBody}</p>${apps}<a class="back" href="/admin">${t.back}</a>` +
    `${submitScript(nonce)}</main></body></html>`
  );
}
