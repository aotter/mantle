---
description: Opt a Worker into public HTML, Markdown mirrors, llms.txt and sitemap with mountPublicRoutes, templates and a path resolver.
---
# Public web, SEO and cache

Public rendering is opt-in. A headless Worker serves Views and Triggers only; this page shows how to add server-rendered pages, their agent-readable mirrors and discovery files, and what the cache contract guarantees.

## Three inputs that must agree

1. `mountPublicRoutes(app, ref, { collectionRoutes, ... })` inside `extend.mount` declares which collections have URLs.
2. A `TemplateRegistry` with an entry template (and optionally a list template) for each of those collections, passed as `templates`.
3. A `PublicPathResolver` from `createPublicPathResolver({ collectionRoutes })`, passed as `publicPathResolver`, so canonical URLs, sitemap entries and hreflang siblings match the mounted routes.

Mounting every Schema automatically is not supported: some collections are private even when they carry a slug. Without a `publicPathResolver`, `/sitemap.xml` returns `500`.

## Worked example: a blog

```ts
// src/web/templates.ts
import { createPublicPathResolver, TemplateRegistry, renderSeoTagsHtml } from "@aotter/mantle-web";

export const publicPathResolver = createPublicPathResolver({
  collectionRoutes: { posts: { segment: "posts" } },
});

export const collectionRoutes = [
  { collection: "posts", segment: "posts", listRoute: true },
] as const;

export function createBlogTemplates(): TemplateRegistry {
  const templates = new TemplateRegistry();

  templates.registerEntryTemplate("posts", ({ entry, site, seo }) => {
    const title = String(entry.data.title ?? site.title);
    const meta = seo && {
      ...seo,
      jsonLd: { "@context": "https://schema.org", "@type": "BlogPosting", headline: title, url: seo.canonical },
    };
    return `<html lang="${entry.locale ?? "en"}"><head><title>${escape(title)}</title>
      ${meta ? renderSeoTagsHtml(meta) : ""}<link rel="stylesheet" href="/blog.css"></head>
      <body><article><h1>${escape(title)}</h1>
      ${seo?.alternateMarkdown ? `<a href="${seo.alternateMarkdown}">Read as Markdown</a>` : ""}
      ${renderMarkdown(String(entry.data.body ?? ""))}</article></body></html>`;
  });

  templates.registerListTemplate("posts", ({ entries, locale, site, seo }) => {
    const items = entries.map((entry) => {
      const href = publicPathResolver.forEntry(entry) ?? `/${locale}/posts/${entry.id}`;
      return `<li><a href="${href}">${escape(String(entry.data.title ?? entry.id))}</a></li>`;
    }).join("");
    return `<html lang="${locale}"><head><title>Blog · ${escape(site.brand)}</title>
      ${seo ? renderSeoTagsHtml(seo) : ""}</head><body><ul>${items}</ul></body></html>`;
  });

  return templates;
}
```

```ts
// worker entry
export default createMantleWorker<Env>({
  plan,
  templates: createBlogTemplates(),
  publicPathResolver,
  siteDefaults: (env) => ({ /* ... */ origin: env.PUBLIC_ORIGIN, locales: ["en", "zh-TW"] }),
  extend: ({ env }) => ({
    mount({ app, ref }) {
      mountPublicRoutes(app as never, ref, {
        collectionRoutes: [...collectionRoutes],
        notFoundRenderer: async () => htmlNotFound(),
        liveDev: new URL(env.PUBLIC_ORIGIN).hostname === "localhost",
      });
    },
  }),
});
```

Templates return complete HTML strings; the renderer prepends the doctype. Escape every value you interpolate.

## Template signatures

```ts
templates.registerEntryTemplate(collection, ({ entry, site, mediaAssets?, seo? }) => string);
templates.registerListTemplate(collection, ({ collection, locale, entries, site, mediaAssets?, seo? }) => string);
```

`seo` is a composed `SeoMeta`:

| Field | Content |
|---|---|
| `canonical` | Absolute canonical URL from `site.origin` and the resolved path |
| `alternateMarkdown` | Absolute `.md` mirror URL, or `null` when the entry has no Markdown body |
| `hreflangs` | One row per locale plus `x-default` on multi-locale sites |
| `description`, `og`, `twitter` | Description, Open Graph and Twitter card blocks |
| `jsonLd` | A default object; replace it before rendering, as the example does |

`renderSeoTagsHtml(seo)` emits the corresponding tags. Entry pages also get `<link rel="alternate" type="text/markdown">` so crawlers and agents can fetch clean Markdown.

## Routes produced

| Route | Condition |
|---|---|
| `GET /` → `302` to `/<canonicalLocale>` | `homeRenderer` set |
| `GET /:locale`, `GET /:locale.md` | `homeRenderer` set; body from `homeMarkdown` or the `homeSlug` entry |
| `GET /:locale/<segment>`, `GET /:locale/<segment>.md` | `listRoute: true` |
| `GET /:locale/<segment>/:slug` | always |
| `GET /:locale/<segment>/:slug.md` | `markdownMirror` not `false` (default on) |
| `GET /:locale/<segment>/:slug?preview=1` | staff session; renders live, `private, no-store` |
| `GET /llms.txt`, `GET /:locale/llms.txt` | always |
| `GET /sitemap.xml` | always; a urlset, or a sitemap index linking `/sitemap.xml?part=1&cursor=...` parts |
| `GET /robots.txt` | always; `Allow: /` plus the sitemap URL |

`CollectionRouteConfig` fields: `collection`, `segment` (empty string mounts entries directly under `/:locale/`), `listRoute` (default `false`), `markdownMirror` (default `true`), `homeSlug` (collapse one slug to `/:locale`). `slugOverrides` serve one `(collection, slug)` pair from your own renderer and take precedence over preview and standard rendering. `notFoundRenderer` is required; every miss falls through it. `liveDev` switches entry and list responses to `private, no-store` for local work.

Only entries with `status: published` render. Drafts never appear on pages, mirrors, `llms.txt` or the sitemap; preview needs a staff session and answers `401` or `403` otherwise.

## Pagination

Lists and `llms.txt` return 50 entries per page, ordered `updatedAt DESC, id DESC`, with a forward `cursor`. A continuation adds `Link: <...?cursor=...>; rel="next"`; HTML lists also get a visible `<nav aria-label="Pagination">` Next link, and `llms.txt` appends a `## Continue` section. Sitemap parts hold up to 2,000 URLs divided by the locale count. See [Views](../concepts/views.md) for View-level paging.

## Cache contract

Public responses carry `Cache-Control: public, max-age=0, s-maxage=300` and `Cache-Tag: mantle-public`. The facade's final policy keeps that only for anonymous `200` `GET`/`HEAD` responses with no request `Cookie` or `Authorization` and no `Set-Cookie`, and adds `Vary: Cookie, Authorization`. Everything else becomes `private, no-store`, and CDN override headers are removed.

Publishing-content and site-setting writes purge the `mantle-public` tag through the native Workers cache API. Operational records and static assets are outside that boundary. Enable the cache with `"cache": { "enabled": true }`; see [Bindings](./bindings.md#workers-cache).

> **Warning**
> The local emulator does not simulate the entrypoint Workers Cache or its purge API. Verify `cf-cache-status` and post-publish invalidation on a deployed environment, not with `wrangler dev`.

## Static assets for templates

Reference CSS, JS and icons by root path (`/blog.css`, `/site-icon.svg`); the `ASSETS` binding serves them from `public/`. Keep public content prefixes in `run_worker_first` so a static file never shadows a rendered route, and leave asset paths out of it so they bypass the Worker.

## Source
- [`packages/adapters/cloudflare/src/mount/mountPublicRoutes.ts`](../../../packages/adapters/cloudflare/src/mount/mountPublicRoutes.ts)
- [`packages/adapters/cloudflare/src/oauth/cachePolicy.ts`](../../../packages/adapters/cloudflare/src/oauth/cachePolicy.ts)
- [`packages/adapters/cloudflare/src/worker/createMantleWorker.ts`](../../../packages/adapters/cloudflare/src/worker/createMantleWorker.ts)
- [`packages/mantle-web/README.md`](../../../packages/mantle-web/README.md)
- [`packages/mantle-web/src/model/TemplateRegistry.ts`](../../../packages/mantle-web/src/model/TemplateRegistry.ts)
- [`packages/mantle-web/src/model/SeoMeta.ts`](../../../packages/mantle-web/src/model/SeoMeta.ts)
- [`packages/mantle-web/src/service/SeoMetaComposer.ts`](../../../packages/mantle-web/src/service/SeoMetaComposer.ts)
- [`packages/mantle-web/src/service/PublicPathResolver.ts`](../../../packages/mantle-web/src/service/PublicPathResolver.ts)
- [`docs/adapter-guide.md`](../../../docs/adapter-guide.md)
- [`docs/performance-harness.md`](../../../docs/performance-harness.md)
