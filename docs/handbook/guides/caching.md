---
description: "What a cache in front of the Worker stores, the Cache-Control every response states, and how fast a content change shows."
---
# Caching

A Mantle app serves public pages and signed-in answers from one Worker. A cache in front of it may store only what a
response marks public, and every response states its `Cache-Control`. This page says what is cached by default, the
rules an app follows, and what [Workers Cache](https://developers.cloudflare.com/workers/cache/) changes.

## What is cached by default

- **What the Worker builds:** nothing. Cloudflare stores no response a Worker builds unless the Worker opts in to
  Workers Cache. A browser still follows the response's `Cache-Control`.
- **Static assets:** answered by the edge without running the Worker, with `Cache-Control: public, max-age=0,
  must-revalidate` and an ETag, so a browser revalidates each use ([Workers assets](../cloudflare/service-entry.md#workers-assets-and-secrets)).
- **Admin's content-hashed chunks** (`/admin/assets/*`): `public, max-age=86400, immutable` from the `_headers` rule
  `mantle bundle` writes. A day, not a year, because the edge sends the same rule on its 404 for a missing chunk
  ([why](../cloudflare/service-entry.md#workers-assets-and-secrets)).

## Workers Cache

One line in the Wrangler config puts a cache in front of the Worker's `fetch`:

```jsonc
{ "cache": { "enabled": true } }
```

On a hit the Worker does not run: no render, no database connection, no query. A host's gateway in front of the Worker
still runs, and the request is still counted and billed as a request. It caches `GET` and `HEAD` only. It is available
on every plan, Free included, and on `workers.dev` (measured 2026-11-20 on Workers Free). Mantle does not enable it;
an app that does follows the rules below first.

The cache key is the entrypoint, the path and the query, plus the Worker version and `ctx.props`. The hostname is not
in it, `HEAD` and `GET` share an entry, and a deploy starts cold. Static assets pass through the same cache.

## Hazards

Measured 2026-11-20 on Workers Free; each matches
[the configuration docs](https://developers.cloudflare.com/workers/cache/configuration/):

1. **A response without `Cache-Control` is cached.** Freshness is heuristic: 2 hours for a `200` (still a hit after
   1,260 s), 3 minutes for a `404`, 1,200 s for a `301`. An asset path's `404` gets the heuristic TTL too.
2. **`Cookie` is not in the key and does not bypass.** Two requests that differ only in their cookie share one entry:
   a signed-in answer without `private` or `no-store` is served to the next visitor.
3. **`Authorization` bypasses only one way.** A request with `Authorization` is not stored unless the response says
   `public`, `s-maxage` or `must-revalidate`, but an entry stored for an anonymous request is served to a request with
   `Authorization`.
4. **Errors are masked indefinitely.** When the Worker throws or answers `5xx` after an entry expired, the stale copy is
   served without limit unless the response said `stale-if-error=0` or `must-revalidate`.

A response with `Set-Cookie`, `private` or `no-store` bypasses. `Vary` keys on the exact header string, not a
normalised one. `ctx.cache.purge()` and `invalidate()` reach only the calling Worker's entrypoint
([purge](https://developers.cloudflare.com/workers/cache/purge/),
[limitations](https://developers.cloudflare.com/workers/cache/limitations/)).

## Rules

- **Every response states `Cache-Control`.** Hazard 1 stores the rest.
- **Public pages:** `public, max-age=60, stale-while-revalidate=600, stale-if-error=86400`. `max-age=60`: at most one
  render a minute per URL. `stale-while-revalidate=600`: for ten minutes past that a visitor gets the stored copy
  while it refreshes in the background, so nobody waits for a render; staleness stays bounded. `stale-if-error=86400`: a failing Worker is
  masked for a day, not indefinitely (hazard 4).
- **Caller-dependent responses, redirects, 404s and errors:** `no-store` (`private, no-store` for anything built for a
  caller). A 404 cached for a URL stays a 404 after the row is published.
- **Visitor pages read as the anonymous caller**, so the stored page is the same for everyone, signed in or not
  (hazards 2 and 3). Never `public` on a response built for a signed-in caller.
- **No `Vary: Accept` or `Vary: Cookie` on cached HTML.** Exact-string keying makes one entry per browser's header
  string. The Markdown alternate stays at its own URL, `<url>.md`.
- **Host-specific responses** (a redirect to the primary host) are `no-store`: the key has no hostname.
- **Set `stale-if-error` explicitly** on every public response.

`web()`'s default for anonymous callers, `public, max-age=60`, names no `stale-if-error`: pass `cacheControl` when
Workers Cache is on.

## The shell's default

The app shell's `fetchService` (`src/service.ts`) gives a response that states no `Cache-Control` `private, no-store`,
after every route, surface, the 404 and a thrown error. A header a route or `ASSETS` set is kept. The smoke kit fails
a response without one. Core's REST, MCP, web, auth and Admin responses state their own.

An app made by `mantle init` before this owns an older `src/service.ts` without it. Rename its `fetchService` to
`serve` and add:

```ts
export async function fetchService(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const response = await serve(request, env, context);
  // A shared cache in front of the Worker (Workers Cache) stores a response that does not opt out: default to private.
  if (response.status === 101 || response.headers.has("cache-control")) return response;
  const copy = new Response(response.body, response); // a copy: some responses have immutable headers
  copy.headers.set("cache-control", "private, no-store");
  return copy;
}
```

## Freshness after a content change

With the public header above, a change shows within about a minute on a page that is requested often. A page nobody
requested for longer than `max-age` is refreshed by its next visitor, who still gets the stale copy (within the
`stale-while-revalidate` window); the visitor after that sees the change. A deploy starts cold.

To show a change at once, purge from inside the same Worker: `ctx.cache.purge({ tags })` (tags from the response's
`Cache-Tag` header) or `ctx.cache.purge({ pathPrefixes })` deletes entries; `ctx.cache.invalidate()` takes the same
options and marks them stale. Core has no publish hook that calls it, and Admin's edits do not purge
([#1796](https://github.com/aotter/mantle/issues/1796) tracks observing writes). An app route that writes can purge
after its write commits:

```ts
// src/service.ts passes the Worker's cache to the app routes: appRoutes(request, env, { ..., cache: context.cache })
export async function publishPost(request: Request, context: { cache?: CacheContext }, write: () => Promise<{ slug: string }>) {
  const post = await write(); // the app's generated Procedure, committed
  await context.cache?.purge({ pathPrefixes: [`/posts/${post.slug}`] }); // /posts/<slug> and /posts/<slug>.md (and any longer path)
  return Response.json(post, { headers: { "cache-control": "private, no-store" } });
}
```

A ref handler has no `ctx`; `import { cache } from "cloudflare:workers"` reaches the same cache, but the handler runs
before its Procedure commits, so a request in between can store the old page again. Purge after the commit.

## What `web()` does

`web()` serves `.md` alternates, `llms.txt` and `sitemap.xml` with `cacheControl` (default `public, max-age=60`) for an
anonymous caller and `private, no-store` for a signed-in one, a `no-store` 404 and an ETag of the body. It answers
`If-None-Match` with `304` only after it has read the current content, so a revalidation still costs the read. A cache
in front answers a client's `If-None-Match` itself, without running the Worker.

## Measured costs

Render CPU per request, measured 2026-11-20 on Workers Free (method:
[#2102](https://github.com/aotter/mantle/issues/2102)):

| Page | CPU |
| --- | --- |
| String template or app shell | ≤ 2 ms |
| React, plain elements | 1 ms warm; 7–12 ms on the first render in an isolate |
| React with UI kit components | 12–45 ms |

Free's 10 ms CPU limit is a budget, not a cut-off: single requests up to about 1 s of CPU succeeded, about 2 s was
killed, and sustained overage answers `1102`. Hardware and limits are Cloudflare's to change; measure your own pages.
A hit costs no CPU.
