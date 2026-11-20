---
description: "The one requirement for an indexable page, the recommended shape with its reasons and measurements, when to choose something else, and the checklist."
---
# Public pages: SEO, AEO and languages

A public page is anonymous and indexable. This page states the one thing such a page must do, the shape Mantle
recommends for the rest and why, when another shape fits better, and the checklist an agent follows. Skills, examples
and other pages link here instead of repeating it. The reference implementation is the recipes example,
`node_modules/@aotter/mantle/docs/examples/recipes`; its `smoke.mjs` checks the items below.

## The one requirement

Content that should be found by search or answer engines is in the HTML the server returns for its URL: the text in
the body, the title and description in the head, without running JavaScript.

The reason is external evidence, not a measurement of ours, and it can change. Published crawl analyses (for example
[Vercel's](https://vercel.com/blog/the-rise-of-the-ai-crawler), December 2024) report that AI crawlers such as
GPTBot, ClaudeBot and PerplexityBot fetch the raw HTML and do not execute JavaScript. Google does execute it, but in a
[rendering step queued after the crawl](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)
that can take longer than a few seconds. Nothing we found reads `<link rel="alternate" type="text/markdown">`, and
`llms.txt` is read mostly by coding agents, so neither replaces the HTML.

Everything else on this page is a recommendation. The site's code is the application's: a different shape that meets
the requirement and the checklist is a valid choice.

## The recommended shape

What the recipes example does, each with its reason. Numbers were measured 2026-11-20 on Cloudflare Workers Free
(`workers.dev`), render only, with the data in memory
([method](https://github.com/aotter/mantle/issues/2102)).

- **Server-rendered React with plain elements.** Pages are React components (`src/pages.tsx`) rendered with
  `renderToString` (`src/html.tsx`), using plain elements and the class names of the kit's stylesheet; no kit React
  components in the server render. JSX escapes every interpolated value by default, and pages are mostly written by
  coding agents: a string template that forgets one escape is an XSS. The parts that hydrate in the browser use the
  same component model. Cost: a warm render takes 1–3 ms of CPU; the first render in a new isolate 7–12 ms with plain
  elements and 12–45 ms with kit components, which on the server only produce class names.
- **React loads when a page route matches.** `src/routes.ts` reaches `src/html.tsx` only through `import()`, started
  beside the page's read, so `.md`, `llms.txt`, the sitemap, REST, MCP and Admin never load React. The example's
  `smoke.mjs` checks that the built Worker's static graph holds no React.
- **Interaction is a small part, loaded late.** The server renders the whole page, including the interactive part as
  plain markup (the save button). One module script of a few hundred bytes (`src/client/page.ts`) loads that part's
  code (`src/client/save.tsx`) when it nears the viewport or is first used, and hydrates it. The page works without
  JavaScript except for that part, and React stays off the first load. Kit components belong in this browser part.
- **`.md` alternates, `llms.txt`, `sitemap.xml` and the canonical and Markdown head tags come from the generated
  `web()`** ([contract](../reference/surface.md#optional-web-output)): it walks each list View's cursor chain, keeps
  drafts out by SQL, sends an ETag, and answers a signed-in caller `private, no-store`. The page writes its own
  `<title>`, description, per-language `hreflang` with `x-default`, Open Graph and JSON-LD in JSX, because only the
  application knows which translations exist and how its rows map to schema.org.
  `head(request, env, ctx, { row })` takes the row the page already read, so the tags cost no second query.
- **List Views are light.** A list View returns what a list item, the sitemap and `llms.txt` need (key, title,
  description, `updated_at`), never the page's body: the indexes walk it row by row, up to 50,000 rows. A page View
  reads one row by its key and returns everything the page and its `.md` need.
- **Every response states `Cache-Control`**: public pages are briefly cached and served stale while they refresh;
  redirects, 404s, errors and anything built for a caller are `no-store`. The values and why are in
  [caching](caching.md).
- **String templates remain a valid choice** for a site that accepts hand-escaping. They cost the least CPU (≤ 2 ms
  even on a first render, same measurement). The site must then escape every interpolated value, attributes
  included, and write `<` as `\u003c` inside JSON-LD so stored text cannot close the script element.

## When to choose something else

A spectrum, not a rule. Choose by what must be indexed and how much the visitor does on the page.

| Site or area | Shape |
| --- | --- |
| Content: recipes, a blog, docs | Server-rendered, almost no JavaScript |
| Content with a few interactive parts: a product page with "add to cart", an article with "save" | Server-rendered, plus parts loaded late |
| Highly interactive, nothing to index: a cart, checkout, a dashboard, an internal tool | A single-page app under its own path prefix |

One site often spans all three. In a shop the catalogue and product pages are indexable; the cart and checkout are not.

### A single-page app beside the pages

The app lives under one prefix such as `/app/*`. Its entry is a file in `src/client/`, which `mantle bundle` builds to
`/assets/client/<name>.js` ([outputs](../start/project-and-cli.md#outputs)); it reads Views and writes through REST
Triggers. The purchasing example's `/app` shows one (`docs/examples/purchasing`, `src/client/`).

- Indexable content is never only in the app: everything a search or answer engine should find has its own
  server-rendered URL, and the app adds what a signed-in visitor does with it. The public pages link into the app.
- Its shell carries `<meta name="robots" content="noindex">` and the Worker sends `X-Robots-Tag: noindex`; it is left
  out of `sitemap.xml` and `llms.txt`.
- It is not disallowed in `robots.txt`: a crawler never fetches a blocked page, so it never reads that page's
  `noindex`.
- Anonymous visitors go to `/sign-in` and back (`signInRedirect` in the app shell's `src/sign-in.ts`).
- Unknown URLs outside the prefix stay real 404s; only paths under the prefix answer with the shell.

## Render cost and its limits

With [Workers Cache](caching.md#workers-cache) and the public header, a page is rendered at most about once a minute
per URL, so render cost matters mainly for the first request of an isolate and for a site without a cache. On Workers
Free the 10 ms CPU limit behaved as a budget in our test (2026-11-20): single requests up to about 1 s of CPU
succeeded, and sustained overage was killed. Do not design around exactly 10 ms, and do not ignore it either. The
measured costs are in [caching](caching.md#measured-costs); targets and how to measure are in the
[performance pass](performance.md).

## URLs

Mantle owns `/admin`, `/mcp`, `/api/auth/`, `/oauth/consent` and `/.well-known/oauth-*`, and the app's HTTP Triggers own
their declared paths. Give visitor pages their own prefix (`/{locale}/…`, `/recipes/{slug}`), or make a root page
(`/{slug}`) return nothing for those paths; the app shell already keeps `/admin` and `/mcp` away from `src/routes.ts`.

## Every public page

- The content in the HTML body, server-rendered per URL (the requirement).
- `<html lang>`, `<title>`, `<meta name="description">`.
- `<link rel="canonical">` built from the configured origin (`PUBLIC_ORIGIN`), never from the request `Host`, which a
  client controls.
- Open Graph: `og:type`, `og:url` (the canonical), `og:title`, `og:description`, `og:site_name`, `og:locale`
  (underscore form, `zh_TW`), and `og:image` when the content has an image; link previews read these.
- Read as the anonymous caller, even when the request carries a session: drafts and anything a visitor may not read
  are absent, and every visitor gets the same bytes, so a shared cache may keep them.
- Unknown URLs answer 404.

## Detail pages

- JSON-LD of the matching schema.org type (`Recipe`, `Article`, `Event`, `Product`, ...), which search engines read
  for rich results, built from the same row as the visible content: `name`, `description`, `url`, `inLanguage`,
  `datePublished`, `dateModified`, and `image` when there is one (some rich results require it). A type that has no
  date or language properties (`Product`) gets them on a page node instead: an `@graph` with an `ItemPage`
  (`inLanguage`, dates, `mainEntity`) pointing to the `Product` (`offers` with `price` and `priceCurrency`). Write `<`
  as `\u003c` in the serialized JSON so stored text cannot close the script element. Do not add facts the page does
  not show.
- Recommended: a short answer block, one question heading and a one-sentence answer from the row's data, so an answer
  engine has a sentence it can quote.
- A Markdown alternate at `<url>.md`, linked with `<link rel="alternate" type="text/markdown">`. `web()` serves it
  from the page View at little cost; coding agents and tools that ask for Markdown use it, but nothing found reads it
  for indexing (above).

## More than one language

- One URL per language (`/{locale}/...`), with `hreflang` alternates for each language the page exists in, plus
  `x-default`. A language that is not published for this item gets no alternate and its URL is a 404.
- `og:locale:alternate` for the other languages, and a visible language switcher with `hreflang` and `lang` on links.
- Per-language Markdown alternates; `llms.txt` lists each language's items.

## Site files

- `/sitemap.xml` with every public URL in every language. `web()` builds it from the list Views and the static paths
  you give it (home and list pages), walking each list's complete cursor chain.
- `/robots.txt` with `Disallow: /admin/` and the sitemap URL; the app writes it.
- `/llms.txt` ([llmstxt.org](https://llmstxt.org)) from `web()`: a title, a one-line summary and a link to each
  item's Markdown alternate.

## A complete site

When the brief names a site, shop, catalogue or blog for visitors, these are part of the work without the user
listing them:

- Every item on this page, for every public page type the site has.
- Accessible, responsive pages. The recipes example links one stylesheet, the kit's `kit.css` plus two layout rules,
  and uses only its classes; a site may use its own styles instead.
- Content managed in Admin (draft, publish, edit, unpublish) shows on the site without a rebuild. Images go through
  Admin's media library (`mantle help media-r2`); store committed asset IDs and never use an ID as an image URL.
- Members' pages, if any, send anonymous visitors to `/sign-in` (`signInRedirect` in the app shell's `src/sign-in.ts`).
- Who runs the site: an About/contact page and a footer with the business's name, location and contact, and on the
  home page `Organization` (or `LocalBusiness`) JSON-LD with the same facts and the logo, so a reader or an answer
  engine can tell whether the site is legitimate. Ask for the facts the brief lacks; never invent an address.
- A favicon, and `og:image` on the home and list pages too.
- A detail page leads to the action the brief sells (order, register, book), saying when it needs an account.
- Every response states its `Cache-Control` ([caching](caching.md)).
- Structured data and answer blocks state only what the page shows. Never promise ranking or AI citation.

## Check before you report done

Request each page with plain `fetch`, which runs no JavaScript, as the recipes example's `smoke.mjs` does
(`mantle help local-testing`), and assert:

1. HTML content type and the content in the body: the recipes smoke finds the `<h1>`, every ingredient and every step,
   in order. `<title>`, description, canonical on `PUBLIC_ORIGIN`, Open Graph; on detail pages JSON-LD that parses
   with the visible name, and the answer block.
2. Each `.md` alternate returns `text/markdown` with the current text.
3. `llms.txt` and the sitemap list every published item in every language (with `lastmod`), and list Views carry no
   body. Below the generated `web()` caps (5,000 rows for `llms.txt`, 50,000 for the sitemap), walking the list View's
   complete cursor chain gives the same rows. `/robots.txt` names the sitemap.
4. An unknown URL, a malformed path, a draft and a row the visitor may not read are 404, also with an admin session.
5. A signed-in member's and an admin's page, `.md` and `llms.txt` are byte-identical to the anonymous ones, with no
   `Set-Cookie`.
6. Every response states `Cache-Control`: public on pages, `.md`, `llms.txt`, the sitemap and `robots.txt`;
   `no-store` on redirects, 404s, 405s and the sign-in page.
7. Publish, edit and unpublish an item through Admin's API (or the Procedure Admin uses); after each, its page,
   `.md`, sitemap and `llms.txt` follow.
8. Stored text with `<`, `&` and `</script>` renders escaped in HTML and inside JSON-LD.
9. With React on the server: the built Worker's static graph holds no React, and the page loads only the small module
   script, never the interactive part's bundle.

Report a check you could not run (for example a production origin you do not have) as UNVERIFIED with the reason.
Then run [independent acceptance](agent-workflow-acceptance.md) with a visitor evaluator in a browser on the
`pnpm accept` URL; a browser run of the interactive part (late load, hydration, sign-in) belongs there, not in the
smoke.
