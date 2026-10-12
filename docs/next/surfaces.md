# Generated surface deltas

The wire contracts remain [0.2 surfaces](../handbook/reference/surface.md)
and [ADR-0012](../adr/0012-views-as-public-rest.md), as amended by the shipped
handbook. Only the implementation and responsibility changes follow.

- The app mounts generated modules and passes `{ db, caller }`; `caller(request)`
  is the app's own `resolveCaller(...)` call. There is no generated `service.ts`,
  `withCaller` framework or Better Auth wrapper.
- REST retains public `GET /api/views/<name>` with declared query input plus
  `limit` and `cursor`, answering `{ rows, nextCursor? }`. HTTP Triggers retain
  their own method/path; JSON bodies and path parameters form the Procedure
  input and responses contain its result. Errors remain
  `{ error: { code, message, path } }` with the 0.2 status. Cookie sessions cannot
  mutate across origins.
- MCP retains public `POST /mcp`, staff `POST /mcp/staff`,
  snake-cased View names on each declared surface, and snake-cased Procedure
  names per MCP Trigger. Its SDK loads only through a request-time dynamic import.
- HTTP/MCP Triggers declare exposure only. `mantle generate` refuses schedule
  and lifecycle Triggers; Cloud scheduling is a separate capability.
- Retained Admin features keep their 0.2 paths; #1477 decides the retained set.

Generated `rest.ts`, `mcp.ts`, `web.ts`, `paged/views/*` and `validation/*` hold
only the app's tables: routes, tools, pages, operation bindings, compiled input
checks and types. Request handling (matching, body and query decoding, dispatch,
challenges, JSON-RPC, web rendering, keyset paging) lives in the package's
`rest`, `mcp`, `web`, `paging` and `validation` kernel modules, so a runtime fix
ships as a package update instead of a regeneration.

The generated `validation/views/<name>.ts` and
`validation/procedures/<name>.ts` export `validate(unknown)`. View validators
also export `query(URLSearchParams)` returning `{ input, limit?, cursor? }`.
REST and MCP use the same generated checks, with no runtime schema interpreter.
Supported checks are types/unions and nullable, required/properties/additionalProperties,
arrays/items and length bounds, enum, local `$defs`/`$ref`, string length/pattern,
numeric bounds/`multipleOf`, and date/date-time. Integers must be safe; fractional
`multipleOf` uses a 1e-9 quotient tolerance. `const`, `oneOf`, `uniqueItems` and
object property-count bounds are refused, alongside other unsupported keywords
and formats. Defaults remain
annotations and are not inserted into request input.

Transport-facing `paged/views/<name>.ts` exports
`page(db, caller, input, { limit?, cursor? })`, answering `{ rows, nextCursor? }`.
Bare `views/<name>.ts` retains native row arrays and accepts app-validated input;
selecting neither boundary adds no validation or paging work to that query.
Authored SQL `LIMIT` caps each page, up to 500, rather than the whole cursor walk.
A pageable Schema View has a complete NOT NULL scalar tuple ending in the
compiler's `id` tiebreak. Its ordered columns must match an index after fixed
equality prefixes (including caller scope); multiple columns and mixed directions
retain the authored order. CTE projections preserve the proof; joins must have a
proved singleton side, or an exact PK `id` equality to a non-null column of the
other relation, so the base id cannot fan out. Relation aliases and nested CTE
bindings keep their own identity; same-Schema aliases are not interchangeable.

Grouped Views use every GROUP BY key as the tiebreak, with known non-null scalar
keys; unfiltered, non-windowed `min`/`max` of a non-null column retain its native cursor type. Paging a
grouped result does not avoid the native grouping/source scan. Authors own source
predicate indexes and should inspect EXPLAIN for their workload. Nullable,
unknown and JSON order expressions and unproved fanout remain refused.
Trusted system reads retain their all-scope SQL: without an actual scope
predicate, a scope-first index is not a proved range scan and native sorting or
scanning may be needed. Caller equality-prefix proofs do not claim otherwise.

Proved singletons (scalar/aggregate queries, unique-id lookups and singleton
sources) run bounded first-page SQL, reject cursors and refuse overflow.
Internal Views receive directly imported paged modules only when the same proofs
hold; they gain no public route or tool. Their bare modules remain available for
other native SQL and return full authored-query arrays.

Cursors reuse the Store's percent-encoded JSON keyset codec. Selected View
cursors include operation provenance; malformed, foreign and
null-key cursors fail with `INPUT_VALIDATION_FAILED`. Each generated key has a
scalar check; temporal keys keep database microseconds. Existing one/two-key
formats and Store cursors are preserved; larger View tuples contain their full
key list followed by operation provenance. They are opaque navigation
values, not credentials; authorization and row predicates run on every page.

## Mounting REST

`rest.ts` exports `rest({ db, caller })`, returning an async
`(request, env) => Response | undefined`. The app supplies its native handle and
verified Caller; requests outside `/api` fall through to the app. Public Views
use `/api/views/<name>`; HTTP Triggers keep their declared method and path.
Known paths with another method return 405 with an `Allow` header. All responses use
`cache-control: private, no-store`. JSON bodies and decoded path parameters
are validated together, with path parameters taking precedence. Bodies larger
than 1,000,000 bytes are refused; `content-length` is checked before reading.
A resolver's `ContractError` keeps its status (an expired token is 401 with its challenge); any other resolver exception returns a redacted 500. Cookie-origin refusals retain
`path: "request:origin"`; REST and MCP share the kernel check.

When the manifest declares ref Procedures, pass the generated `Handlers` as
`rest({ db, caller, handlers })`; the option is type-required. Handler dispatch
uses the generated Store, preserving the Procedure's authorization contract.
Publishing visibility belongs to generated SQL; the REST module adds no status
filter. The app retains ownership of authentication and its other routes.

REST native acceptance is runnable with
`MANTLE_NEXT_REST_D1=1 MANTLE_NEXT_BUN_PG_URL=<disposable-db> bun test tests/rest-native.test.ts`
from the SDK package. D1 uses local Wrangler on port 8998; the tests clean their
local state and PostgreSQL schema. No cloud deployment is needed.

## Optional web output

`web.ts` exports `web({ db, caller, origin, title, description, locales?, pages,
cacheControl? })`. `db` is the application-owned native handle, including callable
PostgreSQL handles. `caller` is a verified Caller or the app's
`(request, env) => Caller | Promise<Caller>` resolver, evaluated once per request.
The module dispatches public Views only; it never invokes Procedures or needs handlers.

```ts
import { web } from './generated/web.js';
const site = web({ db, caller, origin: 'https://example.com', title: 'Blog',
  description: 'Articles', locales: ['en'],
  pages: { '/posts/{slug}': { view: 'post-by-slug', list: 'posts', markdown: 'body' } }
});
const response = await site.fetch(request, env); // Response | undefined
const tags = await site.head(request, env); // HTML string, empty for unknown/missing pages
```

Page parameter names must exactly match the View's declared input properties.
Page and list Views must return the page parameters; list Views must accept empty input. Markdown
must name a textual output column. HTML remains application-owned.

`/llms.txt` and `/sitemap.xml` traverse each list's `nextCursor`; `.md` and head
read the current page View. SQL alone controls visibility, including publication.
GET/HEAD responses include content-derived SHA-256 ETags. Anonymous responses use
`cacheControl` or `public, max-age=60`; authenticated responses use
`private, no-store`. `If-None-Match` returns 304 only after current content is read.
Canonical URLs use the configured origin, independently of the request host.
The current implementation adds hreflang only for `locales[0]`; translation-aware
indexes and head tags are a follow-up below. Importing another generated entry
does not import web output.

Web indexes scan at most 50,000 rows for one sitemap and 5,000 for `llms.txt`,
across all configured lists. Skipped `.`/`..` path segments consume the scan
budget too. Output stops before exceeding 50 MiB of UTF-8 sitemap XML (including
its closing tag) or 1 MiB of `llms.txt`; a sitemap index can be added separately.
Each request also stops after 100 sitemap queries or 10 `llms.txt` queries,
across all templates. Small authored SQL LIMITs or many templates can truncate
output sooner. A sitemap index remains separate future work.

`head` normalizes URLs from the queried row's page parameters, matching sitemap
URLs; malformed paths, failed validation and unavailable rows return an empty
string. A NULL Markdown field answers 404. Errors and missing Markdown responses
use `cache-control: no-store`. A matching HTML page takes precedence over a `.md`
alternate, including slugs ending in `.md`; a Markdown alternate may read the
exact HTML candidate first and therefore performs at most two View queries.

### Web translation follow-up

The generated `web.ts` exists; integrating translated pages is a separate follow-up.
It will call `translationLocales(db, caller, parent, rows)` once per parent page,
using its batched SQL reads rather than querying each parent separately. Locale
availability must follow the same public SQL parent/translation visibility rules.
The follow-up will produce per-locale `llms.txt` and hreflang alternates from those
available locales. Canonical locale tags use `toCanonicalLocale` (for example
`zh-TW`); URL locale segments retain the 0.1 lower-case form (`zh-tw`). Site locale
order chooses the canonical locale. Canonical and alternate URLs use the configured
origin and the same row-derived page parameters as the sitemap.

## Mounting Admin

Import the generated `admin` handler and mount it in the application's Fetch entry.
It returns `undefined` outside `/admin`; Admin API paths remain `/admin/api/*`.
Pass the app's `db(env)` and `caller(request, env)` functions. The resolver runs
once for an API request and never for the public SPA shell. Admin accepts only
a cookie-session user with role `staff`; anonymous users receive 401, other
callers receive 403 with `minimumRole: "staff"`. Session mutations use the shared
same-origin guard. All API responses and errors use `no-store`.

```ts
import { admin } from './generated/admin.js';
const console = admin({ db: env => env.DB, caller,
  assets: async (path, request, env) => {
    const response = await env.ASSETS.fetch(
      new Request(new URL('/admin/' + path, request.url), request));
    return response.status === 404 ? null : response;
  },
  getUser: async (subject, request, env) => directory.getUser(subject),
  mcpEndpoints: { public: '/mcp', staff: '/mcp/staff' }
});
const response = await console(request, env);
```

`assets` returns `null` for a missing file. Unknown client paths fall back to
`index.html`; missing `assets/*` files stay 404. Traversal and encoded separators
are refused. HTML is `no-store`, with `nosniff`, `frame-ancestors 'none'` and
`X-Frame-Options: DENY`; `preview.html` remains frameable. Built assets are immutable.
Assets are app-owned and are not bundled into the query core.

`GET /me` returns `{ userId, role, login, image }`. Optional `getUser` supplies
display information; unwired identity operations return 501. `GET /bootstrap`
aggregates `me`, `site`, `collections`, caller-visible `views` and `operations`,
and `webmcp`. An installed entries route adds the first page for `?collection=`.
Without site or identity wiring the bootstrap performs no database reads.
Generated site configuration supplies `site(db, caller)` automatically when
`--site` is selected; an application may override that option. `/site` capability
flags reflect the wired site, media and invitation email facets. Statistics remain
unavailable (501), and their capability is false.

Site and identity routes are generated with Admin and share its cookie-session,
staff and same-origin checks. `GET/PATCH /site-settings` returns only
`{ brand, title, description }`; partial updates limit these to 80/200/1,000
characters. No site option returns 501 `SITE_NOT_CONFIGURED`.

Pass the app-owned `media` object storage with a generated site capability.
`POST /media/uploads`, `POST /media/uploads/<groupId>/commit`, and
`GET/PATCH/DELETE /media/<id>` reuse that site’s native media library. Bytes go
directly to the returned upload URLs. `GET /media` accepts `limit` (1..500),
`cursor` and literal `search`, returning `{ items, next_cursor }`. Items include
`primaryUrl`, `mime` and `byteSize`. Without both site and object storage the
routes return 501 `MEDIA_NOT_CONFIGURED`, and `/site.capabilities.media` is false.
Media error statuses and retry-safe partial deletion outcomes are preserved.

Supply request-scoped native identity methods in `identity.directory`; no
provider is registered globally and Admin never loads Better Auth itself:

```ts
identity: {
  directory: async ({ db, caller, request, env }) => {
    const { d1Identity } = await import('@aotter/mantle/auth/identity');
    return d1Identity(db, await loadAuth(env), caller, request.headers);
  },
  roles: { sendStaffInvitation: (email, role) => sendInvitation(email, role) }
}
```

`loadAuth` and the optional email sender belong to the app. Use
`postgresIdentity` for PostgreSQL. `GET /staff` returns `{ users }` and
`GET /members` accepts `search` (<=200 characters), `limit` (1..100, default 50),
`cursor` and `cursor_direction` (`forward` or `backward`), returning
`{ items, previous_cursor, next_cursor }`. Native member cursors retain timestamp
precision; member search is a full scan. Both lists project declared identity
fields only; members never expose staff roles, password hashes or ban metadata.
`PATCH /staff/<id>/role` accepts `staff` or `null`; self changes are forbidden.
`POST /staff/invitations` takes `{ email, role: 'staff' }` and returns
`{ ok, userId, emailSent }`. Existing accounts must verify their email before
receiving staff access. `DELETE /staff/invitations/<id>` returns 409 for an
account that has signed in or verified. Missing identity methods return 501
`IDENTITY_NOT_CONFIGURED`. OSS uses only `staff`; the Admin SPA role controls
are adapted in the console work package.

Staff Views use `/views-manifest`, `/views/<name>` and `/views/<name>/export`.
Inputs, `limit` and `cursor` retain generated validation and keyset paging.
Declared `searchFields` and `filterFields` accept `search` and `filter.<output>`;
generated SQL applies those predicates before the page's LIMIT, with bound values.
Search matches literal text case-insensitively (dialect Unicode folding still varies).
View names denied by `requires`, public Views and internal Views are 404.
The selected Admin View boundary restores declared field spelling. View timestamp
outputs retain their ISO wire strings, as in 0.2; entry list millisecond timestamps
belong to the content routes. Bare queries retain native rows. CSV streams pages of
500, with UTF-8 BOM, RFC 4180 quoting and spreadsheet formula guards.

`/operations` lists caller-visible staff MCP Procedures; publishing transitions
remain on the native content buttons rather than this list. `POST /operations/<name>`
validates a JSON object of at most 1,000,000 UTF-8 bytes, then returns
`{ ok: true, output }`. SQL outputs retain `{ results }`, and ref outputs remain
handler-owned. Pass the generated `handlers` option when the manifest declares
refs. OCC `CONFLICT` remains unchanged; the console's write controller re-reads
the entry before explaining it. Selected Admin modules add relative API routes
through `routes`; they share the same caller, session and origin gate.

## Mounting MCP

Mount the generated `mcp({ db: env => env.DB, caller })` handler in the app's
Fetch entry. It returns `undefined` outside `/mcp` and `/mcp/staff`. Install the
optional official `@modelcontextprotocol/server` peer when selecting MCP; its
transport loads on the first matching request. Pass `handlers` when ref
Procedures are declared, as for REST. Staff tools are listed only on the staff
endpoint, and publishing visibility belongs to the generated SQL.

The app resolves bearer tokens with `resolveCaller(request, auth, { audience:
new URL('/mcp', request.url).href })` (both surfaces use `<origin>/mcp`). The app
must also mount Better Auth's `/.well-known/oauth-protected-resource/mcp`
metadata route. Auth challenges point to that route. Presented bearer credentials
need the `mcp` scope; cookie sessions use the same-origin mutation checks.

Generation emits `mcp.ts` only for a non-internal View or MCP Trigger. These
manifests require the `@modelcontextprotocol/server` 2.1.0 peer when typechecking
the generated surface. Publishing alone does not select MCP; on a selected
surface its generated `publish_<schema>`, `unpublish_<schema>` and
`archive_<schema>` tools use the same snake-case naming rule, are staff-only
and take `{ id, expectedVersion }` through the shared generated validation.

The staff allowlist is `owner`, `editor`, `contributor`. MCP bodies are limited
to 1 MiB (1,048,576 bytes). Resource metadata challenges use the origin of
`request.url`; behind a proxy, the app must pass a Request with its public
origin so the audience and metadata URL point to the client-visible service.
