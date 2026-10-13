# Supported declarations

The native 0.2.0 SDK compiles the closed v2 grammar for four targets. Generation diagnostics, rather than historical APIs or release plans, define the checked-out implementation. Existing integrations require explicit app wiring and data migration; initial schema.sql is for an empty database.

## Supported

| Feature | Availability / agent action |
| --- | --- |
| Closed v2 Schema/View/Procedure grammar, PostgreSQL SQL authoring | Generated for Bun SQLite, Bun PostgreSQL, Cloudflare D1 and Cloudflare PostgreSQL; dialect behavior stays native. |
| Operational Schemas, scope, TTL read visibility, indexes, checks, native SQL facilities | Generated initial DDL and compiled SQL policy; run migrations and TTL maintenance in application code. |
| System-only TTL maintenance | Generated `<schema>.sweepExpired`, bounded cursor scans and optional dry-run; app owns `scheduled()` wiring and cron configuration. See [TTL maintenance](../guides/native-execution.md#ttl-maintenance). |
| Typed SQL Views and Procedures, auth predicates, OCC, atomic writes | Generated bare queries accept validated inputs and a verified Caller; date/date-time outputs are ISO strings, native errors stay internal. |
| Typed Store collections and internal Views/Procedures | Shared Store, AND-only filters, indexed non-null keyset ordering, atomic batches; interactive transactions on SQLite/PostgreSQL. |
| Searchable fields, Store search and SQL search/rank | Generated SQLite/D1 FTS5 trigram table and maintenance triggers; PostgreSQL ILIKE. Store find/first trim non-empty search and match exact id OR declared fields, within the caller's row rules. |
| Better Auth integration and Workers builds | App owns `auth.ts` and `resolveCaller`; optional [OAuth helpers](../guides/oauth.md) provide consent/connected apps, live grant/session checks and DPoP. `mantle generate` emits native Wrangler build configuration. Keep heavy auth imports lazy. |
| Transactional email port, English templates and dev console sender | Optional `@aotter/mantle/email`; app supplies the sender and passes locale through. See [email wiring](../guides/email.md). |
| View keyset pages, generated boundary validation and HTTP error mapping | Generated `paged/views/*` for proved exposed/internal Views: indexed non-null tuples, complete groups and singleton joins/lookups; `validation/*` and `wire`; see [surface contracts](surface.md). |
| REST and `http` Trigger exposure | Supported generated `rest.ts`; app mounts with `{ db, caller }` and required `handlers` for ref contracts. Public Views page at `/api/views/<name>`; HTTP Triggers keep method/path. |
| Generated MCP and `mcp` Trigger exposure | Public/staff tools, shared generated checks, publishing transitions on staff only; SDK loads on matching requests. Install the official MCP peer for manifests selecting this surface. |
| Dynamic `web.ts` (`llms.txt`, sitemap, `.md` alternates, head tags) | Generated; mount `web({ ... })`; see [surface contracts](surface.md#optional-web-output). |
| Native Admin bindings, server and console | Supported; select `--admin` / `admin: true` and mount `entries(bindings.schemas, bindings.adapter)`. Shared authorized read templates, native Procedure writes and the console; see [Native Admin](../guides/native-admin.md).  |
| Localized Schemas and translations | Plain-string locale values, atomic published-parent guard, SQL parent visibility and generated page locale helper; see [Translations](../concepts/lifecycle-and-locales.md#translations). |
| Opt-in `lifecycle: publishing` | Generated status, `published_at`, staff-only transitions and published-only public reads; see [Publishing](../concepts/lifecycle-and-locales.md). |
| `ref` Procedures and typed `Handlers` | Generated `Handlers` type; pass implementations at `store(db, caller, { handlers })`; `mantle generate` lists them. See [ref Procedures](../guides/native-execution.md#ref-procedures). |
| Optional site settings and media | Select `site` defaults at generation to emit the generated `site` module and deployment tables; native media upload lifecycle, app-owned R2/signing. See [media](../cloudflare/media-r2.md). |

## Refused

Each unsupported declaration produces `GENERATE_UNSUPPORTED`, its manifest path,
and the following hint. Invalid grammar/SQL retains the compiler's own diagnostic
codes and paths. Multiple declarations produce multiple diagnostics.

| Declaration | Do instead |
| --- | --- |
| `schedule` Triggers, including disabled ones | Wire `scheduled()` yourself. |
| `lifecycle` Triggers: before/after hooks, including targets using `ref` | Write a custom handler. |
| `requires.guard` on a View or Procedure | Write a custom handler that checks authorization before executing queries. |
| A View projecting a native `geo` value | Select the latitude and longitude columns explicitly. |
| Dynamic or repeated View output names | Give each SELECT output a unique explicit alias. |
| Declared date/date-time outputs without one SELECT item per output | Expand the SELECT list explicitly. |
| Input properties differing only in case | Rename input properties to be unique without regard to case. |
| PostgreSQL JSON/date/date-time parameters used without the declared cast | Wrap each occurrence in the concrete `CAST(... AS <type>)` shown by the diagnostic. |


Store handles simple AND reads and writes; use internal Views for OR, joins, aggregates and reuse. Ref Procedures are supported with a typed caller/transaction-bound Store. See [typed queries](../guides/typed-queries.md), [lifecycle/locales](../concepts/lifecycle-and-locales.md) and [database ownership](../concepts/runtime-and-adapters.md).
