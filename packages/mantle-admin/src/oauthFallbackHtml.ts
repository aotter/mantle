/** Minimal functional OAuth fallback for deployments without Admin assets. */

import type { OAuthConsentInfo, OAuthConsentRequest } from "./mountMantleOAuth.js";

/** Detect consent UI locale from Accept-Language header. */
export function detectOAuthFallbackLocale(acceptLanguage: string | null): "zh-TW" | "en" {
  if (!acceptLanguage) return "en";
  const lower = acceptLanguage.toLowerCase();
  if (lower.includes("zh-tw") || lower.includes("zh_tw")) return "zh-TW";
  return "en";
}

const STRINGS = {
  en: {
    title: "Authorize · mantle",
    eyebrow: "Connect an MCP client",
    heading: (client: string) => `Connect ${client}?`,
    body: (client: string) => `${client} will be able to use this site's management tools through MCP. What it can view or change is still limited by your account permissions.`,
    approve: "Connect",
    deny: "Cancel",
    invalidTitle: "Invalid authorization request",
    invalidBody: "Missing or malformed consent payload. Return to your MCP client and try again.",
    appsTitle: "MCP connections · mantle",
    appsEyebrow: "Your account",
    appsHeading: "MCP connections",
    appsBody: "These MCP clients can use the site's management tools. Every action is still checked against your current account permissions.",
    appsEmpty: "No MCP clients are connected.",
    revoke: "Disconnect",
    back: "Back to admin",
  },
  "zh-TW": {
    title: "授權 · mantle",
    eyebrow: "連結 MCP 客戶端",
    heading: (client: string) => `要連結 ${client} 嗎？`,
    body: (client: string) => `${client} 將能透過 MCP 使用這個網站提供的管理工具；它能查看或變更哪些內容，仍會依照你的帳號權限決定。`,
    approve: "連結",
    deny: "取消",
    invalidTitle: "無效的授權請求",
    invalidBody: "缺少或格式錯誤的授權資訊，請返回 MCP 客戶端重試。",
    appsTitle: "MCP 連線 · mantle",
    appsEyebrow: "你的帳號",
    appsHeading: "MCP 連線",
    appsBody: "這些 MCP 客戶端可以使用網站提供的管理工具；每次操作仍會依照你當下的帳號權限檢查。",
    appsEmpty: "目前沒有已連結的 MCP 客戶端。",
    revoke: "中斷連線",
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
  :root{color-scheme:light dark;font:1rem/1.5 system-ui,sans-serif}
  body{margin:0;padding:2rem 1rem}
  main{max-width:32rem;margin:10vh auto}
  h1{font-size:1.5rem}
  code{overflow-wrap:anywhere}
  button{font:inherit;padding:.5rem 1rem;cursor:pointer}
  button:focus-visible,a:focus-visible{outline:2px solid currentColor;outline-offset:3px}
  .actions{display:flex;flex-wrap:wrap;gap:.75rem}
  .app{padding:1rem 0;border-bottom:1px solid GrayText}
  .apps{margin-bottom:2rem}
`.trim();

export function renderConsentFallbackHtml(
  locale: "zh-TW" | "en",
  model: OAuthConsentRequest | null,
): string {
  const t = STRINGS[locale];
  const lang = locale === "zh-TW" ? "zh-Hant-TW" : "en";
  const head = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${t.title}</title><style>${CSS}</style></head><body><main class="card">`;
  const tail = `</main></body></html>`;

  if (!model) {
    return `${head}<p class="eyebrow">${t.eyebrow}</p><h1>${t.invalidTitle}</h1><p class="muted">${t.invalidBody}</p>${tail}`;
  }

  return (
    `${head}` +
    `<p class="eyebrow">${t.eyebrow}</p>` +
    `<h1>${t.heading(escapeHtml(model.clientName))}</h1>` +
    `<p class="muted">${t.body(escapeHtml(model.clientName))}</p>` +
    `<form class="actions" method="post" action="/oauth/consent">` +
    `<input type="hidden" name="oauth_query" value="${escapeHtml(model.oauthQuery)}"/>` +
    `<button type="submit" name="decision" value="approve">${t.approve}</button>` +
    `<button type="submit" name="decision" value="deny">${t.deny}</button>` +
    `</form>` +
    `${tail}`
  );
}

export function renderConnectedAppsFallbackHtml(
  locale: "zh-TW" | "en",
  consents: readonly OAuthConsentInfo[],
): string {
  const t = STRINGS[locale];
  const lang = locale === "zh-TW" ? "zh-Hant-TW" : "en";
  const apps = consents.length === 0
    ? `<p class="muted">${t.appsEmpty}</p>`
    : `<div class="apps">${consents.map((consent) => (
        `<section class="app"><h2>${escapeHtml(consent.clientName)}</h2>` +
        `<code>${escapeHtml(consent.clientId)}</code>` +
        `<form method="post" action="/oauth/consents/revoke">` +
        `<input type="hidden" name="consent_id" value="${escapeHtml(consent.id)}"/>` +
        `<button type="submit">${t.revoke}</button>` +
        `</form></section>`
      )).join("")}</div>`;
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"/>` +
    `<title>${t.appsTitle}</title><style>${CSS}</style></head><body><main class="card">` +
    `<p class="eyebrow">${t.appsEyebrow}</p><h1>${t.appsHeading}</h1>` +
    `<p class="muted">${t.appsBody}</p>${apps}<a class="back" href="/admin">${t.back}</a>` +
    `</main></body></html>`
  );
}
