# Generated public website

A minimal application-owned Cloudflare D1 Worker: an HTML list and detail page,
REST, `llms.txt`, sitemap, Markdown alternates and canonical head tags. It uses the
positional native generator documented by the selected `@aotter/mantle` package
(alpha.7 onwards); earlier Core releases use a different CLI. The frontend has no
runtime dependencies. It renders Markdown as escaped text, preserving the source
for the `.md` alternate.

Copy this directory outside the SDK checkout. In that directory, set
`"type": "module"` in `package.json`, install the exact selected Mantle version
and host tools, then run:

```sh
npm install --save-exact @aotter/mantle@<version>
npm install --save-dev typescript @cloudflare/workers-types wrangler
npx mantle generate cloudflare-d1 generated posts.yaml
npx tsc --noEmit
git init
git add generated src/worker.ts wrangler.jsonc
git commit -m "Generate native website contracts"
npx wrangler d1 execute mantle-generated-web --local --file generated/schema.sql
npx wrangler d1 execute mantle-generated-web --local --file seed.sql
npx wrangler dev --local
```

Keep generated TypeScript, `schema.sql` and the configured Wrangler file in
version control. The workflow is generate → typecheck → implement any listed ref
handlers → typecheck → commit generated output. This manifest has no ref handlers.
For alpha.7 after the service-composition work lands, CI runs
`mantle generate cloudflare-d1 generated posts.yaml --check` to refuse stale or
missing generated files without writing them. Earlier linked generators do not
yet support `--check`; use the installed version's documented commands. `dist/`
and local Wrangler state stay ignored.

For a linked pre-release SDK, use its installed `mantle` CLI instead of installing
an unpublished version. Generation adds Wrangler's split build automatically.
The seed is local test data; never apply it to an existing production database.
For deployment, set the real D1 binding and `PUBLIC_ORIGIN` to the public origin.
The app passes a verified anonymous Caller for this public-only site; an
application with sign-in resolves its Caller once and supplies it to each entry.

Open `/`, `/posts/hello`, `/posts/hello.md`, `/api/views/posts`, `/llms.txt` and
`/sitemap.xml`. The list pages with an opaque cursor; the detail reads the Store,
which enforces publication in SQL. `site.head()` reads the declared public View
and supplies canonical and Markdown alternate tags, even when the request host
differs from `PUBLIC_ORIGIN`. Both HTML pages have Markdown alternates (`/.md`
for the index) and a canonical. REST and web fall through to the HTML renderer.

Acceptance:

- Walk every `/api/views/posts` cursor: its rows must match the `llms.txt` detail
  links and sitemap detail URLs below the documented index caps.
- Each HTML page includes `rel="canonical"` and a `type="text/markdown"`
  alternate whose GET returns its current source. The index canonical is `/`.
- `/posts/draft` and `/posts/draft.md` return 404; the draft is absent from REST,
  HTML links, `llms.txt` and sitemap. HTML source escapes the fixture's `<world>`.
- Malformed/foreign list cursors return structured 400 errors with `no-store`.
- HTML HEAD has no body. Unknown pages return 404 with `no-store`.

HTML detail performs two native reads: one Store read for the body, then one
public View read in `site.head()`. The index likewise performs two reads (list
and home head). The current head API accepts no preloaded row; there is no
request cache or extra authentication lookup in this public example. Markdown
may perform two View reads when checking an exact `.md` page before its alternate.

Web indexes have deliberate ceilings: 5,000 scanned rows, 10 queries and 1 MiB
for `llms.txt`; 50,000 rows, 100 queries and 50 MiB for a sitemap. Small SQL LIMITs
can truncate sooner. Translation-aware web indexes/hreflang remain a separate
follow-up; `locales[0]` supplies the currently supported locale alternate.

The SDK runs this exact Worker against a native SQLite database in
`tests/web-example.test.ts` and bundles/typechecks its D1 form. No measurement
scripts or benchmark data are part of the example.
