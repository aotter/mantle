# Generated public website

A minimal application with Cloudflare D1 and Bun SQLite entries: an HTML list and detail page,
REST, `llms.txt`, sitemap, Markdown alternates and canonical head tags. It uses the
positional native generator documented by the installed `@aotter/mantle` version.
The frontend has no runtime dependencies. It renders Markdown as escaped text,
preserving the source for the `.md` alternate.

Use a separate copy of this directory for each host. Each generation target writes
its own `generated/` tree for the same `src/app.ts`. In the Workers copy, set
`"type": "module"` in `package.json`, install the exact selected Mantle version
and host tools, then run:

```sh
npm install --save-exact @aotter/mantle@<version>
npm install --save-dev typescript @cloudflare/workers-types wrangler
npx mantle generate cloudflare-d1 generated posts.yaml
npx tsc --noEmit
git init
git add generated src public wrangler.jsonc posts.yaml seed.sql package.json package-lock.json tsconfig.json
git commit -m "Generate native website contracts"
npx wrangler d1 execute mantle-generated-web --local --file generated/schema.sql
npx wrangler d1 execute mantle-generated-web --local --file seed.sql
npx wrangler dev --local
```

Use the latest stable Bun 1.4 or newer. The example was verified with Bun 1.4.5.
In the Bun copy, set `"type": "module"` in `package.json` and run:

```sh
npm install --save-exact @aotter/mantle@<version>
npm install --save-dev typescript "bun-types@$(bun --version)"
npx mantle generate bun-sqlite generated posts.yaml --entry bun/server.ts
npx tsc -p tsconfig.bun.json
bun -e 'import { Database } from "bun:sqlite"; import { readFileSync } from "node:fs"; const db = new Database("posts.sqlite", { create: true }); for (const file of ["generated/schema.sql", "seed.sql"]) db.exec(readFileSync(file, "utf8").trim()); db.close();'
bun bun/server.ts
```

Initialize a fresh `posts.sqlite` once. The Bun server opens it read-only, reuses
one handle, and listens on loopback port 3000 by default. Set `PORT`, `SQLITE_PATH`
or `PUBLIC_ORIGIN` to override the defaults. `/health` and `/assets/posts.svg`
use Bun's native `routes`; dynamic requests go through `fetch` to the same app
used on Workers. The Worker handles `/health` before calling the app, and Workers
Static Assets serves the SVG without calling the Worker.

Keep generated TypeScript, `schema.sql` and the configured Wrangler file in
version control. The workflow is generate → typecheck → implement any listed ref
handlers → typecheck → commit generated output. This manifest has no ref handlers.
Use the installed version's documented commands. CI runs
`mantle generate cloudflare-d1 generated posts.yaml --check` to refuse stale or
missing generated files without writing them. `dist/`
and local Wrangler state stay ignored.

For a linked pre-release SDK, use its installed `mantle` CLI instead of installing
an unpublished version. Generation adds Wrangler's split build automatically.
The seed is local test data; never apply it to an existing production database.
For deployment, set the real D1 binding and `PUBLIC_ORIGIN` to the public origin.
The app passes a verified anonymous Caller for this public-only site; an
application with sign-in resolves its Caller once and supplies it to each entry.

On either host, open `/`, `/posts/hello`, `/posts/hello.md`, `/api/views/posts`, `/llms.txt` and
`/sitemap.xml`. The list pages with an opaque cursor; the detail reads the Store,
which enforces publication in SQL. `site.head()` reads the declared public View
and supplies canonical and Markdown alternate tags, even when the request host
differs from `PUBLIC_ORIGIN`. Both HTML pages have Markdown alternates (`/.md`
for the index) and a canonical. REST and web fall through to the HTML renderer.

Acceptance:

- Walk every `/api/views/posts` cursor: its rows must match the `llms.txt` detail
  links and sitemap detail URLs below the documented index caps. The sitemap also
  lists `/`, from the `sitemap` option.
- Each HTML page includes `rel="canonical"` and a `type="text/markdown"`
  alternate whose GET returns its current source. The index canonical is `/`.
- `/posts/draft` and `/posts/draft.md` return 404; the draft is absent from REST,
  HTML links, `llms.txt` and sitemap. HTML source escapes the fixture's `<world>`.
- Malformed/foreign list cursors return structured 400 errors with `no-store`.
- HTML HEAD has no body. Unknown pages return 404 with `no-store`.

Ordinary HTML detail performs two native reads: one Store read for the body, then one
public View read in `site.head()`. The index likewise performs two reads (list
and home head). `site.head(request, env, ctx, { row })` would skip
that View read; this example keeps it. There is no request cache or extra
authentication lookup in this public example. IDs ending
in `.md` need one additional exact-page probe before HTML rendering (three reads
total). Markdown may perform two View reads when checking an exact `.md` page
before its alternate.

Web indexes have deliberate ceilings: 5,000 scanned rows, 10 queries and 1 MiB
for `llms.txt`; 50,000 rows, 100 queries and 50 MiB for a sitemap. An authored SQL `LIMIT 3` means at most three rows in the entire index,
not three rows per query. Omit SQL LIMIT to enumerate the whole authorized
result up to these web ceilings. The renderer requests pages of up to 500
through generated paging options; transport page size does not expand the
authored result set. Migration: remove LIMIT only when it was mistakenly
being used as a page-size setting; retain a business-defined top-N limit. Translation-aware web indexes remain a separate
follow-up; an hreflang alternate is emitted only when exactly one locale is configured.

The SDK exercises the exact Bun entry over HTTP in `tests/web-example.test.ts`
and bundles and typechecks the D1 entry.

## Measure HTTP request cost

With [k6](https://grafana.com/docs/k6/latest/get-started/installation/) and a running copy:

```sh
k6 run -e ORIGIN=http://127.0.0.1:3000 -e CASE=health -e RATE=1000 bench.k6.js
```

Repeat with `CASE=asset`, `CASE=rest-miss` or `CASE=view`. The REST miss deliberately
expects a 404 under `/api` to exercise the Mantle router without touching a database.
The View reads the same seed data. Rerun Bun with `bun bun/server.ts --fetch-only`
to serve the same fixed responses through the fallback instead of native routes.
For Workers, use port 8787 for a local comparison or an authorized deployment
for real-edge measurements. The asset traffic on Workers does not invoke the app.

Set each offered `RATE` in advance and alternate baseline and candidate at that
rate. Compare `successful_requests`, `response_latency` p99, `unexpected_responses`
and `dropped_iterations`. The custom metrics exclude the setup requests.
Increase `VUS` if the load generator cannot sustain the requested rate. Record
runtime versions, host and database, whether asset caching is warm, and which
requests touched the Worker. For CPU, sample the Bun server process during the
timed phase and use Workers invocation CPU logs for a deployed Worker. Local
workerd CPU measures the local process, including the D1 emulator. Keep that
separate from Cloudflare's production CPU and network measurements.
