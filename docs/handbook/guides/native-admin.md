# Native Admin

Select Admin explicitly; use the exact installed SDK/Admin versions.

## Packages and generation

There are three packages, pinned to matching versions:

| Package | Owns |
| --- | --- |
| `@aotter/mantle` | One native Core SDK: compiler, generator, query kernel and optional auth/surface primitives. |
| `@aotter/mantle-admin` | Optional Admin server, SPA, extensions, design preview and Admin MCP App. |
| `@aotter/mantle-ui` | Shared UI kit and generic interaction controller. |

The SDK does not import Admin or its assets. Selecting Admin emits application
code that imports its small public server helpers. The SPA retains all 22
languages, rich editors and the developer workspace; language, editor and
workspace chunks load on demand. It is not part of the SDK query bundle.

Select Admin explicitly:

```sh
pnpm exec mantle generate cloudflare-d1 generated manifests/*.yaml --admin
pnpm exec tsc --noEmit
```

Targets are `bun-sqlite`, `bun-postgres`, `cloudflare-d1` and
`cloudflare-postgres`. Programmatic generation accepts `admin: true` with the
same target/source options. Optional `--auth`, `--site` and `--admin-extensions`
modules follow their [generation contracts](../cloudflare/service-entry.md).
Generate, typecheck, implement every printed `Handlers` key, then typecheck
again. Commit generated TypeScript, SQL and Wrangler edits. Never edit the
output by hand; regenerate after merging authored inputs. Use the matching
CLI's `--check` with the same selected options in CI.

Apply initial `schema.sql` and selected auth/site DDL only during explicit
setup of a new database. Existing data needs reviewed migrations. Imports and
metadata factories do no storage work. Requests run no DDL or storage checks;
the only request-time write outside app operations is the configured OAuth
resource row (see [OAuth](oauth.md)).

## Mount the API and console

```ts
import { admin } from '@aotter/mantle-admin/server';
import { entries } from '@aotter/mantle-admin/server/entries';
import { adminBindings } from './generated/admin-bindings.js';
import { handlers } from './handlers.js';
import { resolveRequestCaller } from './identity.js'; // application-owned

const bindings = adminBindings({ handlers });
const api = admin(bindings.metadata, bindings.views, bindings.operations, {
  db: (env: Env) => env.DB,
  caller: resolveRequestCaller,
  routes: entries(bindings.schemas, bindings.adapter),
  developerViews: bindings.developerViews,
});
// In app-owned fetch: await api(request, env); undefined means fall through.
```

Ref operations run with the handlers given to `adminBindings({ handlers })`; `admin()` needs no second copy. Without ref Procedures, omit `handlers` and use `adminBindings()`. The app's
resolver verifies the caller; Admin accepts an admin cookie session classified from
Better Auth’s admin plugin `adminRoles` (default `["admin"]`), and cookie writes
retain the shared same-origin check. Comma-separated roles are supported.
Do not manufacture an admin/system Caller from request input. Views and operations
also retain their own generated `requires` checks. Share one request-local
resolver with auth, consent, MCP and REST; preserve its response cookie headers.

The API handles `/admin/api/*`. The app separately serves
`@aotter/mantle-admin/admin/index.html` and its directory at `/admin`, including
client routes such as `/admin/sign-in`; missing assets stay 404. Do not serve
that directory bare: `adminShell(request, assets)` from
`@aotter/mantle-admin/server` returns the shell for every `/admin` page with
`frame-ancestors 'none'`, `X-Frame-Options: DENY`, `no-store` and `nosniff`, and
refuses traversal, encoded separators and NUL (`assets` fetches one built file
by path; a 404 means missing; it returns `undefined` for other requests). Read the
installed Admin README for asset bindings, CSP/import-map hashes and preview
framing. `@aotter/mantle-ui` continues to supply the shared kit. See
[service composition](../cloudflare/service-entry.md) for the complete Fetch/Bun wiring.

## HTTP routes

All paths below start with `/admin/api` and require an admin session; mutations
also require the shared same-origin check. Mount `entries(...)` for collection
routes. Send JSON with `Content-Type: application/json`.

| Method and path | Request / response |
| --- | --- |
| `POST /entries` | Body `{ collection, data }`; creates an entry. |
| `GET /entries/{id}?collection=<schema>` | Reads an entry and its current `entry.version`. |
| `PATCH /entries/{id}?collection=<schema>` | Body `{ data, expectedVersion }`; sends the observed version, not the next one. Publishing entries must be drafts. |
| `POST /entries/{id}/publish?collection=<schema>` | Body `{ expectedVersion }`; validates required data before publishing. |
| `POST /entries/{id}/unpublish?collection=<schema>` | Body `{ expectedVersion }`; returns the entry to draft. |
| `POST /operations/{name}` | Body is the Procedure's input; runs an Admin operation (a Procedure with `requires: ctx.admin` or a `target`). |
| `GET /views/{name}` | Generated admin View query parameters plus `limit`/`cursor`; returns `{ rows, nextCursor? }`. |
| `GET /me` | Returns `{ userId, role, admin, login, image }` for the signed-in caller. |

Entry create/read/patch/transitions return
`{ collection, entry, parentEntryId, parentEntryTitle, related }`; the entry has
`{ id, collection, locale, status, version, data, created_at, updated_at }`.
Transitions accept `{}` to use the current version; tests should send the
observed `expectedVersion` to catch stale writes. Generic writes reject native
columns inside `data`. See [publishing](../concepts/lifecycle-and-locales.md).

## Generated reads and writes

`adminBindings()` returns static metadata, schemas, views, operations and the
selected native adapter. Metadata-only endpoints add no storage read of their
own; authentication, optional user enrichment or site loading may still query.
The shared get/page/statistics functions select quoted tables and columns only
from generated whitelists. Search/filter/cursor/range values are binds, never
SQL identifiers. Core compiles scope, TTL, publishing and parent predicates;
there is no request-time manifest/schema/SQL AST interpreter.

Scoped rows remain private even from other admin. Translation reads merge at
most one visible parent with the matching join key; scoped parents correlate
scope in every mode, including trusted reads. Child declarations win over parent
fields, and a parent's public same-named field cannot replace a child's private
scope. Unrelated scoped Schemas cannot hide an ordinary public field. Scope and
storage-only fields are absent from entry data and generated CSV export fields.
Geo remains experimental: existing native outputs are readable, not generically
editable. Metadata derives child relationships from `allCollections`.

Entry queries validate indexed sort fields, directions, filters and limits
1–500. `filter_field` and JSON `filter_values` are paired; each batch has at most
50 scalar values. Search reuses native SQLite/D1 FTS and PostgreSQL behavior.
Pages keep native NULL ordering, id ties, microsecond timestamp keys and an
opaque cursor bound to caller, input, filters and ordering. Malformed/foreign
cursors and unknown selectors fail before acquiring the route's DB handle;
the app's authentication may already have used its own database. Admin manifest
Views retain their complete proved key tuple, not a two-key approximation.

Generated full/partial input checks validate creates, edits, operations and
filters. Plain titled string `oneOf` choices use the same enum checks; general
or constrained alternatives remain refused. Draft creates can be incomplete;
publish checks required data. Publishing edits apply only to drafts. Read-only
collections refuse generic edits while their declared Procedures can still run.

Writes use compiler-printed native Procedure frames, bind recipes and only the
supplied field fragments. They do not update omitted columns or run a schema
interpreter. PATCH retains its visible-row read and exact OCC check; the mutation
returns its row. Missing/excluded rows are 404; stale locks or failed state guards
are 409. Safe versions are numbers; exact native int64 strings can be bound
without rounding, while unsafe numbers are rejected. The console keeps versions
outside its supported safe range read-only rather than casting them to numbers.
Full cross-target int64 output parity remains incomplete; bare driver values
are unchanged.

Publishing/custom Admin operations load existing generated Procedure modules
when invoked. Ref handlers retain the original typed `{ caller, db, store }`
context and authorization. Ordinary SDK/REST/MCP emission and the synchronous
public Store API are unchanged. Selected JSON boundaries preserve declared JSON/boolean conversions and safe
cross-target integer normalization from SQL text; exact unsafe values are not rounded. Bare
Views, Store and SQL Procedures keep their driver-native contract. Native
unique/OCC errors and uncertain transaction outcomes keep their contracts. A 503 outcome may mean a write committed: do not
retry automatically or turn it into a success by reading afterward. Core
`statusOf` maps core codes only. App media/site/partial errors use `mediaError`
from `@aotter/mantle/media`; other custom ContractErrors must carry an explicit
status, otherwise the boundary returns a redacted 500. Do not leak native
error messages, tokens or credentials to clients.

## Statistics and extensions

`GET /admin/api/collections/{name}/statistics?range=7d` supports primary or
standalone collections; folded children/translations are not primary routes.
Ranges are `1h`, `24h`, `7d` (default) and `20d`. It returns
`{ total, buckets, from, to, bucketMs }` in one native aggregate query. `total`
counts currently caller-visible retained rows, including rows outside the
requested window; expired rows are excluded. Buckets use `[from, to)` and the
same generated scope/TTL/parent policy. The shared native function accepts at
most 20 days and 480 buckets, with safe microsecond arithmetic. Temporal enum
subtypes return original metadata keys; equivalent offset spellings count once
under the first key, and separate microseconds remain distinct.

Site/media/identity, extensions, WebMCP, design preview and MCP Apps are selected
through the public Admin modules, not added to the SDK kernel. Extension
contribution declarations go to `--admin-extensions`; executable handlers and
sources stay in app-owned server configuration. Raw extension handlers receive
the original Request without pre-reading, cloning or rebuilding it. Custom
`bodyLimit` checks Content-Length before DB access; the app must bound reads of
unknown-length raw streams. Built-in JSON routes use the shared bounded reader
(default 1,000,000 bytes) after caller/origin checks and before DB acquisition.
The API advertises capabilities for actually mounted routes, including statistics.

## Acceptance

Use a disposable database for native tests, then exercise actual OTP sign-in,
the Admin console and member frontend. Check invalid input, another tenant's
rows, expired rows, publishing transitions, related/translated entries, paging,
statistics, CSV, operations/ref effects, stale OCC and persisted state after a
restart. Recheck extensions, previews, all supported UI languages and the
complete developer workspace. A generated file, typecheck or HTTP 200 alone
does not verify these flows.

Native adapter evidence covers all four targets; local D1 uses real workerd.
Initial Admin module imports perform no DB work. Startup graphs, uploaded total,
SDK package bytes and query/write/cold timing are separate checks. Extra selected
Admin indexes add write/storage maintenance; an indexed SELECT plan does not
prove unchanged write latency. Report remaining gates honestly; this guide does not promise measured performance.

## Extension declarations

Pass full declarations to `--admin-extensions`. Generation emits
`extensionMetadata` in `admin-descriptors.ts` and compiled settings checks plus
`extensionBindings` in `admin-extensions.ts`. Bind the same runtime definitions
(including handlers) with `extensionBindings(adminExtensions)`, and merge the
returned `extensions` and `routes` into `admin()` options. Declaration drift is
refused before any handler runs. The older descriptor `extensionBindings` export
contains manifest UI references only; it is not the runtime binding function.

Native Admin does not serve `source` modules or modify shell import maps. Serve
an extension's `module` at a same-origin absolute path and install its `integrity`
in the host shell import map. Selecting `source` fails generation with that
instruction. This differs from historical 0.2's automatic source-module route.

Entry lists and editor reads/writes return translation badges and related
sections in one authorized HTTP response. `/bootstrap?collection=...` can include
the first requested list page. CSV exports use `/entries/export` and
`/views/{name}/export`; native browser downloads stream paged server output.
A failure after headers aborts the stream, so a download can fail after partial
bytes have arrived. Existing databases need an app-owned migration for the
Admin-selected `created_at` statistics indexes emitted in initial `schema.sql`.

## Collection list template today

The compiler derives display/filter metadata from Schema `uiSchema`, searchable fields from `searchableFields`, and sortable fields from indexes plus required/non-null fields and selected system columns. It emits per-collection quoted fragments, row policies and bind recipes; Admin uses one shared `nativeEntryPage` implementation, not Store `find`, `search` or `count` for these lists.

Requests select only generated fields and append only supplied predicates. Absent filters are omitted, rather than expressed as `(? IS NULL OR …)`. Sorts and scalar values are checked before the route acquires its DB handle. In 0.2.0 there is no generated Cartesian set of filter variants or variant cap: runtime SQL shapes depend on selected filters, bounded IN lists, search, cursor and order. Only sortable fields are checked for indexes; there is no per-filter-combination index proof. Inspect EXPLAIN for the actual workload.

Store keeps `find({ search })`, `first({ search })` and `count(where?)`. See [Store search and count costs](typed-queries.md#store-reads-and-writes): Admin shares the dialect search, and a View does not make PostgreSQL ILIKE faster.

## Collection navigation and operation placement

A Schema with a required `x-mantle-ref` folds under its parent collection: it
opens from the parent entry's workbench and stays out of the sidebar, while
`/admin/c/<schema>` still lists it; translation children remain on language
tabs. Set `Schema.spec.uiSchema.nav.standalone: true` to put a required-ref child
at the top level instead. With multiple eligible references, set
`nav.parentField` to the chosen reference field.

Operational collections have no generic create or draft: officers add records through a Procedure placed with `collectionAction` (the list header shows its button and input form), so every write is a declared, validated program. For a user-field scoped Schema, SQL INSERT is system-only, so that Procedure is a ref handler that inserts through `ctx.store` ([procedure.md](../reference/procedure.md)).

Admin operations are Procedures exposed by an admin MCP Trigger. Declare
`Procedure.spec.uiSchema.collectionAction: <schema-name>` to show the operation
in that collection's list header. Row operations are chosen by the Procedure's
explicit `target: { schema, id, version? }`: `id` names the input bound to the
row id, and optional `version` names the input bound to its reviewed OCC version.
Names such as `approve` never determine placement. An operation without a row
target or collection action appears on the Operations page, whose sidebar link
appears whenever such operations exist.

Generated row metadata includes simple AND-ed equality/IN literal conditions
from the target-row UPDATE/DELETE WHERE. The menu hides known mismatches; missing
preview values and unsupported predicates leave actions available. These are
presentation hints: the Procedure still enforces its WHERE and authorization.
Conflicts show a localized refresh message with the technical diagnostic in
Details. Successful actions show a short summary and changes, with raw output
in a collapsed Details disclosure. CSV exports retain UTC wire timestamps.

Developer Model and Logic pages share an object sidebar on wide containers
and an object-list drawer on narrow containers.
Schema Live data previews use collection routes even for folded children.
Pass `bindings.developerViews` as the Admin `developerViews` option for
public and admin View previews; ordinary Admin View routes and exports use
only `bindings.views` (admin Views). View previews use the read-only `/admin/api/developer/views/<view>` route,
with the signed-in admin caller and the same authorization, scope, TTL and
publishing policy as REST. Public Views retain public visibility; internal or
disallowed Views show an unavailable explanation. Previews never use a system
caller or bypass a View's `requires`.
