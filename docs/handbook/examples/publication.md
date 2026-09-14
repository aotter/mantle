---
description: Localized blog posts with a stable parent identity, a public per-locale list and an optional reader suggestion box.
---
# Publication: localized posts with a public list

This example publishes posts in several languages, serves a public list per locale, and accepts reader suggestions. It is fully declarative: no handler code is needed. Read it if you run a blog, a news section or any authored, translated content.

## Problem

Editors draft posts in one or more locales, review them in Admin, and publish each language version independently. Every language version of a post shares one stable identity (its slug) so the site can link translations together and Admin can show translation completeness. Visitors read a per-locale list of published posts, newest first, over REST and public MCP. Readers may suggest topics; those suggestions are live records staff read in Admin, not content that is published.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: posts
spec:
  title: Posts
  description: Stable post identities shared by every language version.
  localized: false
  lifecycle: publishing
  uniqueIndexes:
    - [slug]
  schema:
    type: object
    required: [slug]
    properties:
      slug: { type: string, pattern: "^[a-z0-9-]+$" }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: post-translations
spec:
  title: Post translations
  description: Localized titles and bodies for each post.
  localized: true
  translates:
    parent: posts
    on: slug
  lifecycle: publishing
  uniqueIndexes:
    - [slug, locale]
  indexes:
    - [locale, publishedAt]
  schema:
    type: object
    required: [slug, locale, title, publishedAt]
    properties:
      slug: { type: string, pattern: "^[a-z0-9-]+$" }
      locale: { type: string }
      title: { type: string }
      excerpt: { type: string }
      body: { type: string, x-mcp-hint: markdown }
      publishedAt: { type: number, x-mcp-hint: timestamp-ms }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: published-posts
spec:
  title: Published posts
  surface: public
  from: post-translations
  params:
    type: object
    additionalProperties: false
    required: [locale]
    properties:
      locale: { type: string }
  fields: [id, slug, locale, title, excerpt, body, publishedAt, updatedAt]
  filter:
    and:
      - eq: { field: status, value: published }
      - eq: { field: locale, value: { $param: locale } }
      - gte: { field: publishedAt, value: 0 }
  orderBy:
    - { field: publishedAt, direction: desc }
  limit: 50
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: post-suggestions
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
      createdAt: { type: integer, x-mcp-hint: timestamp-ms, x-mantle-bind: now }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: submit-post-suggestion
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
  handler: { kind: builtin, op: create, schema: post-suggestions }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: submit-post-suggestion-http
spec:
  source: { kind: http, method: POST, path: /api/post-suggestions }
  target: { procedure: submit-post-suggestion }
```

How the pieces fit:

- `posts` is the non-localized parent. It holds only what every language shares; here that is the slug.
- `post-translations` is the localized child. `translates: { parent: posts, on: slug }` requires `localized: true`, at least one content field besides `slug` and `locale`, and a parent that exists and is not itself localized. Admin renders the child as locale tabs inside the parent's editor.
- `published-posts` takes a required `locale` parameter. `{ $param: locale }` must name a property in `params.properties` that is also in `params.required`. The `gte publishedAt 0` clause keeps the filter aligned with the declared `[locale, publishedAt]` index; confirm the plan with `mantle-harness indexes`.
- Site locales must be configured. A localized Schema with zero `siteDefaults.locales` fails at boot with `SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES`, and a write whose `locale` is not in the site list fails with `INPUT_VALIDATION_FAILED`.

See [Lifecycle and locales](../concepts/lifecycle-and-locales.md) and the [Schema reference](../reference/schema.md).

## Worker and handlers

There are none. Every Procedure here is `builtin`, and Views need no Trigger. The Worker is the minimal one:

```ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

export default createMantleWorker({ plan });
```

### Rendering

Public HTML pages are optional and separate from the data contract. If you want `/en/posts/<slug>` rendered by the Worker, register a template for the translations collection and pass it to `createMantleWorker({ templates, publicPathResolver })`. A trimmed entry template:

```ts
import { TemplateRegistry } from "@aotter/mantle/web";
import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: true });

export function createTemplates(): TemplateRegistry {
  const templates = new TemplateRegistry();
  templates.registerEntryTemplate("post-translations", ({ entry, site, seo }) => {
    const title = typeof entry.data.title === "string" ? entry.data.title : site.title;
    const body = typeof entry.data.body === "string" ? entry.data.body : "";
    return `<html lang="${entry.locale ?? "en"}"><head><title>${escapeHtml(title)}</title></head>
<body><main><h1>${escapeHtml(title)}</h1><div>${markdown.render(body)}</div></main></body></html>`;
  });
  return templates;
}
```

The template receives `{ entry, site, seo, mediaAssets }` and returns a complete HTML string. Escape every field you interpolate; `body` is rendered from Markdown because the Schema marks it `x-mcp-hint: markdown`. Paths, Markdown mirrors, `llms.txt`, sitemap and cache headers are covered in [Public web, SEO and cache](../cloudflare/public-web.md).

### The single-Schema alternative

The simpler alternative is one localized `posts` Schema with `uniqueIndexes: [[slug, locale]]` and no parent. Each locale row is an independent record; nothing is shared except the slug convention. Choose that shape when translations do not need shared fields or Admin translation grouping. Choose the parent/child shape above when several locale rows are versions of one entity and editors need to see which languages are missing. Both shapes serve the same `published-posts` View contract.

## Try it

Public list for one locale:

```sh
curl -sS 'http://localhost:8787/api/views/published-posts?locale=en&show=10'
```

```json
{
  "ok": true,
  "data": {
    "rows": [
      {
        "id": "tr_01j...",
        "slug": "hello-world",
        "locale": "en",
        "title": "Hello, world",
        "excerpt": "First post.",
        "body": "# Hello\n\nFirst post.",
        "publishedAt": 1788879363492,
        "updatedAt": 1788879400000
      }
    ],
    "page": 1,
    "show": 10,
    "hasMore": false
  }
}
```

Omitting `locale` returns HTTP 400 `INPUT_VALIDATION_FAILED`. `show` is capped at the View's `limit` (50); `hasMore` is `rows.length === show`. Public responses carry `Cache-Control: public, max-age=0, s-maxage=300` and `Cache-Tag: mantle-public`, and are purged when publishing content changes.

Submit a suggestion:

```sh
curl -sS -X POST http://localhost:8787/api/post-suggestions \
  -H 'content-type: application/json' \
  -d '{"title":"Write about indexes","email":"reader@example.test"}'
```

The response is `{ ok: true, data: <EntryRow> }` with `collection: "post-suggestions"` and `status: "published"`.

MCP tools:

| Surface | Tool | Origin |
|---|---|---|
| `/mcp` | `query_view_published_posts` (arguments `locale`, `page`, `show`) | public View |
| `/mcp/staff` | `create_draft_posts`, `update_draft_posts` | publishing Schema `posts` |
| `/mcp/staff` | `create_draft_post_translations`, `update_draft_post_translations` | publishing Schema `post-translations` |
| `/mcp/staff` | `create_record_post_suggestions`, `update_record_post_suggestions` | operational Schema `post-suggestions` |
| `/mcp/staff` | `list_entries`, `get_entry`, `request_publish`, `unpublish_entry`, `archive_entry`, `delete_entry` | generic staff tools |

There is no `submit_post_suggestion` tool because no MCP Trigger targets that Procedure. See [MCP and agents](../concepts/mcp-and-agents.md).

## What this deliberately leaves out

- **Comments.** Reader comments would be another operational Schema with its own moderation Procedures.
- **Search.** `searchableFields` powers Admin and Staff MCP substring search only; public full-text search is application code.
- **Scheduling.** `publishedAt` is a display timestamp set by editors. Nothing publishes a draft at that time; publishing remains an explicit `request_publish` or Admin action.

Related: [Intake form](./intake-form.md) hardens the suggestion box with a bot check.

## Source

- [`docs/design-atoms.md`](../../../docs/design-atoms.md) — `localized`, `translates`, param-driven Views
- [`packages/mantle-web/src/model/TemplateRegistry.ts`](../../../packages/mantle-web/src/model/TemplateRegistry.ts) — `registerEntryTemplate` and `EntryContext`
- [`overlays/publication/manifests/site.yaml`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/publication/manifests/site.yaml) — retired parent/child publication pattern
