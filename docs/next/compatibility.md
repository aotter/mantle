# Supported and refused declarations

This is the agent-facing scope of generated Mantle applications, following
[#1465](https://github.com/aotter/mantle/issues/1465) and [ADR-0045](../adr/0045-next-runtime-core.md).
There is no compatibility layer for Core APIs, imports, envelopes or cursors,
and no automatic data migration. Rebuild application integration and move data
explicitly; apply `schema.sql` directly only to a new database.

## Supported

| Feature | Availability / agent action |
| --- | --- |
| Closed v2 Schema/View/Procedure grammar, PostgreSQL SQL authoring | Generated for Bun SQLite, Bun PostgreSQL, Cloudflare D1 and Cloudflare PostgreSQL; dialect behavior stays native. |
| Operational Schemas, scope, TTL read visibility, indexes, checks, native SQL facilities | Generated initial DDL and compiled SQL policy; run migrations and TTL maintenance in application code. |
| System-only TTL maintenance | Generated `<schema>.sweepExpired`, bounded cursor scans and optional dry-run; app owns `scheduled()` wiring and cron configuration. See [TTL maintenance](contract.md#ttl-maintenance). |
| Typed SQL Views and Procedures, auth predicates, OCC, atomic writes | Generated bare queries accept validated inputs and a verified Caller; date/date-time outputs are ISO strings, native errors stay internal. |
| Typed Store collections and internal Views/Procedures | Shared Store, AND-only filters, indexed non-null keyset ordering, atomic batches; interactive transactions on SQLite/PostgreSQL. |
| Searchable fields, Store search and SQL search/rank | Generated SQLite/D1 FTS5 trigram table and maintenance triggers; PostgreSQL ILIKE. Store find/first trim non-empty search and match exact id OR declared fields, within the caller's row rules. |
| Better Auth integration and Workers builds | App owns `auth.ts` and `resolveCaller`; optional [OAuth helpers](oauth.md) provide consent/connected apps, live grant/session checks and DPoP. `mantle generate` emits native Wrangler build configuration. Keep heavy auth imports lazy. |
| Transactional email port, English templates and dev console sender | Optional `@aotter/mantle/email`; app supplies the sender and passes locale through. See [email wiring](email.md). |
| View keyset pages, generated boundary validation and HTTP error mapping | Generated `paged/views/*` and `validation/*` modules plus `wire`; see [surface deltas](surfaces.md). |
| REST and `http` Trigger exposure | Supported generated `rest.ts`; app mounts with `{ db, caller }` and required `handlers` for ref contracts. Public Views page at `/api/views/<name>`; HTTP Triggers keep method/path. |
| Generated MCP and `mcp` Trigger exposure | Public/staff tools, shared generated checks, publishing transitions on staff only; SDK loads on matching requests. Install the official MCP peer for manifests selecting this surface. |
| Dynamic `web.ts` (`llms.txt`, sitemap, `.md` alternates, head tags) | Generated; mount `web({ ... })`; see [surface deltas](surfaces.md#optional-web-output). |
| Admin UI, web skill/example | Planned [#1477](https://github.com/aotter/mantle/issues/1477), [#1478](https://github.com/aotter/mantle/issues/1478). |
| Opt-in `lifecycle: publishing` | Generated status, `published_at`, staff-only transitions and published-only public reads; see [Publishing](#publishing). |
| `ref` Procedures and typed `Handlers` | Generated `Handlers` type; pass implementations at `store(db, caller, { handlers })`; `mantle generate` lists them. See [ref Procedures](contract.md#ref-procedures). |
| Optional site settings and media | Select `site` defaults at generation to emit the generated `site` module and deployment tables; native media upload lifecycle, app-owned R2/signing. See [media](media.md). |
| Published package and release measurements | Planned [#1479](https://github.com/aotter/mantle/issues/1479), [#1480](https://github.com/aotter/mantle/issues/1480). |

Planned means unavailable until its implementation merges: generation currently
rejects schedule and lifecycle Triggers rather than omit behavior; authored
publishing writes stay refused (use the Store and generated transitions).
Use application-owned handlers or operational Schemas in the meantime.

## Refused

Each unsupported declaration produces `GENERATE_UNSUPPORTED`, its manifest path,
and the following hint. Invalid grammar/SQL retains the compiler's own diagnostic
codes and paths. Multiple declarations produce multiple diagnostics.

| Declaration | Do instead |
| --- | --- |
| `schedule` Triggers, including disabled ones | Wire `scheduled()` yourself. |
| `lifecycle` Triggers: before/after hooks, including targets using `ref` | Write a custom handler. |
| `requires.guard` on a View or Procedure | Write a custom handler that checks authorization before executing queries. |
| Schema `localized: true` | Manage locales in application-owned fields and handlers; localization returns in 0.2.x. |
| Schema `translates` | Manage relationships in application-owned fields and handlers; translations return in 0.2.x. |
| A View projecting a native `geo` value | Select the latitude and longitude columns explicitly. |
| Dynamic or repeated View output names | Give each SELECT output a unique explicit alias. |
| Declared date/date-time outputs without one SELECT item per output | Expand the SELECT list explicitly. |
| Input properties differing only in case | Rename input properties to be unique without regard to case. |
| PostgreSQL JSON/date/date-time parameters used without the declared cast | Wrap each occurrence in the concrete `CAST(... AS <type>)` shown by the diagnostic. |

Old service APIs, automatic migrations and boot-time
schema convergence are outside generation; the app owns them. Site/media and email use optional modules. They are not v2
manifest declarations. Store `or`/`not`/joins/subqueries belong in internal SQL
Views; unsupported ordering fails the generated TypeScript contract. See
[query responsibilities](contract.md#revised-query-responsibility-decision-2026-10-11)
and [size/startup gates](size-and-startup.md). Availability is not performance evidence.

### Publishing

Schemas default to `operational`; `lifecycle: publishing` is supported. It adds
status (`draft`, `published`, `archived`), nullable `published_at`, and a
scope-aware `(published_at, id)` index. The timestamp is available to Views and
indexed Store ordering. Store uses `NULLS LAST` and supports a null timestamp
cursor; other indexed ordering columns still require NOT NULL.

Generated `<table>.publish`, `.unpublish`, and `.archive` take
`{ id, expectedVersion }` and require staff/system. Each uses one atomic UPDATE
with scope, TTL, version, source-state and publish-completeness guards. A failed
guard is CONFLICT; the message lists possible guard failures without a racy
second read. Status/timestamp cannot be written through Store. Staff editing
limits belong to Admin, not Store. Public reads always require published rows;
other reads expose drafts only to staff/system, including joins and nested SQL.
Authored inline publishing writes, lifecycle hooks and translations remain refused.

Identity: optional staff directory/role/invitation helpers and the app-owned hardened auth.ts template are supported. OSS staff management uses one role (`staff`); all staff can manage users. Caller roles remain open strings. See [Auth](auth.md).
