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
- Native Admin retains selected 0.2 paths and the console contracts; see
  [Native Admin preview](../handbook/guides/native-admin.md) for app-mounted
  `adminBindings()` and `entries(bindings.schemas, bindings.adapter)`.

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
Selected REST/MCP/Admin responses convert declared integer columns on every target
to safe numbers or exact decimal strings. Their SQL reads integers as text before
driver conversion; integer cursor keys retain that precision without changing native
sort order. `views/<name>.ts` also exports `WireRow` for selected transport
boundaries; declared wire fields agree across targets. Declared SQLite/D1
JSON/boolean columns become JSON values and booleans. Aliases follow generated
source-column lineage; computed values and Procedure/ref results retain
their contracts. Internal paged View rows stay native;
integer bigint cursor keys are serialized separately.
Internal paging creates no public route/tool.
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

The generated staff allowlist is `staff`; the application supplies its own verified Caller. MCP bodies are limited
to 1 MiB (1,048,576 bytes). Resource metadata challenges use the origin of
`request.url`; behind a proxy, the app must pass a Request with its public
origin so the audience and metadata URL point to the client-visible service.

Selected integer cursor keys may be exact canonical decimal strings on either dialect; SQLite cursor binds are cast to INTEGER so grouped expressions and native columns compare the same value; they are bounded to the declared integer range. This applies to cursor metadata only and does not change bare query or Store integer outputs, or recover integers already rounded by a native driver. `validCursor` is shared with selected boundary adapters.

Cursor casts target only proved AST bind nodes, preserving authored SQL literals. Paging proofs respect the compiler's lexical table/CTE identity. Explicit CTE or relation column renaming is currently refused for paging because uniqueness has not been proved through those aliases; internal bare queries remain available.

A paged View's output names must not collide with its actual hidden cursor keys (`_k0` through `_kN-1`); SQLite compares aliases without case sensitivity. Such internal Views keep their bare entry but receive no paged entry. Other output names remain available.

## Selected Admin bindings

See [Native Admin preview](../handbook/guides/native-admin.md) for the single
current contract: three packages, explicit generation and app mounting, shared
whitelisted get/page/statistics templates, native Procedure fragments, generated
input checks, exact OCC and optional capabilities. These features are implemented
as a preview; this document does not claim alpha.7 is published.


### MCP catalogue and callbacks

`mcp({ db, caller, handlers?, locale?, instructions?, serverInfo?, requiredScopes?,
resourceMetadata?, onObservation?, onRefusal? })` keeps the SDK behind its first
request. Locale defaults to `en`; localized titles/descriptions fall back to
English, then their first entry. Views advertise `readOnlyHint`; Procedures use
their declared MCP annotations. `instructions` is returned by initialize.
The scope floor defaults to `["mcp"]` for every credential except cookie sessions;
`requiredScopes: []` disables that floor. An anonymous closed surface challenges
from initialize, and every call in a batch is checked before any call runs.
`resourceMetadata` overrides the challenge URL for reverse proxies.

`onObservation` receives request refusals and invocation attempt/completion
metadata, including duration and outcome. Its Caller and scopes are frozen copies.
`onRefusal` receives credential/origin refusals. Neither callback receives request
headers, bodies or tokens; delivery failures never change the business response
and promises are not awaited. The application owns callback delivery.

**Procedure output delta:** SQL Procedures retain the Next native `{ results }`
contract rather than 0.2's authored output projection/validation; MCP advertises
that object envelope, not the incompatible authored schema. Ref Procedures expose
the application's typed return value and advertise their authored object output
schema. The application owns ref output validation. MCP does not decode or
revalidate native database rows. Business failures carry diagnostics in text;
with an output schema they omit `structuredContent` to avoid validating an error
against a success schema. Without one they also expose diagnostic structured
content. MCP adds no prompts or non-UI resources.

### Declared View scalars on the wire

REST and MCP View pages expose declared JSON columns as JSON values and declared
boolean columns as booleans, including explicitly authored SQL aliases. SQLite
and D1 conversions are compiled into only the selected boundary pages;
PostgreSQL already-native JSON/boolean values pass through. SQL NULL stays null and absent
fields stay absent. Expressions without declared column lineage stay native.
Malformed persisted JSON becomes a redacted internal failure. The conversion
adds no database operations and does not mutate native query rows.

Bare Views, Store rows, native SQL Procedure `{ results }` and application-owned
ref outputs retain their native contracts. Use the generated `rest()` / `mcp()`
module for this client wire contract; do not duplicate JSON/boolean decoding in
application route handlers or decode PostgreSQL JSON strings a second time.

PostgreSQL declared integer columns (including a selected system `version`)
retain 0.2's wire form: safe integers become JSON numbers; unsafe values remain
exact text. Computed outputs and native SQL Procedure/ref results retain their
native values. This does not promise precise unsafe int64 values on D1.
Unexpected surface failures log only a stable wire classification.

MCP locale fallback reads only own locale entries, then English, then the first
own entry; inherited property names never become titles or descriptions.

### Staff media MCP tools

With generated site configuration, `mcp({ db, caller, media: env => storage })`
loads the media module only on a configured staff MCP request and
adds `get_media_upload_policy`, `create_media_upload`, `commit_media_upload`,
`list_media_assets`, `get_media_asset`, `update_media_asset` and
`delete_media_asset` to `/mcp/staff` only. `storage` is the same `MediaStorage`
used by the Admin media library. Omitting `media` omits all seven tools.
The OSS `staff` role can invoke them; cookie writes retain the origin check.
Generated boundary code checks each input and advertises the 0.2 schemas and
read-only/destructive/open-world hints. Image bytes are PUT directly to the
returned short-lived URLs with their required headers, then committed; bytes
never enter MCP. Store permanent asset ids, never upload URLs.
