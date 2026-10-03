---
description: Localized posts with a stable parent identity, a public per-locale list, public full-text search and a reader suggestion box.
---
# Publication: localized posts with a public list

[Examples hub](./README.md)

Posts in several languages, a public list per locale, public search, and
reader suggestions. Every Procedure is SQL; editors draft and publish through
Admin.

## Problem

Editors draft posts in one or more locales and publish each language version
on its own. Every language version shares one stable identity, its slug, so
the site can link translations and Admin can group them. Visitors read a
per-locale list of published posts, newest first, and search them. Readers may
suggest topics; suggestions are records staff read, never published.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  description: Stable post identities shared by every language version.
  lifecycle: publishing
  uniqueIndexes: [[slug]]
  schema:
    type: object
    required: [slug]
    properties:
      slug: { type: string, maxLength: 120, pattern: "^[a-z0-9-]+$" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: post-translations }
spec:
  title: Post translations
  description: Localized titles and bodies for each post.
  localized: true
  translates: { parent: posts, on: slug }
  lifecycle: publishing
  uniqueIndexes: [[slug, locale]]
  indexes: [[locale, publishedAt]]
  searchableFields: [title, excerpt, body]
  schema:
    type: object
    required: [slug, locale, title, publishedAt]
    properties:
      slug: { type: string, maxLength: 120, pattern: "^[a-z0-9-]+$" }
      locale: { type: string }
      title: { type: string }
      excerpt: { type: string }
      body: { type: string, x-mcp-hint: markdown }
      publishedAt: { type: string, format: date-time }
---
# Public Views over publishing Schemas see published rows only.
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: published-posts }
spec:
  title: Published posts
  description: Published posts in one locale, newest first.
  surface: public
  input:
    type: object
    additionalProperties: false
    required: [locale]
    properties:
      locale: { type: string }
  sql: |
    SELECT id, slug, locale, title, excerpt, publishedAt, updated_at
    FROM "post-translations"
    WHERE locale = input.locale
    ORDER BY publishedAt DESC LIMIT 50
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: search-posts }
spec:
  title: Search posts
  description: Full-text search over published posts in one locale.
  surface: public
  input:
    type: object
    additionalProperties: false
    required: [locale, q]
    properties:
      locale: { type: string }
      q: { type: string, minLength: 1 }
  sql: |
    SELECT t.id, t.slug, t.title, t.excerpt FROM "post-translations" t
    WHERE t.locale = input.locale AND mantle.search(t, input.q)
    ORDER BY mantle.search_rank(t), t.id
    LIMIT 20
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: post-suggestions }
spec:
  title: Post suggestions
  description: Reader suggestions for future posts.
  lifecycle: operational
  schema:
    type: object
    required: [title, email]
    properties:
      title: { type: string }
      email: { type: string, format: email }
      note: { type: string }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: submit-post-suggestion }
spec:
  input:
    type: object
    additionalProperties: false
    required: [title, email]
    properties:
      title: { type: string }
      email: { type: string, format: email }
      note: { type: string }
  output: { type: object }
  handler:
    sql: |
      INSERT INTO "post-suggestions" (title, email, note)
      VALUES (input.title, input.email, input.note)
      RETURNING id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: submit-post-suggestion-http }
spec:
  source: { kind: http, method: POST, path: /api/post-suggestions }
  target: { procedure: submit-post-suggestion }
```

How the pieces fit:

- **`posts` is the parent** and holds only what every language shares: the
  slug.
- **`post-translations` is the localized child.** `translates: { parent: posts,
  on: slug }` needs `localized: true`, at least one content field besides
  `slug` and `locale`, and a parent that exists and is not itself localized.
  Admin uses it to group translations under their post.
- **`locale` is a plain field in 0.2.0.** `localized` is presentation
  metadata: Store does not check a row's `locale` against the site's locales.
  Validate it in the Procedure or guard that writes it if it matters.
- **Published-only is injected.** Both public Views read a `publishing`
  Schema, so drafts and archived rows never appear, and the SQL does not test
  `status`.
- **Search is `mantle.search`** over `searchableFields`, a trigram full-text
  index, so a three-character Chinese substring matches. A shorter query falls
  back to a scan. `mantle.search_rank` orders by relevance; the trailing `t.id`
  is the tiebreak a cursor needs. `publishedAt` is a display time set by
  editors; nothing publishes a draft at that time.

### The single-Schema alternative

One localized `posts` Schema with `uniqueIndexes: [[slug, locale]]` and no
parent also works: each locale row is independent, and only the slug
convention links them. Choose it when translations share no fields and editors
do not need to see which languages are missing. Both shapes serve the same
`published-posts` View.

## Handlers

None.

## Rendering

0.2.0 has no Mantle-rendered public pages; `createWebSurface` is not ported.
Render `/en/posts/<slug>` from the service's own `fetch` (or any frontend) over
the REST View, escape every field, and render `body` from Markdown with HTML
disabled.

## Try it

```sh
curl -sS 'http://127.0.0.1:8787/api/views/published-posts?locale=en&limit=10'
curl -sS 'http://127.0.0.1:8787/api/views/search-posts?locale=en&q=index'
curl -sS -X POST http://127.0.0.1:8787/api/post-suggestions \
  -H 'content-type: application/json' \
  -d '{"title":"Write about indexes","email":"reader@example.test"}'
```

A View answers `{ "rows": [...], "nextCursor": "…" }`; pass `cursor` back for
the next page. Leaving out `locale` is HTTP 400 `INPUT_VALIDATION_FAILED`.

| MCP surface | Tool | From |
|---|---|---|
| `/mcp` | `published_posts`, `search_posts` (plus `limit` and `cursor`) | the public Views |

There is no `submit_post_suggestion` tool, because no MCP Trigger targets that
Procedure. Editors write posts through Admin's API, not through generated
record tools.

## What this leaves out

- **Comments.** Another operational Schema with its own moderation Procedures.
- **Scheduled publishing.** A schedule Trigger whose `ref` handler sets
  `status` with `ctx.store.write` could do it; SQL cannot set `status`.

## Source

- [Schema reference](../handbook/reference/schema.md) and [View reference](../handbook/reference/view.md): `localized`, `translates`, `searchableFields`, `input`
- [Lifecycle and locales](../handbook/concepts/lifecycle-and-locales.md)
