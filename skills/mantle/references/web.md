# Generated public websites

Use this flow only when the installed package README documents concrete native
queries and generated `web.ts`.
Earlier Core versions use their own installed handbook. Read the installed
`docs/handbook/reference/surface.md` and `docs/examples/generated-web/README.md` under `node_modules/@aotter/mantle/` before writing
routes; the installed version is authoritative.

Mount `web()` when the application serves public HTML and needs `llms.txt`, a
sitemap or Markdown alternates. Import the generated `web.ts`; pass the native
`db`, a verified Caller (or the app's resolver), the configured public `origin`,
`title`, `description` and `pages`. Mount generated `rest.ts` for public View and
HTTP Trigger APIs. Neither module renders the application's HTML.

Each page template's `{parameter}` names exactly match its public View inputs;
both its View and list View return these parameters. A list View accepts empty
input. `markdown` names a textual column in the detail View. Supply the same
SQL-visible data to the HTML renderer through generated Views or the typed Store.
Never add a frontend status filter: generated SQL owns publishing, scope and TTL.

In the Fetch entry, return a handled REST/web response, then render HTML for the
remaining page routes. Insert `await site.head(request, env)` inside `<head>`:
it supplies canonical and Markdown alternate tags from the current View row,
using the configured origin rather than the request host. Escape all other
application text. An unavailable page needs an application-owned 404; an empty
`head()` result alone does not render that response.

Verify locally before deploying:

1. Generate, typecheck, implement every listed ref handler and typecheck again.
2. Walk the public list's complete cursor chain. Its rows equal the `llms.txt`
   entries and sitemap detail URLs below the documented index caps.
3. Request each rendered page and assert its canonical uses the configured
   origin and its `.md` alternate returns current Markdown. Request hidden
   drafts, expired/scoped-out rows and malformed paths; they must not leak data.
4. Check GET/HEAD, 404 `no-store` and escaped HTML. Importing no web entry should
   keep web rendering code out of the application's bundle.

The current caps are 5,000 scanned rows/10 queries/1 MiB for `llms.txt`, and
50,000 rows/100 queries/50 MiB for sitemap. Translation-aware indexes and
hreflang are a documented follow-up; do not claim them from `locales[0]`.
