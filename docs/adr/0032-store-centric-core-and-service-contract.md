# ADR-0032: Store-centric Core, an application-owned service, and caller identity

**Status:** Proposed for 0.2.0 (#1188). Amends ADR-0014, ADR-0026, ADR-0027 and ADR-0030; storage evolution is decided separately in [ADR-0033](0033-storage-converges-to-the-plan.md). Decisions 1–5, 10 and 13 are amended by [ADR-0034](0034-store-is-authored-as-sql.md): manifests carry SQL, which the CLI compiles to the IR.

**Date:** 2026-09-27

**Related:** #1151 (Store), #1152 (identity), #1156 (table namespace), #1150, #1189, ADR-0022, ADR-0023, ADR-0028, ADR-0031, aotter/mantle-home#201

## Context

`develop` (3b829e6) carries the first Store slices from ADR-0030, but six persistence paths still generate their own SQL: builtin ops (`EntryRepository`), `store.write` (`AtomicEntryWriter`), legacy Views (`SqliteViewCompiler`), select Views (`SqliteStoreQueryCompiler`), `runtime.entries` (`EntryReader`) and the TTL sweep (`sweepExpired`). Scope, TTL, OCC and hook rules are spread across them, and builtin ops, Admin/MCP CRUD, `EntryReader` and legacy Views ignore `Schema.spec.scope`.

The host boundary has the same problem in a different place:

- **Mantle owns the entry.** `createMantleWorker` owns the Worker and hands the application a restricted seam (`extend`, `getRuntime`, `MANTLE_RESERVED_PATH_PREFIXES`, `MantleExtensionApp`).
- **Mantle owns the user.** `0001-init` creates the twelve Better Auth tables on every SQLite database, even without `@aotter/mantle-auth`. `createMantleWorker` requires a full `MantleAuth`, `resolveCaller` calls `getUserRole`, and `mountMantleAdmin` depends on the Better Auth session shape. ChatGPT Sites fakes the Admin methods and hand-mounts Admin.
- **Cloudflare semantics sit in Core contracts.** ADR-0027 Triggers use Cloudflare's cron dialect and put a required `cloudflare` host in the plan; `HandlerContext.schedule` and `waitUntil` are documented as Cloudflare deliveries.

No 0.1.5 has been tagged, and the release is allowed to break grammar, so it ships as 0.2.0.

## Decision

Spec (the four atoms) compiles into a sealed `RuntimePlan`; Core executes it; everything else is built around Core.

```
application-owned service (MantleHandlers + one WinterTC fetch entry)
  └─ Core: Trigger dispatch → View / Procedure → Store → StoreExecutor
                                  └ ref → handlers (the only custom code)
createMantle(service, { storage }) → one fetch; the generated preset wires it into the host's entry
```

### 1. Store is the only path to Mantle-owned entry storage

Every entry read and write goes through `MantleStore` / `CallerStore` over the relational JSON IR of ADR-0030. Policies are **IR rewrites applied before storage**: caller scope (including subqueries), TTL visibility, published-only, and OCC (`lock` becomes a version predicate plus `expect: 1`). Storage implementations compile a dialect and apply atomic batches; nothing else.

- **Contract.** `select`, `view`, `write` and `id` on both types; `as(caller)` and `sweepExpired` on `MantleStore` only. `as` now takes a `Caller` (decision 7), not a `HandlerContext`.
- **Write ops** stay `insert | update | delete`, all or nothing. `StoreInsert` gains `onConflict?: "ignore" | { columns, update }` (#1151). `StoreUpdate` and `StoreDelete` both take any `where`, optional `lock` and optional `expect`.
- **Results.** A row op returns `{ id, version }`; a set op, or an insert ignored by `onConflict`, returns `{ affected }`. `StoreWriteResult` renames `deleted` to `affected`.
- **Errors** stay `DiagnosticError`: `INPUT_VALIDATION_FAILED`, `CONFLICT`, `RESOURCE_UNAVAILABLE`, `OUTCOME_UNKNOWN` (ADR-0023). `Diagnostic` gains `conflict?: { opIndex?: number; reason: "lock" | "expect" | "unique" }`. `opIndex` is best effort, because a D1 batch cannot report which statement failed.
- **Status changes** are `update` with `set: { status }`, validated by one domain service, `LifecycleStateMachine`, which owns drafts, publish, unpublish, archive and published protection. Its tests are ported from the `content-ops` suite before any legacy path is removed.
- **One cursor format.** Cursors are opaque, versioned and bound to `from`, the `orderBy` column and direction. The three formats in use today (`s:`, `st:`, `o:`) are removed.
- **Admin statistics** (`readCreationStatistics`) stay a narrow optional storage capability outside Store. Store does not grow aggregates for one Admin chart.
- **Translations.** Mantle Web resolves a locale with two Store selects (the base rows, then the translation rows for the requested and the site default locale) and merges them; the requested locale wins, then the default. Both reads are Store selects, so scope, TTL and published-only apply to each. `JoinedEntryReader` is removed and no read path grows around Store.

> **Amendment (ADR-0034):** `conflict.opIndex` is exact: count and guard checks inside the batch name their statement.

### 2. Row ops and set ops

A write op's `where` is classified **on the caller's `where`, before any policy rewrite**, so an injected scope predicate never changes the class.

- **Row op:** the top level of `where` pins `id` to one value, alone or ANDed with further conditions (`{ id, performedAt: { gte } }`). It affects at most one row, may carry `lock`, and fires per-row lifecycle hooks. A row op that matches nothing is re-read by id: a present row with another version is `CONFLICT` with reason `lock`; otherwise reason `expect`.
- **Set op:** any other `where`. It fires no hooks. `mantle validate` and Store reject it on a Schema with a per-row `before_*`/`after_*` Trigger for that operation and on a Schema whose published entries are protected.
- `Procedure.target` is inferred with the same rule: a program with exactly one row op whose `where` pins `id` to an input field gets that target; otherwise `target` is explicit, as today.

> **Amendment (ADR-0034):** Row and set ops are classified on the compiled statement, and the class decides only `target` inference and whether writing no row is `CONFLICT`. A set op calls after hooks with its rows; Schemas with a before hook for that operation, or with `publishing` lifecycle, still refuse it.

### 3. Lifecycle hooks and atomicity

- A lifecycle Trigger targets a Procedure whose handler is a `ref`. `mantle validate` rejects an inline Store program as a hook target.
- **`before_*` is a read-only check.** It receives a read-only `CallerStore` (as guard Procedures do today) and no `ctx.invoke`. It allows the mutation by returning and rejects it by throwing; it cannot rewrite the mutation in 0.2.0. A rejection or failure means nothing in the batch is applied: before hooks always fail closed. Hooks for a multi-op batch run in op order, and for one op in Trigger-name order, all before the batch applies. Each sees committed data only, never a sibling op. OCC at apply time still guards the race between the check and the commit. The contract forbids external mutations in a before hook; this limits what Mantle injects, not arbitrary user code.
- **`after_*` runs only after a successful commit.** A rollback emits nothing, a failure never changes the committed result, and a write the hook makes is a new `write` in a new transaction. The hook receives the mutation snapshot (the row and version at commit), not the latest row.
- **Delivery.** `LifecycleTriggerSource.errorPolicy` is removed: before hooks always fail closed, and an after hook cannot change a committed result. After hooks are best effort, as today: they run inline or through `waitUntil`, and `ctx.cause.id` is stable so a handler can deduplicate a replay. Reliable delivery (an outbox written in the same batch, at-least-once) is deferred until a consumer needs it; it is an additive Trigger key.
- **Retries.** External side effects sit outside Store atomicity. A retry after `OUTCOME_UNKNOWN` reconciles through client ids (`store.id()`) and versions: a replayed insert conflicts on its id, a replayed update on its lock.
- **Identity and depth.** Hooks run with the originating `Caller`; deferred deliveries rehydrate it from the event record. `MAX_INVOCATION_DEPTH = 8` counts the `cause` chain across hook chains and `ctx.invoke`; exceeding it fails with `INVOCATION_DEPTH_EXCEEDED`.
- An entitlement check for one action belongs in that Procedure's `requires.guard`. A before hook is for rules every path must obey, Admin, import and maintenance included.
- The Store hands mutations to a `LifecycleDispatcher` port (`before(mutations)`, `after(events)`) that the Trigger layer implements; Store never references Procedures. It replaces `LifecycleHookingEntryRepository`, `RunLifecycleHooksUseCase` and `DeferredHookDispatcher`.

> **Amendment (ADR-0034):** An after hook is called once per statement and Trigger with `ctx.cause.rows`. Before hooks keep row ops and OCC.

### 4. Storage port

`StoreReader` grows into **`StoreExecutor`**: `maxBindings`, `select(query)` and `apply(batch)` over validated IR only. Every executor implements the whole IR and applies a batch atomically, so there are no capability flags; the one Core validator reads `maxBindings` (100 on D1) and removes the duplicated `NATIVE_TYPES`, depth and node checks. `ViewQueryExecutor` shrinks to native SQL Views, the remaining escape hatch.

- `SqliteStoreExecutor` serves D1, Bun and libSQL, so libSQL gains writes.
- `MemoryStoreExecutor` is the reference implementation, the test fake (replacing `test/fakes/in-memory-store.ts`) and the base of the IndexedDB adapter, which keeps its own persistence and concurrency tests.
- `@aotter/mantle/testing` exports one conformance suite that runs against every executor.

The rewrite is built in `next/`, a private package beside the shipped ones (see `next/README.md`), and replaces them at the end.

> **Amendment (ADR-0034):** `SqliteStoreExecutor` is the only executor; `MemoryStoreExecutor` is removed, and so is `ViewQueryExecutor`, since every View compiles to IR. Conformance runs on local D1 inside workerd.

### 5. Grammar is the IR

`API_VERSION` becomes `cms.mantle.aotter.net/v2`, and `RUNTIME_PLAN_VERSION` becomes 6. A v1 manifest fails with the existing apiVersion diagnostic, whose suggestion names `mantle-update`. There is no legacy lowering layer.

- **Procedure handler** is `{ ref: <name> }` or `{ store: [<write ops>] }`. `kind`, `builtin`, `op`, `match` and `BUILTIN_OPS` are removed. Views read; Procedures write, so an inline program holds write ops only. Its output is `{ results }`, the `store.write` results in op order; `mantle validate` checks the declared `output` schema accepts that shape.
- **View** is `spec.select` or `spec.sql`. The top-level `from`/`filter`/`fields`/`orderBy`/`limit`, the Filter AST, `$param`, `{"$ctx.user": "id"}` and `VIEW_PARAMS_RESERVED` are removed. `spec.params` is renamed `spec.input`, matching the `$input` reference.
- **Value references** are one set everywhere: `$input.<path>`, `$ctx.user.id`, `$now` and `{ $literal: <value> }`.
- **Pagination.** REST, MCP and Admin page with `limit` and `cursor` only.
- Staff View `uiSchema.searchFields` and `filterFields` compile to `like` and `eq` conditions.
- A native SQL View may not target a scoped Schema (`VIEW_SQL_SCOPED_SCHEMA`); `VIEW_TTL_NATIVE_UNSAFE` stays.
- **Schedule Triggers** take a five-field POSIX cron in UTC (weekday 0 = Sunday). The plan no longer carries a required host. A service that wires schedules passes `schedules: true` to `createMantle`, and boot fails for any enabled schedule without it. `toCloudflareCron` in `@aotter/mantle/cloudflare` translates an expression for Wrangler.
- **Webhooks.** An HTTP Trigger does not receive the raw request body in 0.2.0. The service owns its HTTP entry (decision 6), so it verifies a signature there and calls `runtime.invokeProcedure`. A raw-body Trigger key is additive and can come later.

> **Amendment (ADR-0034):** The grammar is SQL and the plan is the IR. A View is `spec.sql`, one `SELECT`, and an inline Procedure is `handler: { sql }`; `spec.select`, `{ store }` and the `$`-prefixed value references are replaced by `input.<name>`, `auth.uid()`, `auth.role()` and `now()`. Every View gets scope and TTL injected, so `VIEW_SQL_SCOPED_SCHEMA` and `VIEW_TTL_NATIVE_UNSAFE` are removed.

### 6. The portable unit is an application-owned service

```ts
interface MantleService<Env = unknown> {
  readonly handlers: MantleHandlers<Env>;
  fetch(request: Request, env: Env, context: MantleServiceContext): Response | Promise<Response>;
}
interface MantleServiceContext {
  readonly runtime: MantleRuntime;
  waitUntil(promise: Promise<unknown>): void;
}
```

- `env` stays opaque. HTTP is the service's only Mantle ingress; schedules, deferred hooks, MCP and REST enter through Trigger atoms and surfaces.
- **One host-neutral entry, no per-host adapter.** Once the service is a WinterTC fetch, hosts differ only in the storage driver and in how their native entry is spelled. `@aotter/mantle` exports one function:

  ```ts
  createMantle(service, { storage: (env) => MantleStorageAdapter, schedules?: boolean }): {
    fetch(request: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response>;
    invokeSchedule(cron: string, scheduledTime: number, env: Env, ctx?): Promise<void>;
    runDeferredHook(message: unknown, env: Env, ctx?): Promise<void>;
  }
  ```

  It boots the runtime lazily from `storage(env)`, passes it to `service.fetch`, and turns a schedule or a deferred-hook message into a Trigger invocation. The host's entry is one to three lines of **generated, application-owned** preset code (`export default { fetch: m.fetch, scheduled: (e, env, ctx) => m.invokeSchedule(e.cron, e.scheduledTime, env, ctx) }` on Cloudflare, `Bun.serve({ fetch: m.fetch })` on Bun), so an application adds its own native handlers next to Mantle's and Core absorbs no platform event types.
- `createMantleWorker`, `createBunMantle` and `createVercelMantle` are removed; today `createBunMantle` and `createVercelMantle` are 62-line copies of the same lazy boot. The adapter subpaths keep only what is platform-specific: `@aotter/mantle/cloudflare` the D1 driver, the KV and R2 bindings and `toCloudflareCron`; `@aotter/mantle/bun` the `bun:sqlite` driver; `@aotter/mantle/vercel` the libSQL driver. ChatGPT Sites uses the Cloudflare preset with the custom identity.
- **`--host` is removed** (amends ADR-0026). Whenever the selection needs an entry (anything beyond `spec`, which stays host-free), `mantle generate` emits the Cloudflare preset: the entry above with `scheduled` wired, D1 storage, and the KV and R2 bindings. `host-minimal-worker` and `host-local-admin-otp` are its reference examples.
- **Other hosts are examples and drivers, not generator options.** ChatGPT Sites is the `host-chatgpt-sites` reference: an agent adapts the Cloudflare preset from it (Sites sign-in, R2 media, custom identity). `@aotter/mantle/bun` (`bun:sqlite`) and `@aotter/mantle/vercel` (libSQL) keep their drivers, marked experimental until a maintainer runs them end to end; they get no preset and no promised example. On any host, a capability the entry does not wire (schedules, for example) is refused at boot with a diagnostic, never skipped silently, and the author's coding agent bridges it.
- `BootMantleRuntimeArgs.supportsScheduledTriggers` becomes the `schedules` option above.
- Removed: `MANTLE_RESERVED_PATH_PREFIXES`, `MantleExtensionApp`, `extend`, `extend.mount` and `getRuntime`. `mantle generate` emits the standard composition as application-owned source: `src/service.ts`, `src/handlers.ts` and the host entry.

### 7. Handlers, invocation and capabilities

- The codegen `MantleHandlers` type lists exactly the plan's refs. `mantle validate` and boot check both directions: a plan ref without a handler is `HANDLER_NOT_REGISTERED` (existing), a handler the plan does not declare is `HANDLER_NOT_DECLARED`.
- A handler receives only `(input, ctx)`. The serializable part is an **`Invocation`**: `{ procedure, input, caller, cause }`. Every source (HTTP, MCP, schedule, lifecycle, internal) produces one, and `runtime.invokeProcedure(invocation)` runs auth → guard → input → handler → output for all of them. Only an `Invocation` ever crosses a wire.
- `HandlerContext` is `{ caller, cause, env, waitUntil, store, invoke }`. `user`, `staff`, `auth`, `event` and `schedule` are removed.
- **`InvocationCause`** is `{ kind: "http" | "mcp" | "schedule" | "lifecycle" | "internal", id, parent? }` plus kind-specific facts: `trigger`, `cron` and `scheduledTime` for schedules; `trigger`, `hook`, `schema` and the mutation snapshot for lifecycle. `id` is stable across retries.
- **`ctx.invoke(procedure, input)`** is the one Procedure-to-Procedure entry. It keeps the caller, chains `cause.parent`, and re-runs the target's auth and guard. There is no `getRuntime` closure.

### 8. Mantle never owns the user or the auth

A service keeps its existing users and auth. `@aotter/mantle/auth` is one optional producer of the caller identity.

- **`Caller`** (in `@aotter/mantle`) replaces `HandlerContext.user`, `.staff` and `.auth`:

  ```ts
  type Caller =
    | { readonly kind: "anonymous" }
    | { readonly kind: "user"; readonly subject: string; readonly issuer?: string;
        readonly role: StaffRole | null; readonly scopes: readonly string[];
        readonly credential: CredentialKind; readonly credentialId: string | null; readonly clientId: string | null }
    | { readonly kind: "system"; readonly reason: string };
  ```

- **Subject key.** `subject` is the application subject key: opaque, stable and unique within the service across every issuer. The resolver owns that uniqueness (mantle-auth uses its user row id; a resolver over several IdPs namespaces the id). `issuer` is informational. `$ctx.user.id`, `scope.ownerId` and `authorId` store the subject key, with no foreign key into any users table. Identity is never keyed by email.
- **One authentication boundary.** The service's entry resolves the caller once per request with a **`CallerResolver`**: `(request) => Promise<{ caller: Caller } | { invalid: true; challenge?: string }>`. An invalid credential is answered 401 before any surface runs and is never treated as anonymous. Only "no credential presented" is anonymous. Roles are resolved inside the resolver on every request.
- **Predicates.** `requires.auth` evaluates against the `Caller` only; the grammar is unchanged. `ctx.user` and `ctx.auth` require a user caller, `ctx.staff` a role in the list, `ctx.auth.scope` a scope. `STAFF_ROLES` is Admin's vocabulary: a custom resolver maps its own roles onto it or leaves `role` null and uses scopes and guards.
- **System caller.** `systemCaller(reason)` is exported for host code only; no wire can produce one. It satisfies no `requires.auth` predicate (so schedule targets still declare none, as ADR-0027) and bypasses caller scope and nothing else: lifecycle rules and TTL visibility apply, and expired rows are visible only to `sweepExpired`. Schedules and maintenance run as the system caller.
- **Policy origins.** Scope comes from the caller; published-only from the surface or atom (a public View over a publishing Schema); TTL and lifecycle always apply. `runtime.store` is host-level and unscoped, `runtime.store.as(caller)` binds per request, and `ctx.store` arrives bound.
- **Admin facets.** `@aotter/mantle/admin` defines `AdminIdentity`, whose members are all optional: `directory` (`getUser`, `listUsers`, `listMembers`), `roles` (`setUserRole`, `inviteUser`, `revokeInvite`, `sendStaffInvitation`) and `deleteUser`. Admin hides what is absent. Display names come from `directory`, never from a Store join.
- **mantle-auth** implements `CallerResolver`, `AdminIdentity` and the optional OAuth server routes. Account deletion is its `deleteUser` facet, so services stop running raw SQL against auth tables; a custom provider owns deletion for its own users. The MCP surface verifies nothing: it takes `authorizationServer` (a URL) for its 401 challenge and protected-resource metadata.
- **Core creates no auth tables.** The twelve Better Auth `CREATE`s and their indexes are removed from `0001-init`, which keeps its id, so migrated databases are unchanged. mantle-auth already migrates its own schema through Better Auth's `getMigrations`; that becomes the only source of auth DDL, and Core stops carrying a copy. mantle-auth refuses to start when an auth table name belongs to a Schema.
- **No identity** (anonymous callers only, no auth package, no auth tables) works and is tested. It is an explicit choice, never the default.
- **Existing services.** Mantle is added to a running service; it does not replace it. The service keeps its entry, users, auth, tables, routes and SSR. Mantle adds `_mantle_*` system tables, the Schemas it declares, and the product tables of the modules it selects. Data the service wants Mantle to manage (Admin, MCP, Store) moves into a Schema, one table at a time, by the data owner's choice. #1102's consumer skill carries that path.

### 9. Surfaces are Fetch functions

A surface is `(request: Request, caller: Caller) => Promise<Response>`, created with its base path:

| Surface | Factory | Package |
|---|---|---|
| MCP | `createMcpSurface(runtime, { basePath, authorizationServer? })` | `@aotter/mantle/mcp` |
| Admin | `createAdminSurface(runtime, { basePath, identity?, assets })` | `@aotter/mantle/admin` |
| REST Views | `createRestSurface(runtime, { basePath })` | `@aotter/mantle/web` |
| Web | `createWebSurface(runtime, { basePath, ... })` | `@aotter/mantle/web` |

Admin UI assets honour the base path. Hono may stay inside a package; it is no longer in any public signature. Mantle Web and Admin read through Store, and `EntryReader` is removed. A typed client for custom frontends is deferred; it is additive. The `@aotter/mantle/admin-ui/kit` re-export and `rowBindings` are removed (#1140).

### 10. Cloud verifies the plan; the user owns the entry

- `semanticFingerprint` becomes SHA-256; it now crosses a trust boundary, which its `ponytail:` comment named as the upgrade point. It is the "compiled plan fingerprint" aotter/mantle-home#201 records.
- `createMantleRuntime` accepts `expectedFingerprint` and refuses to boot on a mismatch (`PLAN_FINGERPRINT_MISMATCH`).
- `runtime.bootReport()` returns `MantleBootReport`: `{ fingerprint, coreVersion }`. Handler refs need no report because boot already refuses a mismatch; schedules are in the plan.
- Cloud's guarantee names two kinds of fact. **Platform-verified:** the Cloud-compiled plan, the pinned Core, storage matching the plan (ADR-0033) and the fingerprint handshake. **Service-reported:** the surfaces and mounts the service chose, which Cloud confirms only by probing them in smoke. A service that never boots the runtime has no manifest scope to guarantee, and smoke shows that.
- The plugin's Cloud helper script (decision 13) distinguishes a handlers-only artifact (today's closed module, host protocol 2 per ADR-0031) from a service-entry artifact, which is closed except for `@aotter/mantle*` externals that Cloud supplies at the pinned Core. The artifact field is `artifactKind: "handlers" | "service"`; service entries use host protocol 3. aotter/mantle-home reserves the field now and accepts service entries after Core 0.2.0, as its own issue.

> **Amendment (ADR-0034):** The guarantee is a Cloud-validated plan. The CLI compiles; Cloud validates the IR and never parses SQL; whether the IR matches its SQL source is service-reported. Host protocol 3 uploads the plan.

### 11. Table namespace

Tables that start with `_mantle_` are system tables: Mantle's internal state (the ledger, boot, Schema registry, schedule runs). They are Mantle's alone and the service does not touch them. Every other table Mantle or a Mantle module creates is a **product table** and keeps its name, just as Better Auth's tables keep theirs: `site_config`, `media_assets` and `pending_media_uploads` from Core, and Better Auth's own tables from mantle-auth. #1156 is decided by this rule: no rename. `sites_users` leaves `RESERVED_TABLES`, since ChatGPT Sites' identity is application-owned.

A product table that already exists without the ledger record of the Mantle migration that creates it is someone else's table: Core refuses to boot (`STORAGE_TABLE_NOT_OWNED`) instead of reading and writing it. mantle-auth applies the same rule to `user` and the other Better Auth tables.

### 12. `mantle generate` and identity

- With no `--features`, generate emits the full preset, including mantle-auth, which creates and owns its tables.
- `--features` stays a positive replacement list (ADR-0026). `mantle.config.json` and the CLI gain `identity: "mantle" | "custom" | "none"`, and identity is part of the positive selection: an explicit `--features` without `--identity` means `none`, and a selected feature that needs a caller identity (`admin`) then fails with the dependency diagnostic below. `custom` emits an application-owned `src/identity.ts` implementing `CallerResolver`.
- **Amends ADR-0026:** dependencies are no longer closed automatically. A missing dependency fails with `GENERATE_FEATURE_DEPENDENCY_MISSING`, and an omitted module is never re-added.
- Switching `identity` on a rerun is refused and never drops tables.
- Acceptance: the default works with users and auth whose tables mantle-auth owns; `custom` keeps the service's users and adds no auth tables; an explicit public service with `none` adds no auth package or tables; a valid positive selection generates, and a missing dependency is refused with a diagnostic.

### 13. Two npm packages and one plugin

Every Mantle package versions and releases together, so splitting by area buys nothing and costs a publish, a peer and a pin per package. 0.2.0 publishes two packages, split where the dependencies, the build and the audience actually differ: server and browser.

| Package | Contents |
|---|---|
| `@aotter/mantle` | Core at the root (Store, `createMantle`, `createMantleRuntime`); subpaths `/spec`, `/testing`, `/cloudflare`, `/bun`, `/vercel`, `/indexeddb`, `/auth`, `/admin`, `/mcp`, `/web`; the `mantle` CLI |
| `@aotter/mantle-ui` | `/controller`, `/kit` (including the sign-in card a service's own frontend can reuse), `/mcp-app`, and the prebuilt Admin SPA at `/admin` |

- Platform and heavy libraries (`better-auth`, `hono`, `@libsql/client`, the MCP SDK, React) are optional peers. A subpath that is not imported is never loaded, so Core still requires no Admin, Web, Auth or platform code; `check:boundaries` enforces this at module level instead of package level (amends ADR-0019's optional-package boundary).
- `@aotter/mantle` never imports `@aotter/mantle-ui`. The generated preset passes the Admin assets from `@aotter/mantle-ui/admin` to `createAdminSurface`.
- `@aotter/mantle-spec`, `-runtime`, `-cloudflare`, `-bun`, `-vercel`, `-indexeddb`, `-auth`, `-admin`, `-mcp` and `-web` fold into subpaths; `@aotter/mantle-admin-ui` folds into `@aotter/mantle-ui/admin`. `@aotter/mantle-host` was never published and is removed.
- **The plugin** (this repository's agent plugin) ships one `mantle` skill and helper scripts. Its configuration carries the Mantle Cloud MCP endpoint as an absolute URL, `https://cloud.mantle.tools/mcp`; aotter/mantle-home provides only that MCP. The helper scripts (`.mjs`) orchestrate the Cloud MCP sequence so an agent does less by hand, and keep the upload rules whose artifact bytes depend on the Core version (ADR-0031). The `mantle-host` name disappears; ADR-0031's protocol is the host protocol. Deploying anywhere else uses that host's own CLI, and the skill states that the user may always self-host: Mantle Cloud is one option, never a requirement.

> **Amendment (ADR-0034):** `/indexeddb` is removed, with no browser driver in 0.2.0. D1 test helpers live at `/cloudflare/testing`. The plugin's helper scripts compile with the project's installed `@aotter/mantle/spec` and bundle no parser.

## Conformance cases

The three contracts #1188 made ADR gates are accepted only with these cases, run against every `StoreExecutor` and the lifecycle layer:

1. **Atomicity and hooks.** A hook target with an inline program is rejected. A before hook has no write and no `invoke`; its rejection applies nothing in the batch. A concurrent write between a before check and the commit fails on OCC. A rollback emits no after event. An after-hook failure leaves the committed result. A replayed after event carries the same `ctx.cause.id`.
2. **Row-op classification.** `{ id }` and `{ id, performedAt: { gte } }` are row ops; `{ ownerId }` is a set op; a caller-scoped rewrite of `{ id }` stays a row op; `Procedure.target` inference agrees with Store in every case.
3. **Caller identity.** Two callers with the same upstream id from different issuers cannot read each other's scoped rows. An invalid credential is 401, never anonymous. The system caller bypasses scope but not TTL or lifecycle. A no-identity service boots with no auth package and no auth tables.

## Consequences

- **Net deletion** of about 3,200 lines: `DatabaseEntryRepository`, `LifecycleHookingEntryRepository`, `InvokeBuiltinUseCase`, `BuiltinProjector`, the content use cases and `AtomicEntryWriteUseCase`; the `EntryRepository`, `EntryReader`, `AtomicEntryWriter` and `ExpirySweeper` ports; the declarative part of `SqliteViewCompiler`; `IndexedDbEntryRepository` and `IndexedDbViewQueryExecutor`; `page`/`show`; the in-memory test fake; the twelve auth `CREATE`s in `0001-init`.
- **Breaking for every consumer:** grammar, the handler API, Worker composition and the pagination wire. The release ships the `mantle-update` codemod (builtin handlers to inline programs, Filter AST to `select`, `params` to `input`, `page`/`show` to `limit`/`cursor`, `extend` to the service preset) and old-to-new tables.
- **Main risk: lifecycle semantics.** They move into `LifecycleStateMachine` with their tests ported first.
- Cloud's promise changes from "Admin at /admin" to "the surfaces you declare work at the mounts you declare".
- A service with working users and auth keeps them. Fresh databases without mantle-auth get no auth tables; databases that have them are left alone.

## Alternatives

- **A legacy-lowering layer** that compiles builtin ops and the Filter AST into IR without a grammar change. Rejected: it keeps the code this release deletes.
- **A Worker-shaped artifact.** Rejected: it leaks the Worker name, the `fetch`/`scheduled`/`queue` export shape and `cloudflare:workers` into a host-agnostic contract.
- **One npm package per area** (today's fourteen). Rejected: they version together, so each split adds a publish, a peer and a pin without independent releases.
- **One adapter factory per host** (`createMantleWorker`, `createBunMantle`, `createVercelMantle`, each taking the service). Rejected: with a WinterTC service they would differ only in the storage driver and a few lines of entry spelling, which the driver package and the generated preset already carry.
- **A handler-host port with remote execution.** Deferred: the service already is the host. The serializable `Invocation` keeps remote execution possible.
- **Keeping a Mantle-owned Worker with extension seams.** Rejected: it limits custom frontends, SSR and webhooks, and duplicates Cloud-only assembly.
- **An identity port in Runtime, or auth tables in Core.** Rejected in #1152: Core only ever sees a resolved `Caller`.
- **Prefixing every Mantle-created table** (#1156). Rejected: the prefix marks system tables. Product tables follow the same rule as Better Auth's, and the ownership check in decision 11 covers the collision risk without a rename migration for live sessions and tokens.
- **Moving the Core auth DDL into mantle-auth as `mantle-auth:0001`** (#1152). Rejected: mantle-auth already derives it from Better Auth's own `getMigrations`, so a copy would be a second source of truth.
- **`errorPolicy: continue` on before hooks.** Removed: a before hook that fails open is an unchecked rule.

## How to apply

1. Land this ADR and ADR-0033, then build in this order: the three conformance contracts; Store and cross-executor conformance; cut every legacy path over and delete it; service, surfaces and identity; Cloud service-entry artifacts. Vercel and IndexedDB completion may trail.
2. **Keep proven host integrations as maintained examples, not Core contracts.** Core models no host's delivery workflow, but a working integration saves the next user the search. The reference examples of decision 6 are ported to the 0.2.0 contracts and rechecked when their host changes. For ChatGPT Sites that means Sites sign-in mapped to a `CallerResolver` and an `AdminIdentity` over `sites_users` ([`chatgpt-auth.ts`](../examples/host-chatgpt-sites/src/chatgpt-auth.ts), whose `chatgpt:<sub>` id is already a namespaced subject key) and R2 behind the `MediaStorage` port ([`media.ts`](../examples/host-chatgpt-sites/src/media.ts)).
3. New code uses only the identifiers named here. A new public name needs an amendment to this ADR.
4. `mantle validate` diagnostics listed here are added with the grammar slice; the runtime codes with the Store and invocation slices.

## Amendments

- **2026-09-30, plan presentation metadata.** The sealed plan carries what Admin and the MCP surface show, as optional fields copied unchanged from the manifests: `PlanSchema.name` (the declared name; the map key is lower case), `title`, `description`, `uiSchema`, `localized`; `PlanView` and `PlanProcedure` gain `uiSchema` (and `title`, `description`). They change the fingerprint and nothing else: no Store, storage or policy behavior reads them. Without them `createAdminSurface` could not name a collection, and a tool would have no description.
- **2026-09-30, MCP tools come from Views and Procedures only.** `createMcpSurface(runtime, { basePath, surface, resourceMetadata?, apps? })` lists a tool for each Procedure bound by an `mcp` Trigger of its surface and each View of its surface; a Schema is never a tool. `store.view` checks the call's input against the View's input schema, as `invokeProcedure` does for a Procedure.
- **2026-09-30, site config and media.** Core's product tables are one optional runtime capability. `sqliteStorage(driver, { site })` and `d1Storage(db, { site })` take the service's `SiteDefaults`. With them, boot runs the canonical migrations and seeds or syncs `site_config`, the prepared storage returns it as `PreparedMantleStorage.site`, and the runtime carries it as `runtime.site: MantleSite`. Without them, the tables are not created and `runtime.site` is absent.
  - `MantleSite` has `read()`, `updateSettings(SiteSettings)` and `media(storage: MediaStorage): MediaLibrary`.
  - `MediaStorage` is the port with `createUpload`, `commitUpload` and `deleteObject`, which uses `MediaAsset`, `MediaVariant` and `MediaVariantRole`. `r2MediaStorage({ bucket, signer, endpoint, publicBase })` in `@aotter/mantle/cloudflare` implements it. `R2MediaStorageOptions` is its option type, and the host supplies the S3 signer.
  - A `Migration` may name the product `tables` it creates. If one of those tables exists without the migration's ledger row, boot stops with `STORAGE_TABLE_NOT_OWNED`, as decision 11 says.
  - The migration ids and DDL are 0.1.x's (`0001-init`, `0002-media-assets`, `0003-pending-media-uploads`). Ownership is proven by next's own `_mantle_migrations` ledger. Upgrading a 0.1.x database in place is a separate step that is not built yet: its legacy `_migrations` ledger is not backfilled, and its `_mantle_boot_state` has another shape.
  - Hazard: a new migration id must not be purely numeric like `0004-…`, because 0.1.x ledgers already hold ids of that form.
  - Uploads go to an upload-only key. Commit checks each object's type and size through the storage itself, then publishes it under a key that no upload URL reaches. A rejected group's objects are deleted.
  - `createAdminSurface` gains `site?: { mcpEndpoints? }` and `media?: MediaStorage`. Without both `media` and `runtime.site`, every media route answers 501 `MEDIA_NOT_CONFIGURED`. Without `runtime.site`, `/site-settings` does not exist.
  - `/site` drops the deprecated `mcpUrl` alias, and `mcpEndpoints` defaults to `null`, not `/mcp` and `/mcp/staff`. Both are deliberate: the service decides which surfaces it mounts.
  - Per decision 11, `sites_users` leaves `RESERVED_TABLES`.
- **2026-09-30, staff MCP in Admin, the tool catalog, and the auth routes.**
  - `mcpTools(plan, surface, locale?)` returns the `McpTool` list (name, title, description, inputSchema, outputSchema, annotations, `requires`, and the `kind` and `source` Procedure or View it comes from). `createMcpSurface` registers these, hides app-only tools from a client without UI support, and returns an `McpSurface`: the `Surface` plus the `tools` it registers for such a client, in its locale. It lives in `@aotter/mantle/spec` rather than `/mcp`, because `/admin` may not import `/mcp`: `check:boundaries` gives the MCP SDK one owner folder, and `/admin` reaches only `core` and `spec`.
  - `createAdminSurface` gains `staffMcp?: McpSurface`, which the service builds with `createMcpSurface(runtime, { basePath: "{basePath}/api/mcp", surface: "staff" })`. Admin answers it at `{basePath}/api/mcp`, for any method, after Admin's own gate (session only, staff role). With it, `GET {basePath}/api/webmcp` returns `{ tools, routes }`, and bootstrap carries the same object as `webmcp` (null without it). `tools` is the projection of `staffMcp.tools` that `tools/list` returns, so locale and apps agree; nothing recomputes the catalog. `routes` maps a tool to `{basePath}/c/<target Schema>` (`entry: true`) when its Procedure declares `target`, and to `{basePath}/views/<name>` for a View. Any other tool has no route. An MCP client with a token uses a separate mount, `withCaller(resolver, createMcpSurface(runtime, { basePath: "/mcp/staff", surface: "staff", resourceMetadata }), { resourceMetadata })`, and that surface's own staff gate. `@better-auth/mcp` serves protected-resource metadata for the single `mcpResource` only, so `/mcp/staff` shares that audience and its `resourceMetadata` is the `/mcp` metadata URL (`/.well-known/oauth-protected-resource/mcp`), never a derived `/mcp/staff` one.
  - `GET {basePath}/api/developer-console` is owner only. It returns `dataModel` (schemas, and non-internal Views with their IR as `sql: { grammar, stmts }`), `logic` (Procedures with `handler` as `{ ref }` or `{ sql }` IR, and triggers) and `operations`. `operations` holds `schedules` (`registration: "not-observed"`), `ttlPolicies` (`sweepObservation: "unavailable"`), `observationAvailability: "unavailable"` and empty `runs` and `latestRuns`: 0.2.0 has no run observation store. The 0.1 `graph` and `interfaces` projections are dropped; the console draws from the IR (ADR-0034).
  - `GET {basePath}/api/collections/{name}/statistics` answers 404 for an unknown collection and 501 otherwise, with the wire code `STATISTICS_UNAVAILABLE` (not a `DiagnosticCode`), until a storage offers the decision 1 capability.
  - `createAuthRoutes(auth: AuthRoutesAuth, options: AuthRoutesOptions)` (`{ resolver, connectedAppsPage? }`) in `@aotter/mantle/auth` is the service's auth entry. It returns `(request, context?) => Promise<Response | null>`, which is `null` for a path it does not own.
    - It answers `GET {auth.basePath}/methods` itself.
    - It hands the rest of `{auth.basePath}/*`, `/.well-known/oauth-authorization-server/*` and `/.well-known/oauth-protected-resource[/*]` to `auth.handler` without resolving a caller. Better Auth serves both metadata documents natively (`oauthProvider` and `@better-auth/mcp`), so Mantle writes none; the protected-resource document exists for the one `mcpResource`, at `/.well-known/oauth-protected-resource` and that resource's path.
    - It runs `/oauth/consent[/data]` and `/oauth/consents[/data|/revoke]` behind `withCaller(resolver, …)`, so a cross-site session POST is refused there. Only a `session` credential may read, give or revoke a consent. The consent redirect is only what `completeOAuthConsent` returns, and one that does not parse, or is `javascript:`, `data:`, `vbscript:` or `blob:`, is 400.
    - Admin is an optional subpath (decision 13), so `GET /oauth/consent` and `GET /oauth/consents` answer plain HTML pages. With Admin, `oauthProvider.consentPage` points at Admin's page, and `connectedAppsPage` redirects the list there.
- **2026-09-30, `mantle generate`, the plan file and the generated module** (decisions 6, 7, 12 and 13; ADR-0033 decision 3; ADR-0034 decision 7).
  - **The bin.** `@aotter/mantle` declares one bin, `mantle` (`src/cli/main.ts`). Its commands are `generate` (with `--check`) and the manifest commands `validate`, `introspect`, `emit-openapi` and `emit-types`. `mantle-update` is a separate bin, added with the codemod. The entry is TypeScript, so the bin runs only once the swap builds the package; until then `runGenerate` is what tests exercise.
  - **`mantle generate [--manifests <dir>] [--features <list>] [--identity <kind>]`.**
    - It reads every `.yaml` and `.yml` file directly in the manifest directory (default `./manifests`) and runs parse, validate and `compileLinkedPlan`.
    - It writes `.mantle/generated/plan.json` and `.mantle/generated/mantle.ts`, and writes `mantle.config.json` at the project root when the selection changes. It refuses (exit 2) to write through a symlinked `.mantle` or `.mantle/generated`.
    - It reads only files, so a directory named `x.yaml` is not a manifest, and it names the manifest directory as it was given, never by its absolute path.
    - It writes no application-owned file yet, so an existing application keeps its own entry. The service preset (`src/service.ts`, the host entry) is a later step.
  - **`plan.json`** is the one copy of the plan: `{ "sourceHash": <hex>, "plan": <RuntimePlan> }` as `compileLinkedPlan` returns it, with two-space indentation and a trailing newline. Its key order is deterministic, so identical input gives identical bytes, and it is not sorted: a JSON Schema's `properties` keep the order Admin and MCP show.
    - `sourceHash` is ADR-0034 decision 7's source hash. It is the SHA-256 of the JSON array `[[name, text], …]` of the manifest files, sorted by file name, so the project's location never enters it. A text loses a leading BOM and has CRLF read as LF first, so a Windows checkout is the same source; `--check` compares generated files the same way. Host protocol 3 uploads this file.
    - The hash sits beside the plan, not in it, so it is **not part of the fingerprint**. Reformatting a manifest changes `sourceHash`, but not the fingerprint Cloud and boot compare.
  - **`mantle.ts`** imports `./plan.json` (`with { type: "json" }`) and exports:
    - `plan` (the `RuntimePlan`, for `createMantle`) and `sourceHash`;
    - the `emit-types` namespace `Mantle`;
    - `Schemas`, `Views`, `ViewOptions` (`limit`, `cursor` and the View's `input`, required when the View requires any), and `Store` and `CallerStore` typed over them. `select` has one overload per Schema, and an insert's `values` or an update's `set` never names the scope field, which Store fills (ADR-0034 decision 8), or a native column. On a `publishing` Schema an insert is a draft, so its `values` are all optional, and an update's `set` may instead be `{ status: ContentState }` alone;
    - `Handler<I, O, Env>`, whose `ctx.store` is that `CallerStore`, and `MantleHandlers<Env>`. `MantleHandlers` has exactly the plan's refs, so a missing or an extra handler is a `tsc` error; a plan without refs takes no handler. It stays assignable to Core's `MantleService.handlers` without a cast. Known limit: an extra ref is a `tsc` error only in an object literal typed as `MantleHandlers`; boot's `HANDLER_NOT_DECLARED` catches the rest.

    `mantle.ts` imports only types, from `@aotter/mantle` and `@aotter/mantle/spec`.
  - **`ViewRow_<name>`.**
    - `viewOutputs(view, schemas)` in `@aotter/mantle/spec` reads a compiled `SELECT`'s outputs: an output's `AS` name, else its column's name, and `*` as the Schema's declared fields without the scope field. `compilePlan` records the outputs that read a Schema field unchanged as `PlanView.columns` (`{ <output>: { schema, field } }`, which changes the fingerprint).
    - **`store.view` decodes those columns as `store.select` does** (booleans, JSON, timestamps, dates, numerics) and names an output that is the field's own name as declared (`e.startsAt AS startsAt` comes back as `startsAt`); another alias keeps its own name. An expression (`e.title || '!'`) keeps the storage encoding. Before this, every View row came back in the storage encoding with lower-case keys.
    - The row type gives such a column its field's type, as `NonNullable<Entry_<schema>[<field>]> | null`, and any other output `unknown`. The row is `unknown` when an output has no name, or a `*` reads a subquery or `json_each`.
    - `emitTypesFromManifests` gains the option `rows` (View name to row type), which the generator passes. `mantle emit-types` has no plan, so its rows stay `unknown`.
  - **`mantle.config.json` v2** is `{ "version": 2, "identity": "mantle" | "custom" | "none", "features": [...] }`. `host` and `output` are removed. `features` is a subset of `mcp`, `admin`, `web`, in that order.
    - `mcp` needs `@modelcontextprotocol/server` and `@modelcontextprotocol/ext-apps`.
    - `admin` needs `@aotter/mantle-ui`, for the Admin SPA, and an identity other than `none`.
    - `web` is `@aotter/mantle/web`. It needs no peer and today serves `createRestSurface`; `createWebSurface` is not ported yet.
    - Identity `mantle` needs `better-auth`, `@better-auth/oauth-provider`, `@better-auth/mcp` and `@better-auth/cimd`, the packages `@aotter/mantle/auth` imports. Every selection needs `@aotter/mantle`.

    Without a config or flags, the selection is identity `mantle` and every feature. An explicit `--features` without `--identity` means `none` (decision 12). A rerun keeps the saved identity, and asking for another one is refused (exit 2), never a table drop. A changed `--features` rewrites the config. The config is rewritten only when the selection (identity or features) changes, and keeps any other key it holds; a config with the same selection in another layout is not stale. A config that is not JSON, or not a JSON object, fails with exit 2 and names the file.
  - **`GENERATE_FEATURE_DEPENDENCY_MISSING`** (validate phase) is raised for:
    - a selected feature or identity whose package is not installed, found as `node_modules/<name>/package.json` from the project root upward (under Yarn PnP, by Node's resolution; elsewhere Node's resolution is not used, since it also follows `NODE_PATH`, which a bundler does not);
    - `admin` with identity `none`.

    The message carries the exact install command, chosen by the lockfile in the nearest directory that has one: `pnpm add`, `yarn add`, `bun add` or `npm install`. Generate fails before it writes anything. It never installs, never edits `package.json`, and never adds a feature back (amends ADR-0026).
  - **`SCHEMA_NAME_CASE_COLLISION` and `FIELD_NAME_CASE_COLLISION`** (validate phase, in the graph validator, so `compilePlan` raises them too): two Schemas, or two fields of one Schema, whose names differ only by case. SQL resolves identifiers case-insensitively and the plan keys both by the lower-case name, so they would otherwise become one table or one column.
  - **0.1.x input.** A `cms.mantle.aotter.net/v1` manifest fails with the parser's apiVersion diagnostic. A `mantle.config.json` with `version: 1` or a `host` fails with exit 2. Both messages name `mantle-update`.
  - **`mantle generate --check [--database <file>]`** writes nothing. It exits 1 when `plan.json`, `mantle.ts` or `mantle.config.json` differs from what generate would write, or a dependency is missing.
    - With `--database`, it also reads that database. The file is a SQLite file, such as Wrangler's local D1 under `.wrangler/state/v3/d1/`, opened read-only with `node:sqlite`, verified on Node 22.14 (it prints Node's experimental warning there). Node 22's `node:sqlite` binds only anonymous `?`, so the CLI's driver rewrites Core's numbered `?N` in order.
    - The result comes from `planStorageChanges(driver, schemas, { fingerprint })` in Core's storage module, which shares convergence's one `diff` and applies nothing, and returns `{ skipped, sql, blocked, undeclared }`. `skipped` is a database that already booted this fingerprint, where boot applies nothing, and the check says so. Otherwise it prints the SQL: the system DDL (`IF NOT EXISTS`, only where Mantle never booted) and the Schema changes, with binds inlined as literals, so the SQL replays; or "nothing to do". The fingerprint and time zone rows are left to boot.
    - Undeclared differences are printed as comments. A blocked difference is printed instead of any SQL and fails the check with exit 1. A database that cannot be read (missing, corrupt, locked, a directory) fails with exit 2 as `--database <file>: <reason>`.
    - Without `--database`, no database is read. ADR-0034 decision 6's "`node:sqlite` is not used" concerns the storage test line, and still holds.

## Implementation status

Proposed. Nothing in decisions 1–13 is implemented beyond the ADR-0030 slices already on `develop`.
