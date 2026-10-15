# Testing ledger

One row per original test file; deleted rows name the remaining owner. Distinct runtime, dialect and transport boundaries keep their own checks. Shared scenarios still run on every supported native adapter.

Security witnesses: `user-fields.test.ts` (scope, restrict inheritance, empty values and marker forgery); `user-fields-drivers.test.ts` (native scope paths); `gateway.test.ts` (ingress authority, copied brands, props.mantle, snapshot writes, pins and dry runs); `authorize.test.ts` and Admin `authorize-bypass.test.ts`/`server.test.ts` (REST/MCP/Admin/WebMCP); `auth-cookie.test.ts`, `auth-caller.test.ts`, `auth-identity.test.ts` (OAuth/session authority); `origin.test.ts` (ambient origin). Startup and size gates remain in the focused bundle tests and `packages/mantle/scripts/check-size.ts`, `check-package.ts`, and `scripts/check-ui-size.mjs`.

| Test file | Guarded rules / remaining owner |
| --- | --- |
| `packages/mantle-admin/admin/src/app/frame-policy.test.ts` | Only explicit preview assets with a same-origin immediate bridge may render in frames. |
| `packages/mantle-admin/admin/src/features/console/collection-statistics.test.ts` | Mutation invalidation, saved preferences, safe CSV intervals and cumulative/subtype chart values. |
| `packages/mantle-admin/admin/src/features/logic/business-rules.test.ts` | Business names/thresholds derive from arbitrary declarations; positional INSERT CASE values remain exact. |
| `packages/mantle-admin/admin/src/features/logic/sql-flow-layout.test.ts` | Boolean/CASE layout preserves order and expands without duplicate nodes. |
| `packages/mantle-admin/admin/src/lib/api.test.ts` | Browser-streamed downloads and write refusals preserve drafts/uncertainty without retries or extra reads. |
| `packages/mantle-admin/admin/src/lib/queries.test.ts` | Cursor URL stack/query keys, folded-child prefetch and bundled server relationship projections. |
| `packages/mantle-admin/admin/test/admin-tools.test.ts` | WebMCP client path confinement, result routing, one-shot dispatch and refusal diagnostics. |
| `packages/mantle-admin/admin/test/admin-ux.test.tsx` | Unavailable previews, row precondition hints, output/diagnostic disclosure and responsive developer navigation. |
| `packages/mantle-admin/admin/test/atom-graph.test.ts` | Graph traversal order, references, shareable selection and localized labels. |
| `packages/mantle-admin/admin/test/auth.test.ts` | Auth routing/frame refusal, signed OAuth query, same-origin returns, consent/member access, OTP locking and step transitions. |
| `packages/mantle-admin/admin/test/collection-nav.test.ts` | Merged into `nav-group.test.ts`: Composition-field folding, workbench child discovery and encoded entry routes. |
| `packages/mantle-admin/admin/test/collection-summary.test.ts` | Publishing/translation summary selection and locale chip deduplication/overflow. |
| `packages/mantle-admin/admin/test/data-model.test.ts` | Merged into `atom-graph.test.ts`: Nested field constraints/roles, graph layout and upstream dependency tracing. |
| `packages/mantle-admin/admin/test/developer-operations.test.tsx` | Schedule/run availability and latest-run projections. |
| `packages/mantle-admin/admin/test/entry-edit.test.ts` | Merged into `collection-summary.test.ts`: Explicit edit unlock/admin access, primary title, required values, hidden join fields and declared widgets. |
| `packages/mantle-admin/admin/test/enum-options.test.tsx` | Merged into `admin-ux.test.tsx`: Rendered localized enum titles/empty values, native timestamp labels and server error messages. |
| `packages/mantle-admin/admin/test/field-label.test.ts` | Deleted: shared label/description/localization reexports are covered by mantle-ui/test/fields.test.tsx; native labels remain in admin-ux.test.tsx. |
| `packages/mantle-admin/admin/test/field-render.test.ts` | Merged into `id-value.test.ts`: Only Admin-owned ID tail remains; shared date/money rendering is covered by mantle-ui/test/fields.test.tsx. |
| `packages/mantle-admin/admin/test/i18n-coverage.test.ts` | Every declared language has required messages and identical placeholders; one inventory contract. |
| `packages/mantle-admin/admin/test/id-value.test.ts` | Declared/conventional ID recognition and distinguishable shortening. |
| `packages/mantle-admin/admin/test/media-upload.test.ts` | Explicit missing-storage state, policy/encoder/size choice, bounded encoding and no commit after upload failure. |
| `packages/mantle-admin/admin/test/nav-group.test.ts` | Filter/detail selection, admin/capability navigation, standalone children, operation placement and project groups/items. |
| `packages/mantle-admin/admin/test/nav-user.test.ts` | Merged into `nav-group.test.ts`: Initials fallback for user names. |
| `packages/mantle-admin/admin/test/preview-boundary.test.ts` | Real browser preview frame sandbox and host bridge confinement (explicit browser suite). |
| `packages/mantle-admin/admin/test/row-operations.test.ts` | Declared bindings/version review, unsupported version refusal, diagnostic outcomes and operation placement. |
| `packages/mantle-admin/admin/test/status-badge.test.tsx` | Merged into `admin-ux.test.tsx`: Operational NULL status has no badge; inherited property names remain text. |
| `packages/mantle-admin/admin/test/view-params.test.ts` | Merged into `collection-summary.test.ts`: URL parameters retain declared scalar/null types. |
| `packages/mantle-admin/test/admin-preview.test.ts` | Preview asset selection and bridge admission. |
| `packages/mantle-admin/test/business-rules-sql.test.ts` | SQL projection resolves declared names, exact thresholds and handoff predicates without invented semantics. |
| `packages/mantle-admin/test/mcp-app-browser.test.ts` | Real browser App bridge pins parent/origin and rejects reverse routing; cancelled writes stay uncertain. |
| `packages/mantle-admin/test/mcp-app.test.tsx` | App catalogue/row/action parsing, controller outcome mapping and localized rendered rows/failures. |
| `packages/mantle-admin/test/postmessage.test.ts` | Supported handshake establishes origin; unsupported versions cannot; teardown disconnects. |
| `packages/mantle-admin/tests/native/authorize-bypass.test.ts` | WebMCP authorizes its operation; a write grant alone cannot read the resulting entry. |
| `packages/mantle-admin/tests/native/d1.test.ts` | Shared Admin native scope/OCC/transition/paging oracle executes on actual local storage. |
| `packages/mantle-admin/tests/native/entries-lifecycle.test.ts` | Native entry create/edit/publish/translation lifecycle retains scope, validation and OCC. |
| `packages/mantle-admin/tests/native/followups.test.ts` | Streaming CSV, scoped statistics, relationship projections, session authority and exact temporal subtype behavior. |
| `packages/mantle-admin/tests/native/gateway.test.ts` | Admin gateway admission, scope, freshness/OCC, member refusal and redacted contract errors. |
| `packages/mantle-admin/tests/native/helpers.test.ts` | Tuple cursors/bind positions/caps, NUL JSON keys, bucket overflow and scoped batch filter intersection. |
| `packages/mantle-admin/tests/native/server-native.test.ts` | Shared Admin native oracle on PostgreSQL adapters, including committed writes with lost replies. |
| `packages/mantle-admin/tests/native/server.test.ts` | Admin session/origin/body limits before DB, absent `/x/*` extension routes, scoped operations/preview/metadata and authorize on every route. |
| `packages/mantle-admin/tests/native/shell.test.ts` | Shell anti-framing/cache/nosniff headers and path/traversal/missing-file confinement. |
| `packages/mantle-ui/test/components.test.tsx` | Rendered interaction state/actions, diagnostics, diffs, host labels and uncertainty acknowledgement. |
| `packages/mantle-ui/test/controller.test.ts` | Pinned row/version review, conflict/uncertain outcomes, no retries, cancellation, immutable state and input rebasing. |
| `packages/mantle-ui/test/fields.test.tsx` | Accessible declared fields, typed options/nulls, host rendering, localization/fallback and native value presentation. |
| `packages/mantle-ui/test/kit.test.tsx` | Shared primitives/legal links/auth recipe without Admin runtime dependencies. |
| `packages/mantle/compiler-tests/core/lowered-plan.test.ts` | Deleted: private lowered object/JSON assertions repeat executable generation, paging, publishing and startup tests in ../tests. |
| `packages/mantle/compiler-tests/core/target-inference.test.ts` | Procedure target inference requires one pinned row; explicit targets, version types and typed literals retain their semantics. |
| `packages/mantle/compiler-tests/d1/dialect.test.ts` | Executed SQLite printer corpus, scope/TTL index use, nested expression precedence, signed constants and ORDER BY value semantics. |
| `packages/mantle/compiler-tests/d1/initial-not-null.test.ts` | Initial DDL enforces required non-null operational fields in both dialects; publishing drafts remain incomplete. |
| `packages/mantle/compiler-tests/d1/reference-refusals.test.ts` | SQLite refuses reference-dialect-only SQL with actionable diagnostics. |
| `packages/mantle/compiler-tests/postgres/dialect.test.ts` | Native PostgreSQL nested operands and time-zone expressions preserve precedence. |
| `packages/mantle/compiler-tests/spec/compile-plan.test.ts` | Compilation/context/diagnostic wiring, cache eligibility over expanded IR, typed fields, names and Admin metadata. |
| `packages/mantle/compiler-tests/spec/cross-schema.test.ts` | Translation parent resolution/suggestions, parent localization and join-field rules through the manifest validator. |
| `packages/mantle/compiler-tests/spec/interaction-grammar.test.ts` | Reference uniqueness/composition and explicit Procedure target shape/type constraints. |
| `packages/mantle/compiler-tests/spec/json-schema-zod.test.ts` | Nullable/local refs, malformed patterns and cyclic/over-deep values fail safely. |
| `packages/mantle/compiler-tests/spec/localized-text.test.ts` | One localized-text shape matrix plus slot wiring/requiredness; field metadata accepts localized text. |
| `packages/mantle/compiler-tests/spec/manifest-linker.test.ts` | Sealed graph linking, duplicate source spans, tool name/Trigger collisions and truthful MCP annotations. |
| `packages/mantle/compiler-tests/spec/manifest-source-set.test.ts` | Source/document identity, defaults, diagnostic spans and duplicate source-ID rejection. |
| `packages/mantle/compiler-tests/spec/media-mime-accept.test.ts` | MIME alias/slot normalization and policy ambiguity/cap validation. |
| `packages/mantle/compiler-tests/spec/reader-names.test.ts` | Generated reader projection/fallback and reserved/colliding names. |
| `packages/mantle/compiler-tests/spec/site-validate.test.ts` | Locale/icon safety and structured media policy diagnostics. |
| `packages/mantle/compiler-tests/spec/sql-compile.test.ts` | Closed SQL grammar/allowlist, scope/system write protection, provenance/forged IR rejection and UTF-8 diagnostic locations. |
| `packages/mantle/compiler-tests/spec/validate.test.ts` | Closed manifest grammar, scope/index/TTL/translation/auth/cache constraints, alias bombs and bounded JSON Schema/regex validation. |
| `packages/mantle/compiler-tests/spec/view-ctes.test.ts` | Lexical CTE provenance, closed CTE grammar, reserved aliases, scope/TTL/publishing/DML binds and forged tag refusal. |
| `packages/mantle/compiler-tests/spec/view-references.test.ts` | Internal View expansion/provenance and refusal of public/input-bearing/cyclic/writing references. |
| `packages/mantle/tests/admin-bindings.test.ts` | Generated Admin factories, scoped entry/View/write policies, filters/statistics, prototype keys, exact cursors and public preview visibility. |
| `packages/mantle/tests/admin-descriptors.test.ts` | Admin collection/translation metadata, operation placement/preconditions, refusal of removed extension references and metadata-only imports. |
| `packages/mantle/tests/admin-layer.test.ts` | Configured admin roles, credential scope checks and admission before loading tools or storage. |
| `packages/mantle/tests/artifacts.test.ts` | Output symlinks are refused before writes; application files survive regeneration. |
| `packages/mantle/tests/auth-adapter.test.ts` | Native CRUD/joins, predicate semantics, transactions, auth flows, case folding, ID formats and atomic OTP/attempt counting; one shared conformance run per adapter. |
| `packages/mantle/tests/auth-caller.test.ts` | Cookie identity/configuration, session authority snapshots, OAuth audience/revocation/scopes/DPoP/consent, credential priority and verified field sources. |
| `packages/mantle/tests/auth-cookie.test.ts` | Shared native cookie oracle: anonymous fast path, roles/bans, field mapping, refresh, expiry, revocation and cache authority. |
| `packages/mantle/tests/auth-identity.test.ts` | OTP ingress/profile controls, bootstrap/invites, member paging, last-admin concurrency, cache invalidation and primary session authority. |
| `packages/mantle/tests/auth-oauth-postgres.test.ts` | Native PostgreSQL OAuth audience, grant/session revocation and consent ordering. |
| `packages/mantle/tests/auth-resource.test.ts` | OAuth resource selection/seeding and renamed native models without boot SQL. |
| `packages/mantle/tests/auth-split.test.ts` | Lazy optional auth imports, startup import tripwires, auth schema/index compatibility and CLI auth loading. |
| `packages/mantle/tests/authorize.test.ts` | REST and MCP authorize manifest targets before SQL/handlers; requires precedes authorization and lists hide denied targets. |
| `packages/mantle/tests/boundaries.test.ts` | Request and build imports respect package/layer boundaries. |
| `packages/mantle/tests/bun-assets.test.ts` | Asset reader refuses traversal, malformed paths and escaping symlinks. |
| `packages/mantle/tests/cli.test.ts` | CLI handler guidance, config preservation/idempotence, executable consumer build and the removed `--admin-extensions` option; process timeout 30 s. |
| `packages/mantle/tests/compiler-boundary.test.ts` | Generator loads and compiles without optional auth/MCP dependencies; process timeout 30 s. |
| `packages/mantle/tests/consumer.test.ts` | Four generated consumers typecheck native handles and TTL entries; bundles exclude unrelated code; CLI cleanup/check preserve application files; process timeout 30 s. |
| `packages/mantle/tests/describe-diff.test.ts` | Restriction replacement widens access; target hashes are independent of process locale. |
| `packages/mantle/tests/describe.test.ts` | Deterministic access catalogue/hash/diff, conservative read/write classification, route dispatch and inherited View restrictions. |
| `packages/mantle/tests/email.test.ts` | Email locale/category/HTML contract, development sender, public entry and optional bundle exclusion. |
| `packages/mantle/tests/gateway.test.ts` | Trusted ingress only, copied authority denied, props.mantle tripwire, scoped reads, snapshot write refusal, pins and dry runs. |
| `packages/mantle/tests/generate.test.ts` | Native generation refusals, unique/uncertain write outcomes, authored binds, driver-native rows and temporal SQL semantics. |
| `packages/mantle/tests/handlers.test.ts` | Ref dispatch authorization, caller/transaction-bound Store, rollback, missing/inherited handlers and generated handler types. |
| `packages/mantle/tests/kernel.test.ts` | Strict scalar/calendar conversion and SQLite rollback-failure classification. |
| `packages/mantle/tests/mcp-apps.test.ts` | Request-bound App catalogues, capability negotiation, configuration validation, redacted loader failures and admin-only tool loading. |
| `packages/mantle/tests/mcp-auth-order.test.ts` | Admin authority and cookie read catalogue precede SDK/body loading. |
| `packages/mantle/tests/mcp-media-d1.test.ts` | Actual local storage/media tool round trip, authorization, origin, retry and exact media failures. |
| `packages/mantle/tests/mcp-media.test.ts` | Media tool collisions, optional startup imports, boundary errors, native types and request isolation. |
| `packages/mantle/tests/mcp.test.ts` | SDK protocol integration, tool exposure, validation, auth/origin, publishing, refs, redaction and batch preflight. |
| `packages/mantle/tests/origin.test.ts` | Ambient credential writes require same origin; explicit credentials and resolver errors retain their contracts. |
| `packages/mantle/tests/output-names.test.ts` | Executed View/RETURNING fields retain SQL aliases on both dialects; case-folding diagnostics are actionable. |
| `packages/mantle/tests/paging-d1.test.ts` | Shared native paging oracle executes on actual local storage. |
| `packages/mantle/tests/paging-integer.test.ts` | Exact integer cursor spelling, bounds and native SQLite ordering. |
| `packages/mantle/tests/paging-native.test.ts` | Shared tuple/group/join/singleton paging oracle plus proof refusals, alias collisions and nullable references. |
| `packages/mantle/tests/paging.test.ts` | Scoped keysets, cursor provenance/type checks before SQL, temporal precision, TTL stability and paging proof diagnostics. |
| `packages/mantle/tests/postgres-adapter.test.ts` | Real PostgreSQL native query/Procedure/Store/publishing/search conformance. |
| `packages/mantle/tests/publishing.test.ts` | Publishing selection, visibility through joins/CTEs/subqueries, native clock binds and operational timestamp refusal. |
| `packages/mantle/tests/refusals.test.ts` | Unsupported triggers/guards/geo and invalid casts fail generation with complete actionable diagnostics. |
| `packages/mantle/tests/rest-hook.test.ts` | Hook Request/env/Response identity and authorization/body-size checks before providers. |
| `packages/mantle/tests/rest-native.test.ts` | Shared native REST oracle runs on real storage; handler type checks are merged into admin-bindings.test.ts. |
| `packages/mantle/tests/rest.test.ts` | REST paging/validation/auth/OCC/method/origin/composition, query cloning, static routes and startup size gate. |
| `packages/mantle/tests/search.test.ts` | Search validates before SQL, bounds query counts and refuses unsupported declarations/rank. |
| `packages/mantle/tests/selected-output.test.ts` | Selected scalar boundary conversions preserve aliases/prototype fields, native rows, exact integers and cursor authority. |
| `packages/mantle/tests/site-d1.test.ts` | Site settings and idempotent media lifecycle execute on actual local storage. |
| `packages/mantle/tests/site-media.test.ts` | Optional site/media, no boot DDL, upload retry/expiry/uncertain outcomes, object snapshot rollback and response projections. |
| `packages/mantle/tests/store-lazy.test.ts` | Generated imports initialize no Store; bindings stay caller-local; unused Store/paging code leaves startup. |
| `packages/mantle/tests/store.test.ts` | Generated Store row/order types and placeholder offsets compose with scope/TTL/cursors. |
| `packages/mantle/tests/translations-d1.test.ts` | Shared translation visibility/inheritance/OCC oracle runs on actual local storage. |
| `packages/mantle/tests/translations.test.ts` | Locale canonicalization, generated types, bounded batching, parent/child scope correlation and optional startup size. |
| `packages/mantle/tests/ttl.test.ts` | Bounded authorized expiry sweep, native cursor/trigger semantics, cron conversion and optional imports; generated type checks are merged into consumer.test.ts. |
| `packages/mantle/tests/user-fields-drivers.test.ts` | One shared field-scope/restrict/Store/Procedure/encoding oracle across all native adapters. |
| `packages/mantle/tests/user-fields.test.ts` | Branded immutable fields, scope/restrict composition and inheritance, denied empty values, parent correlation, paging proofs and forged markers. |
| `packages/mantle/tests/validation.test.ts` | Generated boundary validation: nested types/bounds/enums/formats/refs, Unicode, safe numbers and depth limits. |
| `packages/mantle/tests/web-example.test.ts` | Documented example executes visibility/REST/index/alternate flows and typechecks/bundles. |
| `packages/mantle/tests/web.test.ts` | SQL-visible escaped/revalidated pages, exact public URL types, published-only output, bounded scans and optional imports. |
| `packages/mantle/tests/wire.test.ts` | Shared REST/MCP conversion oracle, native output isolation, exact int64 transport/order and compiler-free startup. |

Removed overlaps: repeated auth CRUD matrices now have one join-enabled run and focused ID round trips; simple CRUD/paging combinations yield to their combined cases. Cookie fast paths, roles, bans and refresh use the shared native cookie oracle. Private scalar/output/metadata assertions yield to generated consumers and executed boundary rows. Removed lifecycle/schedule behavior is represented by generation refusal. Localized metadata uses representative shapes and slot wiring instead of a Cartesian product. Admin shared value/label wrappers yield to the UI renderer; language inventory has one declared-set witness. Related Admin files share imports while retaining their distinct assertions. Paging uses nine rows with a two-row page and an eight-row window; maximum limit refusal remains in paging.test.ts. All four web target typechecks share one TypeScript program.

## Verification (2026-10-14)

Node 22.22.3, Bun 1.3.14. Packages were built before testing. Both measurements ran the five suites concurrently; wall times are observations, not a performance gate. Counts include skips and blocked cases.

| Suite | Cases before → after | Wall seconds before → after | Final result |
| --- | ---: | ---: | --- |
| Core Bun (`tests/*.test.ts`) | 841 → 465 | 40.85 → 24.66 | 385 pass, 60 skip, 20 port-blocked |
| Compiler Vitest | 265 → 192 | 7.81 → 4.22 | 191 pass, 1 skip |
| Admin native Bun | 31 → 31 | 3.18 → 1.51 | 28 pass, 3 skip |
| Admin Vitest | 183 → 132 | 18.21 → 8.95 | 132 pass |
| UI Vitest | 46 → 45 | 10.64 → 6.46 | 45 pass |
| Total / sum of suite wall times | 1,366 → 865 | 80.69 → 45.80 | Cases −36.7%; summed time −43.2% |

The 50% case target was not reached: the remaining cases cover distinct rules or execution boundaries. No product code changed. Whole-process CLI/consumer cases have explicit 30 s timeouts.

Commands: `bun test tests/*.test.ts`; `pnpm exec vitest run --config vitest.compiler.config.ts`; `MANTLE_NATIVE_TESTS=1 bun test tests/native/*.test.ts`; Admin/UI `pnpm exec vitest run`; `pnpm typecheck`; compiler `tsc --noEmit -p tsconfig.compiler.json`; `git diff --check`.

`pnpm check` passed boundary/skill/manifest self-checks, builds, startup/size gates, documented examples, package checks and typechecks. It stopped at local port failures in Core. Its native-enabled CLI consumer also failed to bind 127.0.0.1 (`EPERM`). Package size reference reports were left unchanged. The standalone packed-consumer check refused a dirty worktree before execution because it requires immutable commit evidence.

### Local port failures

All 20 default-suite failures originate at `Bun.serve({ port: 0, hostname: "127.0.0.1" })` in `auth-caller.test.ts` (`EADDRINUSE` in this sandbox). They had the same cause before editing; seven duplicate cookie cases were removed in favor of the passing shared cookie oracle.

- resolveCaller: session cookie > 3. email OTP sign-in -> user caller with session id and user role
- resolveCaller: session cookie > 5b. auth.api.revokeSession revokes it too
- resolveCaller: session cookie > 6b. admin plugin banUser revokes the user's sessions -> anonymous
- resolveCaller: session cookie > 7. authLoader refuses a mismatched cookiePrefix and a renamed session cookie; a retried get re-runs load
- resolveCaller: session cookie > one primary result is the authority snapshot; a later revoke applies to the next request
- resolveCaller: session cookie > real SDK refresh cookies survive merged headers; revocation wins over the secondary snapshot
- resolveCaller: OAuth bearer > 9. real access token -> oauth user caller; role re-read; wrong audience / garbage / banned / no audience option -> UNAUTHENTICATED
- resolveCaller: OAuth bearer > a Bearer header wins over a session cookie (an invalid token is never anonymous)
- OAuth grant revocation and consent routes > revoke then call rejects issued JWT, cleans tokens/codes and does not resurrect it on reconsent
- OAuth grant revocation and consent routes > expired/deleted session and withdrawn scope fail on next bearer call
- OAuth grant revocation and consent routes > methods never loads auth; session-only connected apps, localized HTML and origin-checked writes
- OAuth grant revocation and consent routes > DPoP with session KV cache is bound to request and single-use database proof
- OAuth grant revocation and consent routes > consent boundary rejects oversized streaming bodies, invalid decisions and invalid signed query
- OAuth grant revocation and consent routes > raw and encoded SDK admin routes ignore stale admin KV after demotion, ban or session deletion
- OAuth grant revocation and consent routes > an expired primary session cannot refresh from a still-valid KV snapshot
- OAuth grant revocation and consent routes > supported database-only auth config keeps raw SDK get-session under primary expiry
- OAuth grant revocation and consent routes > bearer authority is one native JOIN; connected apps is one JOIN in updated order
- OAuth grant revocation and consent routes > secondary storage without primary sessions fails at loader setup with ContractError
- OAuth grant revocation and consent routes > app-owned credential hook precedes OAuth/cookies and never falls back after denial
- OAuth grant revocation and consent routes > scheduled legacy DCR pruning keeps new, owned, reference and CIMD clients
