# ADR-lite: A head formatter for application-owned pages

**Status:** Accepted, issue #2092. Adds `pageHead` to the existing `@aotter/mantle/web` subpath; adds no subpath, no
grammar and no `web()` page option.

## Context

In 0.1, `@aotter/mantle-web` composed public HTML inside the package, head tags included, from the manifest's content
model ([ADR-0019](0019-sealed-manifest-runtime-pipeline.md)). In 0.2 the generated `web()` serves `llms.txt`, the
sitemap, Markdown alternates and a few head tags for public Views, and renders no HTML: pages are the application's
([ADR-0040](0040-thin-native-toolkit.md)).

Every application-owned public page still needs the same head: title, description, canonical, Markdown and language
alternates with `x-default`, Open Graph (with `og:locale` in underscore form), a Twitter card and JSON-LD
([public pages](../handbook/guides/public-pages.md)). Three consumers write it by hand — the recipes example
(`docs/examples/recipes/src/pages.ts`), the revisions guide and an external application — and each repeats HTML
escaping, the Open Graph pairs, the hreflang list and JSON-LD serialization with `<` escaped. Escaping is the part that
must not drift: one missed attribute or one unescaped `</script>` in stored text is an injection.

## Decision

1. **A pure formatter.** `pageHead(options: PageHeadOptions): string` returns the head tags for one page from values the
   application already has: `title`, `description`, canonical `url`, `image`, `siteName`, `locale`, `type`
   (`website` | `article`), `alternates` (locale → URL), `xDefault`, `markdown` (the alternate's URL) and `jsonLd` (an
   object or array the application built). Core owns escaping and the format; it reads no database and no row.
2. **Omit what is absent.** A null, undefined or empty value emits no tag. `og:type` defaults to `website`; the Twitter
   card is `summary_large_image` with an image, else `summary`. `og:locale:alternate` lists the alternates other than
   `locale`.
3. **JSON-LD is serialized, not built.** `JSON.stringify` with `<` written as `<`, so no stored text can close the
   script element or open a comment; `JSON.parse` of the script body returns the application's value.
4. **Placement.** It is exported from `@aotter/mantle/web` and lives in its own kernel module that imports only the
   shared escape helper. A bundle that imports only `pageHead` contains no `web()` serving code, and `web()`'s startup
   graph does not contain the formatter (both are tested; the Worker startup budget is unchanged).
5. **Registered.** `pageHead` is an application seam (`page-head` in `packages/mantle/tests/application-seams.ts`).

## Why not port the composer into `web()`

`web()`'s page config would then name the content model: which column is the title, the description, the image, which
schema.org type a page is and how its fields map. That is the 0.1 composer again, with Core owning decisions ADR-0040
gives to the application, a growing option surface for every schema.org type, and a second place where the shape of
a page is described. The formatter keeps the mapping in the application's code, next to the HTML that shows the same
values, which is also what the public-pages checklist asks: structured data states only what the page shows.

## Consequences

- An application-owned page writes one call instead of a hand-written head; the generated `web()` and its `head()` are
  unchanged.
- Per-language hreflang stays the application's: it knows which translations of an item are published. `web()`'s own
  head emits an hreflang only for a single configured locale (#2087).
- `og:title` equals `title`. A page whose `<title>` adds the site name and whose `og:title` must not, keeps its own tags.
- The recipes example and the revisions guide keep their hand-written heads for now; migrating them is a follow-up.

## Alternatives

- **`web()` page options for the content model** (`title: 'name'`, `image: 'cover_url'`, `schemaType: 'Recipe'`):
  rejected above.
- **A separate subpath** (`@aotter/mantle/web/head`): not needed. Bundlers drop the unused half of `@aotter/mantle/web`
  in both directions, and a new subpath is one more public key to keep.
- **Documentation only**: the three hand-written copies show it does not keep escaping in one place.
