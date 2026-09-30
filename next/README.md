# `next/`: the Mantle 0.2.0 construction zone

0.2.0 (ADR-0032, ADR-0033) is built here as one private package, next to the shipped ones. Nothing under `packages/` changes while this is built, so `develop` can still ship 0.1.x fixes. At the end, `next/` becomes `@aotter/mantle` in one change.

## Layout

`next/` is a single private package, `@aotter/mantle-next` until the swap (the workspace already has `@aotter/mantle`). Areas are folders, and each folder is one subpath (ADR-0032 decision 13):

```
next/src/core/         → @aotter/mantle            next/src/auth/    → @aotter/mantle/auth
next/src/spec/         → @aotter/mantle/spec       next/src/admin/   → @aotter/mantle/admin
next/src/testing/      → @aotter/mantle/testing    next/src/mcp/     → @aotter/mantle/mcp
next/src/cloudflare/   → @aotter/mantle/cloudflare next/src/web/     → @aotter/mantle/web
next/src/bun/          → @aotter/mantle/bun        next/src/cli/     → bin: mantle
next/src/vercel/       → @aotter/mantle/vercel     next/src/d1/      → @aotter/mantle/d1 (and /d1/compile)
```

`core` imports only `spec` and holds no engine code: SQLite lives in `d1`, the built-in dialect (ADR-0035). No folder imports `admin`, `web`, `auth` or a platform folder unless it is one of them. `check:boundaries` enforces this. The browser package, `@aotter/mantle-ui`, stays in `packages/mantle-ui` and absorbs `mantle-admin-ui` at the swap.

## Rules

- `next/` depends only on external libraries and never imports `packages/*`. Code that carries over is **copied** and then changed, so the old package stays intact until the swap.
- Every public name comes from ADR-0032 or ADR-0033. A new one needs an ADR amendment first.
- Old tests are the source of the contract. A rule is ported as a failing conformance case before the code that satisfies it is written.
- Each step below is one reviewed PR, with a Whiteboard.

## Steps

| Step | Output | Review focus |
|---|---|---|
| 0 | This scope map | Is the scope right? |
| 1 | `next/src/spec`: the manifest grammar with Store authored as SQL, `compilePlan` (SQL to IR, ADR-0034), the validator; example manifests as fixtures | The grammar and the SQL subset |
| 2 | `next/src/core`: interfaces only (Store, StoreExecutor, Caller, Invocation, HandlerContext, MantleService, `createMantle`, surface signatures), plus the conformance suite as listed, unimplemented cases | **Architecture and method definitions: the main gate** |
| 3 | Implementation against the contract: SqliteStoreExecutor (the only executor, ADR-0034), then the ported drivers, auth and surfaces | PRs, not every line |
| 4 | Delete the old packages, move `next/` to `packages/mantle`, fold `mantle-admin-ui` into `mantle-ui`, move the plugin's helper scripts, ship the `mantle-update` codemod | The swap |

## Package map

**Rewrite**: new design, written fresh against the ADRs. **Port**: existing, proven logic copied and moved onto the new interfaces. **Delete**: removed with no replacement, or replaced by something listed under Rewrite.

| Today (npm) | 0.2.0 | Action |
|---|---|---|
| `@aotter/mantle-spec` (9.0k src) | `next/src/spec` | Rewrite the grammar; port the checkers and the tooling |
| `@aotter/mantle-runtime` (13.6k) | `next/src/core` | Rewrite Store, invocation and identity; port the rest |
| `@aotter/mantle-cloudflare` (4.1k) | `next/src/cloudflare` | Port the bindings and driver; delete the Worker composition |
| `@aotter/mantle-bun` (0.1k) | `next/src/bun` | Port the driver only; experimental |
| `@aotter/mantle-vercel` (0.1k) | `next/src/vercel` | Port the driver only; experimental |
| `@aotter/mantle-indexeddb` (0.7k) | none | Delete: one SQLite executor, tested on workerd and local D1 (ADR-0034) |
| `@aotter/mantle-auth` (2.4k) | `next/src/auth` | Port behind `CallerResolver` and `AdminIdentity` |
| `@aotter/mantle-admin` (3.2k) | `next/src/admin` | Port into `createAdminSurface` |
| `@aotter/mantle-mcp` (0.7k) | `next/src/mcp` | Port into `createMcpSurface` |
| `@aotter/mantle-web` (2.1k) | `next/src/web` | Port into `createWebSurface` and `createRestSurface` |
| `@aotter/mantle` (1.6k CLI, codegen) | `next/src/cli` | Rewrite `generate` and codegen; add `mantle-update` |
| `@aotter/mantle-ui` (4.9k) | `packages/mantle-ui` | Stays the browser package; gains `/admin` |
| `@aotter/mantle-admin-ui` (18.2k) | `@aotter/mantle-ui/admin` | Port at the swap: pagination, base path, drop `/kit` and `rowBindings` |
| `@aotter/mantle-host` (never published) | the plugin | Its source becomes the plugin's Cloud helper scripts; the name disappears |

Only `next/src/spec` and `next/src/core` are built before the step 2 review. The other folders start in step 3.

### `next/src/spec`, from `@aotter/mantle-spec`

| Action | Modules |
|---|---|
| Rewrite | `ManifestGrammar` (Store authored as SQL: a View is one `SELECT`, a Procedure is write statements, `input`, POSIX cron, no `errorPolicy`), `ManifestParser` (1.9k), `ManifestGraphValidator` (1.5k); new `compilePlan` (SQL to IR with `libpg-query`, CLI only; the IR validator is plain JS the runtime shares, ADR-0034) |
| Port | `kernel/diagnostic` (+ `conflict`), `LifecycleStateMachine` (+ `decideLifecycleWrite` from the parked `refactor/20260927-lifecycle-decision`), `EntryDataValidator`, `JsonSchemaToZod`, `LocaleCanonicalizer`, `SiteConfig`, `SiteDefaultsValidator`, `SchemaIndexChecker`, `SchemaAdminUiChecker`, `SchemaSearchChecker`, `CrossSchemaChecker`, `ManifestLinker`, `ManifestPartition`, `ManifestLocaleTrimmer`, `ManifestPathDiagnoser`, `McpToolNaming`, `StaffRoleHierarchy`, `MediaMimeAccept`, the Validate / EmitTypes / EmitOpenapi / Introspect use cases and the CLI |
| Delete | `BUILTIN_OPS`, `HandlerBuiltinBinding`, the Filter AST (`FILTER_COMPARISON_OPS`), `VIEW_PARAMS_RESERVED`, `$param` and `{"$ctx.user": …}`, `HookErrorPolicy` |

### `next/src/core`, from `@aotter/mantle-runtime`

| Action | Modules |
|---|---|
| Rewrite | `domain/model/Store` and `usecase/store/*` (Store over the IR with policy rewrites); `HandlerContext` into `Caller`, `Invocation`, `InvocationCause` and `HandlerContext`; `MantleRuntime.ts` into `createMantleRuntime` and `createMantle`; `InvokeProcedureUseCase` (one path for every `Invocation`, `ctx.invoke`, depth limit); `RunLifecycleHooksUseCase` and `RunDeferredHookUseCase` into the `LifecycleDispatcher`; `RuntimePlanCompiler` (plan v6, SHA-256 fingerprint, handler bijection); the `StoreExecutor` port; `SqliteStoreExecutor` (from `SqliteStoreQuery` and the write half of `DatabaseEntryRepository`); storage convergence (ADR-0033) in place of the ledger path in `SqliteSchemaTables` |
| Port | `AuthPredicateEvaluator` (against `Caller`), `CapabilityCatalog`, `CallableCapabilityProjector`, `InvokeCapabilityUseCase`, `bindCapabilities`, `InteractionCompiler`, `StandardOutputSchema`, `PathMatcher`, `TriggerIndex`, `LocaleNegotiator`, `ViewParamCoercer` (as View `input` coercion), `EntryWriteGuard` (into Store validation), `EntryMutationDiagnostics`; media (`usecase/media/*`, `MediaStorage`, `DatabaseMediaAssetRepository`, `DatabasePendingUploadRepository`); site config (`DatabaseSiteConfigRepository`, `UpdateSiteSettingsUseCase`); boot (`SqliteMigrationRunner`, `canonicalMigrations` without the auth DDL, `bootState`, `ValidateBootUseCase`); ports `DatabaseDriver`, `Clock`, `IdGenerator`, `EmailSender`, `AuditSink`, `RunObservationStore`; `createMantleRequestHandler` and `readJsonBody`; `infrastructure/testing` (`StorageConformance` becomes the executor conformance suite; the benchmark and index-coverage harnesses) |
| Delete | ports `EntryRepository`, `EntryReader`, `AtomicEntryWriter`, `ExpirySweeper`, `DeferredHookDispatcher`, `HandlerRegistry`; `DatabaseEntryRepository` (read half), `LifecycleHookingEntryRepository`, `JoinedEntryReader`, `BuiltinProjector`, `InvokeBuiltinUseCase`, every `usecase/content/*` use case, the declarative path of `ExecuteViewUseCase` and `SqliteViewCompiler`, `SqliteMigrationArtifact`, the managed mode of `SqliteMantleStorageAdapter`, the three cursor formats, `Pagination` (`page`/`show`) |

### Other packages

| Package | Port | Delete |
|---|---|---|
| cloudflare | `D1DatabaseDriver`, `KvSiteConfigRepository`, `R2MediaStorage`, `WorkersQueueHookDispatcher` (as `runDeferredHook` delivery), `handlers/turnstile`, `oauth/cachePolicy`; new `toCloudflareCron` | `createMantleWorker`, `bootRuntimeOnce`, `mountPublicRoutes` (to REST and Web surfaces), `mountMcp` (to `createMcpSurface`), `resolveCaller` (to mantle-auth's `CallerResolver`), `conventionalAuth` and `createAuth` (to mantle-auth and the preset) |
| bun, vercel | `BunDatabaseDriver`, the libSQL driver | `createBunMantle`, `createVercelMantle` |
| indexeddb | none | the package: `IndexedDbEntryRepository`, `IndexedDbViewQueryExecutor` (ADR-0034) |
| auth | `createMantleAuth` (Better Auth wiring, OAuth provider, `appleClientSecret`, email templates); its tables only through Better Auth's `getMigrations`; the #1152 hardening; Better Auth past 1.7.2 (#1189) | the `MantleAuth` shape as the adapter's required type; `getUserRole` as a surface dependency |
| admin | `mountMantleAdmin` (2.8k) into `createAdminSurface`, reading through Store, facets from `AdminIdentity`; `mountMantleOAuth` into mantle-auth's routes; `staffMcp` into the MCP surface | `AdminAuth`; the session-shape dependency |
| mcp | `createMantleMcpServer`, `createMantleMcpHandler`, `apps` into `createMcpSurface` | bearer verification inside the surface |
| web | SEO, sitemap, markdown and HTML rendering, `webmcp`, the frontend client, into `createWebSurface` and `createRestSurface` over Store | `EntryReader` reads |
| mantle | `skills`, `harness` | `--host`, `generate-sites.ts`, `generate-cloudflare.ts` (into the one Cloudflare preset), per-name codegen, dependency closure; new `mantle-update` |
| mantle-host | the `mantle-host` script source and tests, as the plugin's Cloud helper scripts that orchestrate `https://cloud.mantle.tools/mcp` | the npm package, the `mantle-host` skill and name (the plugin keeps one `mantle` skill) |

## Concept map

| 0.1.x | 0.2.0 |
|---|---|
| builtin ops, `ctx.writeAtomically`, `runtime.entries`, `runtime.executeView`, `bindMantle` | `ctx.store` / `runtime.store`: `select`, `view`, `write`, `id` |
| `handler: { kind: builtin, op, schema, match }` | a Procedure written as SQL (`INSERT`, `UPDATE`, `DELETE`, `ON CONFLICT`), compiled to IR by the CLI |
| View `from` / `filter` / `fields` / `orderBy` / `limit`, `params`, `$param` | a View written as one SQL `SELECT`, `input`, `input.x` |
| `page` / `show` | `limit` / `cursor` |
| `ctx.user`, `ctx.staff`, `ctx.auth` | `ctx.caller` (`Caller`) |
| `ctx.event`, `ctx.schedule` | `ctx.cause` (`InvocationCause`) |
| `getRuntime` closures | `ctx.invoke`, `MantleServiceContext.runtime` |
| `createMantleWorker`, `createBunMantle`, `createVercelMantle`, `extend` | `createMantle(service, { storage })` and the generated preset |
| `--host cf \| chatgpt-sites` | no `--host`; the Cloudflare preset; Sites is an example |
| `errorPolicy` | before hooks fail closed; after hooks best effort |
| Cloudflare cron (1 = Sunday), required `cloudflare` host | POSIX cron (0 = Sunday), `schedules: true` |
| auth tables in `0001-init` | Better Auth's `getMigrations` in mantle-auth |
| fourteen npm packages, a `mantle-host` skill | `@aotter/mantle` and `@aotter/mantle-ui`; one plugin with one `mantle` skill and Cloud helper scripts |
| per-column ledger ids, `drizzle/` artifacts, managed boot | boot converges by introspection; `generate --check` prints replayable SQL |

## Contract sources

These existing tests become conformance cases in steps 2 and 3. Each rule is ported, not each test.

| Contract | Existing tests (`packages/mantle-runtime/test/` unless named) |
|---|---|
| Lifecycle | `content-ops` (already ported in the parked branch), `builtin-op`, `entry-writer` |
| Store reads and writes, scope, OCC, TTL | `store-select`, `store-write`, `http-builtin-upsert-occ`, `schema-index-query-plan`, `infrastructure/testing/StorageConformance` |
| Views and pagination | `view`, `view-param-coercer`, `joined-entry-reader` (translation fallback) |
| Hooks | `lifecycle-hooks` |
| Invocation and auth predicates | `dispatcher-invoke`, `dispatcher-boot`, `dispatcher-match`, `bind-capabilities`, `invoke-capability`, `interactions` |
| Plan and boot | `runtime-plan`, `storage-preparation`, `sqlite-migration-runner`, `canonical-migrations` |
| Media and site config | `media`, `site-settings` |
| Surfaces | `packages/mantle-mcp/test`, `packages/mantle-admin/test`, `packages/adapters/cloudflare/test` (13k lines; most of it tests the deleted Worker composition, so only its rules are kept) |
| Identity | `packages/mantle-auth/test`, plus ADR-0032's same-id, different-issuer case |

## Not in 0.2.0

Reliable delivery (outbox), the typed frontend client, a raw-body HTTP Trigger, Bun and Vercel presets, and a rename of Mantle's product tables. Each is additive later, or recorded as rejected in ADR-0032 and ADR-0033.
