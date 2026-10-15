# Public pages: SEO, AEO and languages

This page is the one list of what a public (anonymous, indexable) page emits. Skills, examples and other pages link
here instead of repeating it.

## Two ways to serve them

- **Generated `web()`**: list and detail pages straight from public Views, with `llms.txt`, sitemap, Markdown
  alternates and canonical tags. Its contract and limits are in [surface contracts](../reference/surface.md#optional-web-output);
  the smallest example is `docs/examples/generated-web`.
- **App-owned pages** in `src/routes.ts`, when the page needs its own layout, JSON-LD or languages. The reference
  implementation is `docs/examples/recipes` (`src/pages.ts`, `src/routes.ts`; `smoke.mjs` checks every item below).

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
  there is one (some rich results require it). Escape `<` in the serialized JSON so stored text cannot close the
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

## Check before you report done

Request the HTML without running JavaScript and check the items above; publish, edit and unpublish an item and check
that its page, Markdown, sitemap and `llms.txt` follow. The `mantle` skill's
`references/local-testing.md` covers running this against `wrangler dev`.
