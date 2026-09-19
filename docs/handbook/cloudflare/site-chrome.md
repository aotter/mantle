---
description: Host-owned site chrome — Cloudflare-first analytics, verification, robots, and what still belongs in mantle-web.
---
# Site chrome

Core `siteConfig` is deployment identity: locales, brand, title, description, origin, icons and media. Visitor analytics, pixels, search-engine verification tokens, `ads.txt` and similar chrome are **host responsibility**. Admin Settings does not accept tracking IDs, and `@aotter/mantle-web` does not inject vendor snippets from `siteConfig`.

Cloudflare-native platform capabilities are the first-class place for chrome that the zone already covers. Do not invent a parallel “CDN settings center” inside Mantle.

## Why Core does not inject

A headless runtime that rewrites the first `</head>` (or prepends to `<body>`) on a composed HTML string assumes one frontend shape: a complete SSR document that Core is allowed to mutate after the fact. Hosts are not one shape.

Frontends are plural. A Mantle consumer may serve SSR full HTML documents, a Vite/React (or other) SPA, a Worker plus static assets, Cloudflare Pages, or a custom wrapper that already owns `<html>`. Only the first of those even has a complete document string a runtime could splice into — and even then the attach point is the host template, not Core.

SPA, client-routed and hydration hosts attach analytics in **their own entry**: GTM or Zaraz, the app bootstrap, or Cloudflare Web Analytics. They do not expect Runtime or `mantle-web` to parse an HTML string and splice tags into it.

Silent injection from `siteConfig` would be a surprising side effect for any host that did not opt into “I emit a full document and you may rewrite it.” Core must not pretend to know every frontend’s attach point.

Therefore tracking and verification stay **host chrome**. Core `siteConfig` is not a tag-manager. The tables below say where to put chrome.

## Two layers

| Concern | Prefer | Usually still app / mantle-web |
|---|---|---|
| `robots.txt`, simple redirects, some `/.well-known` files, Cloudflare Web Analytics | **Cloudflare-native** | — |
| Dynamic sitemap (grows with content), `llms.txt`, SEO `.md` mirrors | — | Application mount or `@aotter/mantle-web` composition, then serve publicly |

Turning on Cloudflare Web Analytics is **not** the same as having an indexable sitemap or `llms.txt`. Analytics answers “who visited”; discovery files answer “what can a crawler or agent list”. Keep those jobs on the layer that owns the data.

Cloud tenant UX for ads.txt / robots / sitemap tools lives on the host product ([mantle-home Site Chrome](https://github.com/aotter/mantle-home/issues/65), [root files](https://github.com/aotter/mantle-home/issues/64)). Core stays injection-free.

## Cloudflare-first install

Use the dashboard, Wrangler, or an agent that can edit Worker / Pages config. None of these paths write Core Admin fields.

### Analytics

Prefer **Cloudflare Web Analytics** (and Zaraz when you need a tag manager) for first-party traffic measurement. Enable it on the zone; no Core `siteConfig` key is required.

To add GA4 or Meta Pixel:

1. Add the provider through **Cloudflare Zaraz** (recommended on a CF zone), or
2. Emit the vendor snippet from **your** entry/list templates in `@aotter/mantle-web`, or from a host HTML wrapper.

Do not put Measurement IDs or Pixel IDs in `siteDefaults`. Core does not persist or inject them.

### Search Console and Bing verification

Verify ownership with a host-owned method. On Cloudflare, prefer in this order:

1. **DNS TXT** at the zone apex (Search Console and Bing Webmaster both accept this).
2. **Cloudflare-managed HTML** via Zaraz or a small Worker / Pages header rewrite that adds `<meta name="google-site-verification">` / Bing equivalent.
3. A **static verification file** at `/` or `/.well-known/` served from `public/` / the `ASSETS` binding.

HTML-tag verification belongs in the host template `<head>`, not in Core Settings.

### robots.txt, redirects, well-known

Serve a static `robots.txt` from assets, or use Cloudflare Redirect Rules / Transform Rules / a tiny Worker route. `mountPublicRoutes` also emits `GET /robots.txt` (`Allow: /` plus the sitemap URL) when you opt into public pages — that is an application mount, not a Core Admin setting. See [Public web](./public-web.md).

Simple path redirects and most `/.well-known` files (including verification and `security.txt`) belong on the same Cloudflare-native layer.

## What still belongs in the app

Dynamic **sitemap** and **`llms.txt`** grow with published content. Compose them with `@aotter/mantle-web` (`composeSitemap`, `composeLlmsTxt`) and mount the public URLs, or implement the same contract in the application. Cloudflare Web Analytics does not generate those files.

SEO `.md` mirrors are likewise application / `mantle-web` composition. Details: [Public web](./public-web.md) and [Site config](../reference/site-config.md).

## Source

- [`packages/mantle-spec/src/domain/model/SiteConfig.ts`](../../../packages/mantle-spec/src/domain/model/SiteConfig.ts)
- [`packages/mantle-web/src/service/HtmlRenderer.ts`](../../../packages/mantle-web/src/service/HtmlRenderer.ts)
- [`docs/handbook/reference/site-config.md`](../reference/site-config.md)
- [`docs/handbook/cloudflare/public-web.md`](./public-web.md)
