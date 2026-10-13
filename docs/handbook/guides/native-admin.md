---
description: Mount the native Admin preview with generated bindings, shared authorized reads and native Procedures, and verify its API and console.
---
# Native Admin preview

This guide describes the experimental native Admin implementation intended for
alpha.7. It is not a release announcement. Use the exact installed package's
README and docs; a develop checkout or workspace preview does not mean alpha.7
has been published. Applications through alpha.6 that still use RuntimePlan
follow the [historical Admin guide](admin-ui.md). Replacing that integration
requires app-owned wiring and reviewed data migrations.

## Packages and generation

The intended release has three packages, pinned to matching versions:

| Package | Owns |
| --- | --- |
| `@aotter/mantle` | One native Core SDK: compiler, generator, query kernel and optional auth/surface primitives. |
| `@aotter/mantle-admin` | Optional Admin server, SPA, extensions, design preview and Admin MCP App. |
| `@aotter/mantle-ui` | Shared UI kit and generic interaction controller. |

The SDK does not import Admin or its assets. Selecting Admin emits application
code that imports its small public server helpers. The SPA retains all 22
languages, rich editors and the developer workspace; language, editor and
workspace chunks load on demand. It is not part of the SDK query bundle.

In a workspace preview, use that checkout's matching packages and CLI rather
than installing an unpublished version. The native implementation replaces the historical Core inside the canonical
`@aotter/mantle` SDK. Do not install a second, parallel Mantle package or alias an old
Core package to satisfy native imports.

Select Admin explicitly:

```sh
pnpm exec mantle generate cloudflare-d1 generated manifests/*.yaml --admin
pnpm exec tsc --noEmit
```

Targets are `bun-sqlite`, `bun-postgres`, `cloudflare-d1` and
`cloudflare-postgres`. Programmatic generation accepts `admin: true` with the
same target/source options. Optional `--auth`, `--site` and `--admin-extensions`
modules follow their [generation contracts](../../next/service.md).
Generate, typecheck, implement every printed `Handlers` key, then typecheck
again. Commit generated TypeScript, SQL and Wrangler edits. Never edit the
output by hand; regenerate after merging authored inputs. Use the matching
CLI's `--check` with the same selected options in CI.

Apply initial `schema.sql` and selected auth/site DDL only during explicit
setup of a new database. Existing data needs reviewed migrations. No import,
request, metadata factory or Admin route applies DDL or seeds a database.

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
  handlers,
  routes: entries(bindings.schemas, bindings.adapter),
});
// In app-owned fetch: await api(request, env); undefined means fall through.
```

Without ref Procedures, omit `handlers` and use `adminBindings()`. The app's
resolver verifies the caller; Admin accepts a staff cookie session with role
`staff`, and cookie writes retain the shared same-origin check. Old
owner/editor/contributor identities need an explicit role migration to `staff`.
Do not manufacture a staff/system Caller from request input. Views and operations
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
[service composition](../../next/service.md) for the complete Fetch/Bun wiring.

## Generated reads and writes

`adminBindings()` returns static metadata, schemas, views, operations and the
selected native adapter. Metadata-only endpoints add no storage read of their
own; authentication, optional user enrichment or site loading may still query.
The shared get/page/statistics functions select quoted tables and columns only
from generated whitelists. Search/filter/cursor/range values are binds, never
SQL identifiers. Core compiles scope, TTL, publishing and parent predicates;
there is no request-time manifest/schema/SQL AST interpreter.

Scoped rows remain private even from other staff. Translation reads merge at
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
the app's authentication may already have used its own database. Staff manifest
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
PostgreSQL integer normalization; exact unsafe values are not rounded. Bare
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
prove unchanged write latency. Report remaining gates honestly; this preview
neither establishes release acceptance nor promises measured performance.

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
