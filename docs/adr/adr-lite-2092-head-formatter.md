# ADR-lite: Head tags for application-owned pages (formatter withdrawn before release)

**Status:** Accepted, issue #2092; the formatter it added was withdrawn before release on 2026-11-20 (#2102). What
stands is decision 1: `head()` accepts the application's row. `@aotter/mantle/web` adds no export, subpath, grammar or
`web()` page option.

## Context

In 0.1, `@aotter/mantle-web` composed public HTML inside the package, head tags included, from the manifest's content
model ([ADR-0019](0019-sealed-manifest-runtime-pipeline.md)). In 0.2 the generated `web()` serves `llms.txt`, the
sitemap, Markdown alternates and a few head tags for public Views, and renders no HTML: pages are the application's
([ADR-0040](0040-thin-native-toolkit.md)). Every application-owned public page still needs a full head: title,
description, canonical, language alternates with `x-default`, Open Graph, a Twitter card and JSON-LD
([public pages](../handbook/guides/public-pages.md)).

## Decision

1. **`head()` accepts the application's row.** `head(request, env, ctx, { row })` formats the tags from the row the
   application already read and runs no View read, caller resolution, `authorize` or gateway decision (#2087). The
   trust boundary does not move: nothing is read on the caller's behalf, and the tags are derived only from values the
   application holds and chose to render. Deciding who may see that row was the application's read. With `page` given
   and no row, `head` returns no tags; it never falls back to a read of its own.
2. **Withdrawn: a string formatter.** #2093 added `pageHead(options): string` to `@aotter/mantle/web`, a pure formatter
   of the full head from values the application passes. It was removed before any release (#2102): the recommended
   page shape writes the head in JSX, so the formatter had no consumer. It
   was never published, so its removal needs no stub or migration.

## Why not port the composer into `web()`

`web()`'s page config would then name the content model: which column is the title, the description, the image, which
schema.org type a page is and how its fields map. That is the 0.1 composer again, with Core owning decisions ADR-0040
gives to the application, a growing option surface for every schema.org type, and a second place where the shape of
a page is described. The mapping stays in the application's code, next to the HTML that shows the same values, which
is also what the public-pages checklist asks: structured data states only what the page shows.

## Consequences

- The generated `web()` keeps its page options, and its `head()` gains only the optional row (decision 1).
- Per-language hreflang stays the application's: it knows which translations of an item are published. `web()`'s own
  head emits an hreflang only for a single configured locale (#2087).
