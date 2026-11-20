# Public pages: SEO, AEO and languages

This page is the one list of what a public (anonymous, indexable) page emits. Skills, examples and other pages link
here instead of repeating it.

## Two ways to serve them

- **Generated `web()`**: `llms.txt`, sitemap, Markdown alternates and head tags (canonical, Markdown alternate) straight from
  public Views. It renders no HTML; the pages stay application-owned. Its contract and limits are in [surface contracts](../reference/surface.md#optional-web-output);
  the smallest example is `node_modules/@aotter/mantle/docs/examples/generated-web`.
- **App-owned pages** in `src/routes.ts`, when the page needs its own layout, JSON-LD or languages. The reference
  implementation is `node_modules/@aotter/mantle/docs/examples/recipes` (`src/pages.ts`, `src/routes.ts`; `smoke.mjs` checks every item below).
  `pageHead` from `@aotter/mantle/web` writes the head below (escaped tags, Open Graph, hreflang with `x-default`,
  JSON-LD) from values the page already has; see [surface contracts](../reference/surface.md#head-tags-for-application-owned-pages).

## Public pages plus a React app

A site that also needs an interactive area (saved items, a dashboard, a planner) keeps both: the public pages above stay
server-rendered, and the app is a React single-page app under one prefix such as `/app/*`. Indexable content is never
only in the SPA: everything a search or answer engine should find has its own server-rendered URL, and the app only adds
what a signed-in visitor does with it. The app's shell carries `<meta name="robots" content="noindex">` (the Worker also
sends `X-Robots-Tag: noindex`), is left out of `sitemap.xml` and `llms.txt`, is not disallowed in `robots.txt` (a blocked
page's `noindex` is never read), and sends anonymous visitors to `/sign-in` and back; the public pages link into it. The
app reads Views and writes only through the REST Triggers. Put its entry in `src/client/` (`spa.tsx`): `mantle bundle`
builds it to `/assets/client/spa.js`, which the shell loads ([outputs](../start/project-and-cli.md#outputs)). The reference is the recipes example's `/app`
(`src/routes.ts` `appShell`, `src/client/spa.tsx`, `public/app/index.html`; `smoke.mjs` checks the split).

## URLs

Mantle owns `/admin`, `/mcp`, `/api/auth/`, `/oauth/consent` and `/.well-known/oauth-*`, and the app's HTTP Triggers own
their declared paths. Give visitor pages their own prefix (`/{locale}/…`, `/teas/{slug}`), or make a root page (`/{slug}`)
return nothing for those paths; the app shell already keeps `/admin` and `/mcp` away from `src/routes.ts`.

## Every public page

- Server-rendered HTML per URL with the content in the body. A client-only SPA shell or metadata set by script is not
  enough for search or answer engines.
- `<html lang>`, `<title>`, `<meta name="description">`.
- `<link rel="canonical">` built from the configured origin (`PUBLIC_ORIGIN`), never from the request `Host`.
- Open Graph: `og:type`, `og:url` (the canonical), `og:title`, `og:description`, `og:site_name`, `og:locale`
  (underscore form, `zh_TW`), and `og:image` when the content has an image.
- Unknown URLs answer 404; drafts and anything a visitor may not read are absent, even when the request carries an
  admin session (read as an anonymous caller).

## Detail pages

- JSON-LD of the matching schema.org type (`Recipe`, `Article`, `Event`, `Product`, ...), built from the same row as
  the visible content: `name`, `description`, `url`, `inLanguage`, `datePublished`, `dateModified`, and `image` when
  there is one (some rich results require it). A type that has no date or language properties (`Product`) gets them on
  a page node instead: an `@graph` with an `ItemPage` (`inLanguage`, dates, `mainEntity`) pointing to the `Product`
  (`offers` with `price` and `priceCurrency`). Escape `<` in the serialized JSON so stored text cannot close the
  script element. Do not add facts the page does not show.
- A short answer block for answer engines: one question heading and a one-sentence answer from the row's data.
- A Markdown alternate at `<url>.md`, linked with `<link rel="alternate" type="text/markdown">`.

## More than one language

- One URL per language (`/{locale}/...`), with `hreflang` alternates for each language the page exists in, plus
  `x-default`. A language that is not published for this item gets no alternate and its URL is a 404.
- `og:locale:alternate` for the other languages, and a visible language switcher with `hreflang` and `lang` on links.
- Per-language Markdown alternates; `llms.txt` lists each language's items.

## Site files

- `/sitemap.xml` with every public URL in every language, walking the complete cursor chain of the list View (the
  recipes example reads one page of 100 per language and marks the paging as `AGENT:` work).
- `/robots.txt` with `Disallow: /admin/` and the sitemap URL.
- `/llms.txt` ([llmstxt.org](https://llmstxt.org)): a title, a one-line summary and a link to each item's Markdown
  alternate.

## A complete site

When the brief names a site, shop, catalogue or blog for visitors, these are part of the work without the user
listing them:

- Every item on this page, for every public page type the site has.
- Accessible, responsive pages with the app's own styling; the examples are unstyled on purpose.
- Content managed in Admin (draft, publish, edit, unpublish) shows on the site without a rebuild. Images go through
  Admin's media library (`mantle help media-r2`); store committed asset IDs and never use an ID as an image URL.
- Members' pages, if any, send anonymous visitors to `/sign-in` (`signInRedirect` in the app shell's `src/sign-in.ts`).
- Who runs the site: an About/contact page and a footer with the business's name, location and contact, and on the
  home page `Organization` (or `LocalBusiness`) JSON-LD with the same facts and the logo. Answer engines use these to
  say whether the site is legitimate. Ask for the facts the brief lacks; never invent an address.
- A favicon, and `og:image` on the home and list pages too.
- A detail page leads to the action the brief sells (order, register, book), saying when it needs an account.
- A cache policy: `Last-Modified` (from the row's `updated_at`) or an `ETag` on pages, `.md`, sitemap and `llms.txt`,
  so crawlers can revalidate; `no-store` everywhere is safe but makes every crawl a full fetch.
- Structured data and answer blocks state only what the page shows. Never promise ranking or AI citation.

## Check before you report done

Request each page without running JavaScript (plain `fetch` in `smoke.mjs`; `mantle help local-testing`) and assert:

1. HTML content type and the visible content; `<title>`, description, canonical on `PUBLIC_ORIGIN`, Open Graph; on
   detail pages JSON-LD that parses with the visible name, and the answer block.
2. Each `.md` alternate returns `text/markdown` with the current text.
3. Walk the list View's complete cursor chain: its rows equal the `llms.txt` entries and the sitemap's detail URLs
   (below the generated `web()` caps: 5,000 rows for `llms.txt`, 50,000 for the sitemap). `/robots.txt` names the
   sitemap.
4. An unknown URL, a malformed path, a draft and a row the visitor may not read are 404, also with an admin session.
5. Publish, edit and unpublish an item through Admin's API (or the Procedure Admin uses); after each, its page,
   `.md`, sitemap and `llms.txt` follow.
6. Stored text with `<`, `&` and `</script>` renders escaped in HTML and inside JSON-LD.

Report a check you could not run (for example a production origin you do not have) as UNVERIFIED with the reason.
Then run [independent acceptance](agent-workflow-acceptance.md) with a visitor evaluator in a browser on the
`pnpm accept` URL.
