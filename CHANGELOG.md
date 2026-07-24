# Changelog

All notable changes to AotterMantle are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning once public v0.1.0 tags begin. Pre-v0.1.0 alpha releases may still change public APIs.

<!-- No [Unreleased] section. Entries are written at release time per CONTRIBUTING.md § Changelog and docs/release-process.md § Normal release playbook step 2. -->

## [0.0.11-alpha.53] - 2026-07-24

### Added

- **agent toolchain**: document the minimal local MCP connection flow in the versioned `mantle:develop` skill: public versus staff endpoints, OAuth preflight, native remote HTTP first, a standard stdio bridge fallback, and read-only verification before mutations (#494, #495).

### Changed

- **release fanout / starters**: use the SDK-owned setup-incomplete Auth facade instead of a starter-local copy, preserving first-deploy public boot while keeping the Auth contract centralized (aotter/mantle-starters#287, aotter/mantle-starters#419).
- **toolchain**: refresh TypeScript, Cloudflare Workers types/Wrangler, and GitHub Actions dependencies; the adapter now depends only on the `waitUntil()` shape it consumes instead of the expanding Workers `ExecutionContext` interface (#465, #480, #492).

### Fixed

- **@aotter/mantle-runtime**: builtin update/upsert now patch an existing row without deleting omitted fields or re-stamping bound author/time values; View SQL closes sort-direction interpolation and caps oversized page offsets (#390, #392, #397, #493).
- **@aotter/mantle-spec**: pre-deploy validation rejects invalid regex patterns, unknown required fields, invalid View sort directions, and colliding OpenAPI routes; type emission supports non-object top-level schemas and `validate --source` reports an unreadable root directly (#392–#395, #398, #399, #493).

### Security

- **@aotter/mantle-cloudflare / @aotter/mantle-admin-ui**: block cross-origin OAuth consent posts, normalize email-OTP return paths to the current origin, and redact internal diagnostic candidates from HTTP Trigger and View responses (#387, #389, #396, #493).

## [0.0.11-alpha.52] - 2026-07-24

### Fixed

- **agent toolchain**: keep shipped skills on the installed Mantle version by reading the bundled 4-atom and API/MCP authorization guides instead of floating `develop` docs, enforce that boundary in the release gate, and smoke the canonical `/skill/after-launch` handoff route (aotter/mantle#489, aotter/mantle#490, aotter/mantle-platform#25).

## [0.0.11-alpha.51] - 2026-07-23

### Fixed

- **release fanout**: No SDK code changes. alpha.51 re-spins the release fanout to ship reproducible generated Starter styles that should have been part of alpha.50; a fresh materialized project now resolves the same Tailwind compiler as its checked-in CSS and the smoke gate enforces that invariant (aotter/mantle-starters#416, aotter/mantle-platform#25).

## [0.0.11-alpha.50] - 2026-07-23

### Added

- **@aotter/mantle / agent plugins**: add the deterministic local cold-start path backed by the same versioned provision bundles as Mantle Landing, with repository-URL and installed-plugin routing that stops at a validated local project until the user explicitly asks to ship (#486, aotter/mantle-starters#414).

### Changed

- **skills**: converge local and Landing-generated handoffs on observed repository, deploy, and auth state; explicitly guide visual direction and core business-workflow customization without treating auth or seed data as the finished product (#486, aotter/mantle-starters#414, aotter/mantle-landing#299).
- **release fanout**: ship marker-free local/Landing starter bundles and the paired transactional Landing provisioning state machine; launch provenance is no longer a product version or authorization boundary (aotter/mantle-starters#414, aotter/mantle-landing#298, aotter/mantle-landing#299, aotter/mantle-platform#25).
- **@aotter/mantle-admin-ui**: refresh Radix UI, Lucide, and Vite dependencies within their existing compatible release lines.

## [0.0.11-alpha.49] - 2026-07-19

### Fixed

- **@aotter/mantle-spec / @aotter/mantle-runtime**: materialize Schema `uniqueIndexes` as generated D1 columns and native unique indexes during boot, so concurrent writes cannot bypass manifest uniqueness; quote valid kebab-case schema identifiers in emitted DDL (#478).

## [0.0.11-alpha.48] - 2026-07-15

### Added

- **@aotter/mantle-spec / @aotter/mantle-runtime / @aotter/mantle-cloudflare**: add one adapter-neutral authorization contract for REST and MCP Procedures/Views: verified caller metadata, role/scope predicates, consumer-supplied API-key and personal-token resolution, mutable guard Procedures (including payment/entitlement checks), consistent 401/402/403 diagnostics, and OpenAPI/MCP reflection (#468, #467).
- **docs**: ship a versioned consumer guide with complete anonymous, API-key, paid API-key guard, and personal-token examples while keeping credential storage, transaction state, and entitlement policy in the Mantle Site rather than Core (#468, #467).

### Fixed

- **@aotter/mantle-runtime / @aotter/mantle-cloudflare**: staff Views are discoverable and callable only on staff MCP, authorization failures return structured JSON-RPC errors, OAuth bearer identity is normalized into the shared caller context, and every staff MCP call reads the caller's current D1 role so demotion or revocation takes effect immediately (#468, #332, #388).

## [0.0.11-alpha.47] - 2026-07-14

### Changed

- **@aotter/mantle-admin-ui**: simplify the live auth, collection, entry, media, report, approval, staff, and navigation paths around shared pagination, entry-title, and value-rendering helpers; remove unreachable editor, layout-context, duplicate i18n, and UI wrapper code (#464).
- **@aotter/mantle-runtime / @aotter/mantle-spec / @aotter/mantle-cloudflare**: collapse duplicate diagnostics, pagination, lifecycle, rendering, MCP response, CLI parsing, and server-mount logic into the active implementation paths while preserving the shipped 4-atom and adapter behavior (#464).
- **repository**: simplify CI, Dependabot auto-merge, release publishing, boundary checks, and package-doc synchronization; the complete audit removes 2,523 lines and adds 739 focused replacement lines (#464).

### Removed

- **@aotter/mantle-admin-ui / @aotter/mantle-runtime / @aotter/mantle-spec / @aotter/mantle-cloudflare**: remove unused pre-v1 exports, dead adapter branches, unreachable rich-editor surfaces, duplicate framework helpers, and tests that covered retired APIs (#464).

## [0.0.11-alpha.46] - 2026-07-12

### Fixed

- **@aotter/mantle-cloudflare**: server-side OAuth client registration now requires and forwards the current owner/admin request headers, allowing Better Auth to enforce client privileges with the authenticated session instead of rejecting every registration as unauthorized (#462).

## [0.0.11-alpha.45] - 2026-07-07

### Added

- **@aotter/mantle-spec / @aotter/mantle-admin-ui**: JSON Schema property `description` may now be a `LocalizedText` locale-map (string still accepted), mirroring property `title` (#443). The entry-editor renders field help text via `resolveLocalizedText`, so per-language operator-facing help works; `en` stays the OpenAPI/dev-doc string (#453).

### Changed

- **@aotter/mantle-admin-ui**: the sticky admin header glass is more opaque and more blurred so form content no longer bleeds through when scrolling (#452).

### Fixed

- **@aotter/mantle-spec / @aotter/mantle-runtime**: OpenAPI emit and the MCP tool catalog collapse a `LocalizedText` schema `description` to its `en` string, keeping emitted specs and MCP tool descriptions valid plain-string JSON Schema (#453).

## [0.0.11-alpha.44] - 2026-07-07

### Added

- **@aotter/mantle-spec / @aotter/mantle-admin-ui**: localized `View.spec.title` and JSON Schema property `title` (string or LocalizedText) — sidebar report names, report page titles, list column headers, and form labels now come from the manifest instead of humanized property names (#443).
- **@aotter/mantle-admin-ui**: row-bound operations now also surface on the entry editor page header and on child-entry rows inside the parent editor — e.g. a restock procedure is reachable by navigation instead of only from the bound collection's list page (#442).
- **@aotter/mantle-admin-ui**: success toasts after operation execution, and a styled confirm dialog replaces `window.confirm` for destructive actions (#444).

### Changed

- **@aotter/mantle-admin-ui**: media upload probes the browser's canvas encoder per mime before selecting a variant format, fails fast with an operator-readable localized error when a purpose demands a format the browser cannot encode (e.g. AVIF), and no longer burns 24 encode attempts before surfacing it (#440).
- **@aotter/mantle-runtime**: `site_config` keys with no admin-UI edit path (`mediaPurposes`, `locales`) are now synced from `mantleConfig.ts` on every boot instead of seeded write-once — config edits reach already-deployed sites (#441). UI-editable keys (brand, title, …) keep DB-wins semantics.
- **@aotter/mantle-admin-ui**: operation failures show a generic localized message with the raw handler detail collapsed behind a disclosure instead of dumping it inline; collection page descriptions are lifecycle-aware; ID cells truncate from the tail; media-asset fields render a thumbnail chip; the `money-minor` hint badge is localized (#444).
- **@aotter/mantle-runtime**: `lifecycle: none` authoring validation fixed for create/update drafts.

### Fixed

- **@aotter/mantle-admin-ui**: SPA navigation into a report page no longer white-screens the whole console — `authenticated-layout` and `view-page` cached different shapes under the same react-query key (#450).
- **@aotter/mantle-runtime / @aotter/mantle-admin-ui**: 8 findings from the alpha.43 code review — media delete now settles all R2 deletions before removing the DB row, batch upload no longer aborts on first failure, media "load more" pagination survives edit refetches, cursor decoding is size-capped, view path labels de-hardcoded, test fakes aligned with the widened `MediaAssetRepository` (#439, headline fix shipped as #438: `mountMcp` filters Views by surface so staff Views are not listed or callable on the public `/mcp`).

## [0.0.11-alpha.43] - 2026-07-06

### Added

- **@aotter/mantle-spec / @aotter/mantle-admin-ui**: `View.spec.surface: "public" | "staff"` — staff-only Views mount gated under `/admin/api/views/` and drive the admin report sidebar (#433).
- **@aotter/mantle-admin-ui / @aotter/mantle-runtime**: full media library — list/get/edit/delete media API plus admin browser and entry-editor picker (#434).

### Changed

- **@aotter/mantle-admin-ui**: the 報表 sidebar lists staff Views only (was: every View); the 操作 sidebar shows only operations without row-bindings (bound ones live in the entry-row action menu) (#433).

### Security

- **@aotter/mantle-runtime**: staff Views are no longer reachable on the public `/api/views/` path — closes the class of PII-via-View exposure (#433; see project-toa-shop#72).

## [0.0.11-alpha.42] - 2026-07-03

### Added

- **@aotter/mantle-spec**: add `lifecycle: none` for operational collections (#422).
- **@aotter/mantle-spec / @aotter/mantle-admin-ui**: add `LocalizedText` titles, `Procedure.spec.title`/`description`, and row-level actions via `x-mantle-ref` (#430).
- **@aotter/mantle-admin-ui**: add a staff operations page for invoking Procedures and read-only View pages (#426).
- **@aotter/mantle-admin-ui**: add cursor pagination and server-side search to collection lists (#423).
- **@aotter/mantle-admin-ui**: add CSV export and bulk actions to collection lists (#427).
- **@aotter/mantle-admin-ui**: add money-minor/timestamp-ms render hints and `lifecycle: none` list columns (#424).
- **@aotter/mantle-admin-ui**: add a create-entry button.
- **@aotter/mantle-admin-ui**: group the sidebar into content/operations sections with approvals gating (#425).

### Changed

- **@aotter/mantle-admin-ui**: make the generated console fully manifest-driven — remove hardcoded ecommerce shapes (the collection labels map, SKU editor, fake media library, and storefront settings fields) (#422).
- **@aotter/mantle-runtime**: draft saves are now partial; required-field enforcement happens at publish time.
- **@aotter/mantle-admin-ui**: fields bound via `x-mantle-bind` render read-only.
- **@aotter/mantle-admin-ui**: de-jargon operator-facing copy (#429).
- **@aotter/mantle-spec**: `collectionParentFor` now requires refs to a required field.

### Fixed

- **@aotter/mantle-admin-ui**: derive dark-mode input/toolbar backgrounds from glass tokens.
- **@aotter/mantle-admin-ui**: fix the mobile sidebar trigger.
- **@aotter/mantle-admin-ui**: fix tablet horizontal overflow with `min-w-0`.

## [0.0.11-alpha.41] - 2026-07-01

### Changed

- **@aotter/mantle-runtime**: fold Better Auth OAuth Provider tables
  into the canonical init schema and remove the alpha-only takeover
  migration before public adoption.

## [0.0.11-alpha.40] - 2026-06-30

### Removed

- **@aotter/mantle-cloudflare**: remove the alpha.39
  `oauthProvider.trustedClients` config surface before adoption. The
  active Better Auth OAuth provider package is DB/DCR-backed; hosted
  platform clients should be created through dynamic client
  registration or the SDK `registerOAuthClient()` facade.

## [0.0.11-alpha.39] - 2026-06-30

### Added

- **@aotter/mantle-cloudflare**: expose Better Auth OIDC
  `trustedClients` through `createAuth().oauthProvider` so hosted
  Mantle Platform deployments can register first-party public PKCE
  clients in code while external Mantle sites continue to use dynamic
  client registration.

## [0.0.11-alpha.38] - 2026-06-30

### Added

- **@aotter/mantle-cloudflare**: add `CreateAuthConfig.basePath`
  and expose `Auth.basePath` so one Worker can host multiple Better
  Auth instances without route collisions, e.g. Mantle Platform auth,
  site staff auth, and launch-time GitHub auth.

### Changed

- **@aotter/mantle-cloudflare**: mount the SDK-managed Better Auth
  methods endpoint and catch-all under `Auth.basePath`; the default
  remains `/api/auth`.

## [0.0.11-alpha.37] - 2026-06-30

### Added

- **@aotter/mantle-cloudflare**: add first-class Better Auth generic
  OAuth/OIDC consumer support via `AuthMethodConfig.kind = "oauth"` so
  Mantle sites can sign staff in through a hosted Mantle Platform
  provider without custom token plumbing.
- **@aotter/mantle-cloudflare**: expose hosted OAuth provider wiring on
  `createAuth()` using `@better-auth/oauth-provider`, including OIDC
  discovery, authorization, consent, token, userinfo, and dynamic client
  registration surfaces.
- **@aotter/mantle-cloudflare**: add `registerOAuthClient()` to the
  auth facade so a platform site can register downstream Mantle sites as
  OAuth clients through the same auth boundary.

### Changed

- **@aotter/mantle-admin-ui**: render generic OAuth sign-in methods in
  the staff sign-in UI alongside GitHub and email-based methods.
- **@aotter/mantle-runtime**: replace the pre-ship legacy OAuth table
  shape with Better Auth OAuth provider tables. Existing alpha-only
  `oauthApplication`, `oauthAccessToken`, `oauthRefreshToken`,
  `oauthClient`, and `oauthConsent` tables are dropped and recreated by
  migration `0003-better-auth-oauth-provider`.

## [0.0.11-alpha.36] - 2026-06-30

### Added

- **@aotter/mantle-cloudflare**: expose curated Better Auth first-party
  SSO configuration fields on `createAuth()`:
  `trustedOrigins`, `crossSubDomainCookies`, and `cookiePrefix`.
  Existing consumers that do not pass these fields keep the previous
  cookie and session behavior.
- **docs**: document Mantle's auth hosting boundary: free users can
  self-host supported login methods, Mantle Platform can provide hosted
  identity and email as paid convenience, same-parent-domain SSO uses
  cookies, and customer-domain hosted auth must use an OAuth/OIDC broker
  flow.

## [0.0.11-alpha.35] - 2026-06-26

### Fixed

- **@aotter/mantle-cloudflare**: fix first-time MCP OAuth connect from desktop clients by redirecting anonymous `/oauth/authorize` requests to the admin sign-in page with the `return` parameter that the admin SPA already preserves for Better Auth callbacks. This keeps the post-login flow on the OAuth consent request instead of landing in `/admin` first.

## [0.0.11-alpha.34] - 2026-06-25

### Changed

- **@aotter/mantle-runtime**: tighten MCP media-upload guidance so agents read the live purpose policy, do not default to JPEG, preserve transparency and animation, ask before uploading obviously wasteful assets, and suggest another capable agent/runtime when the current host blocks direct presigned PUT uploads.
- **@aotter/mantle-runtime / docs**: remove current references to the retired `@aotter/mantle-media-tools` helper from media-upload comments, diagnostics, and ADR guidance.

## [0.0.11-alpha.33] - 2026-06-25

### Removed

- **@aotter/mantle-runtime**: remove the MCP `upload_media_variant` base64 byte-upload path. Media uploads now use `create_media_upload` presigned PUT capabilities plus `commit_media_upload` only.

### Changed

- **@aotter/mantle-runtime**: make `create_media_upload` self-guiding for pure MCP agents: process chat/session image attachments in the agent runtime, preserve PNG transparency and GIF animation, use available Node/Python image tooling when possible, and remember the workflow via host memory/skills when supported without asking users to open a terminal.
- **release fanout**: alpha.33 carries the paired starter cleanup that removes the retired companion upload plugin and media helper package.

## [0.0.11-alpha.31] - 2026-06-20

### Fixed

- **starters fanout**: no SDK code changes. alpha.31 re-spins the
  release fanout so starter Workers keep auth disabled until
  `provision:up` has written all required GitHub OAuth and Better Auth
  settings, allowing Cloudflare's first Git deploy to boot public routes
  instead of throwing during the setup window.
- **landing fanout**: no SDK code changes. alpha.31 also carries the
  deterministic launch handoff copy that removes the remaining old
  interview-harness wording from production launch instructions.

## [0.0.11-alpha.30] - 2026-06-19

### Changed

- **starters fanout**: no SDK code changes. alpha.30 re-spins the
  release fanout because alpha.29's starter release raced ahead as a
  version-only bump before the `mantle/site.md` scaffold removal landed
  in `mantle-starters`.

## [0.0.11-alpha.29] - 2026-06-19

### Removed

- **skills / ADR-0016**: remove `mantle/site.md` from the first-run
  install/provision contract. New scaffolds use deterministic
  `.mantle/launch-state.json` plus `AGENTS.md`; site prose/letter
  state no longer blocks or participates in production provision.

### Changed

- **starters fanout**: alpha.29 re-spins the release fanout so the
  paired starter tarball no longer generates `mantle/site.md` or
  repo-local skill instructions that depend on it.

## [0.0.11-alpha.28] - 2026-06-19

### Changed

- **skills/install**: remove the old manual interview / prompt harness
  from the install skill. The user-facing path is now landing session
  -> deterministic scaffold -> repo-local provision.
- **skills/provision**: make the provision handoff explicitly
  provider-first: the agent validates and pushes the repo, guides the
  user through Cloudflare's GitHub-backed first deploy and per-site
  GitHub OAuth App, then uses Wrangler for non-secret config and
  secrets.
- **starters fanout**: alpha.28 re-spins the release fanout so the
  paired starter tarball includes direct scaffold launch-state
  persistence, idempotent top-level Worker var updates, and the
  provider-first `mantle:provision` handoff
  (aotter/mantle-starters#305, #306, #307).

## [0.0.11-alpha.27] - 2026-06-19

### Changed

- **skills/install**: remove the last historical prompt-composition
  warning from the install skill so handoff text describes only the
  deterministic launch-session scaffold path.

## [0.0.11-alpha.26] - 2026-06-19

### Removed

- **skills/docs**: remove the retired two-URL starting prompt docs and
  prompt-composition fallback language so the install path is
  launch-session-first, with direct scaffolder flags only as a manual
  fallback (#369).

### Changed

- **skills/provision**: simplify the provision contract around the
  deterministic flow: validate and push the repo first, guide the user
  through Cloudflare's GitHub-backed first deploy and per-site GitHub
  OAuth App, then let Wrangler write secrets and config (#369).
- **starters fanout**: the paired `mantle-starters` release updates
  scaffolded `mantle/site.md`, repo-local `mantle:provision`, starter
  READMEs, and archetype hints so new generated projects no longer carry
  install-agent prose or first-prompt harness leftovers
  (aotter/mantle-starters#300).

## [0.0.11-alpha.25] - 2026-06-19

### Removed

- **`@aotter/mantle-spec`**: remove the `MANTLE_LETTER_NOT_WRITTEN`
  deploy gate. `mantle validate --phase deploy` no longer blocks a
  fresh scaffold on unfinished prose in `mantle/site.md` (#367).

### Changed

- **skills**: the install handoff now matches the deterministic
  provision-first flow: scaffold, validate, create/push the GitHub repo,
  hand the user through Cloudflare's GitHub-backed first deploy, then
  let Wrangler take over follow-up provider setup (#367).
- **starters fanout**: the paired `mantle-starters` release removes the
  generated letter harness (`mantle:prompt`, the subagent prompt
  template, and `## welcome` card placeholders) and updates repo-local
  `mantle:provision` so missing `pnpm test` scripts are skipped instead
  of reported as failures (aotter/mantle-starters#297).

## [0.0.11-alpha.24] - 2026-06-15

### Changed

- **provision skill**: the provision handoff is now non-coder-first. The
  skill instructs the agent to walk the Cloudflare / GitHub-OAuth browser
  steps one task at a time in plain language — numbered `STEP 1/2 of 2`,
  full-sentence click paths, "what you'll see / what to copy" landmarks,
  a screenshot escape hatch, and a natural reply instead of a `KEY=value`
  contract — replacing the terse engineer checklist (orphan step numbers,
  `A → B → C` breadcrumbs, internal `127.0.0.1` warnings) that a live
  provision run surfaced to a non-coder (#356).
- **starters fanout**: the paired `mantle-starters` release mirrors the
  non-coder handoff guidance in the starter-baked provision skill and
  softens the `provision:plan` report text
  (aotter/mantle-starters#292), and rewrites the generated `site.md`
  `site` / `voice` purpose hints in English
  (aotter/mantle-starters#291).

## [0.0.11-alpha.23] - 2026-06-15

### Added

- **`@aotter/mantle-cloudflare`**: add
  `createSetupIncompleteAuth()` for first-deploy bootstrap windows where
  public Worker routes must boot before staff sign-in providers are
  provisioned (#353).

### Fixed

- **starters fanout**: alpha.23 ships the paired
  `mantle-starters` first-deploy provisioning hardening so public
  routes no longer throw `createAuth: methods[] is empty` before
  GitHub OAuth is configured, while auth/admin/MCP staff routes keep
  returning `setup_incomplete` (aotter/mantle-starters#288).
- **provisioning handoff**: the paired starter release prints a
  concrete Cloudflare Workers & Pages import link, repo/worker-name
  guidance, and the exact values the user should report back before
  `provision:up` (aotter/mantle-starters#288).

## [0.0.11-alpha.22] - 2026-06-15

### Changed

- No SDK runtime code changes. alpha.22 re-spins the release fanout so
  the paired `mantle-starters` release tarball includes the generated
  repo-local `mantle:*` skills, including `mantle:update`, plus the
  generated-site update report/check script for coding agents
  (aotter/mantle-starters#282).

## [0.0.11-alpha.21] - 2026-06-14

### Changed

- No SDK runtime code changes. alpha.21 re-spins the release fanout so
  the paired `mantle-starters` release tarball includes the Windows
  local-dev hardening that should be available before the next
  landing-driven e2e test: starter `emit-openapi` / `emit-types`
  scripts now use Node + `--output` instead of shell redirection, and
  starter `wrangler-dev.mjs` isolates Windows `USERPROFILE`,
  `APPDATA`, `LOCALAPPDATA`, and `WRANGLER_HOME` under the project-local
  `.wrangler-home` (#327, #328, aotter/mantle-starters#264).

## [0.0.11-alpha.20] - 2026-06-14

### Changed

- No SDK runtime code changes. alpha.20 re-spins the release fanout so
  the paired `mantle-starters` release tarball includes the Mantle
  Claude plugin marketplace, `mantle-companion-upload`, and the
  provisioning handoff's operator setup URL for Staff/User MCP plus
  upload-plugin pairing (#324, #349, aotter/mantle-starters#278,
  aotter/mantle-landing#100).
- **skills**: the provision Skill now treats
  `https://mantle.tools/connect?site=...` as part of the final
  owner/operator handoff, including the no-base64 companion upload
  contract (#349).
- **repo**: a Mantle release Skill now documents the release/fanout
  guardrails so future release agents verify downstream starter and
  landing state before tagging (#348).

## [0.0.11-alpha.19] - 2026-06-14

### Changed

- No SDK runtime code changes. alpha.19 re-spins the release fanout so
  the paired `mantle-starters` release tarball includes repo-local
  `.agent/` and `.claude/` Mantle skills, plus generated-site
  references to the embedded docs/skills shipped in
  `node_modules/@aotter/mantle/...` (#345, aotter/mantle-starters#274).

## [0.0.11-alpha.18] - 2026-06-14

### Added

- **`@aotter/mantle`**: the umbrella npm tarball now embeds Mantle
  docs and agent Skills under `docs/` and `skills/`, so generated-site
  agents can read versioned local references from
  `node_modules/@aotter/mantle/...` instead of depending on live GitHub
  raw URLs (#345).
- **`@aotter/mantle-spec`**: Views now support explicit comparison
  filter operators (`gt`, `gte`, `lt`, `lte`) for range-style queries.
- **`@aotter/mantle-cloudflare` / admin UI**: staff management,
  approvals, storefront tracking settings, schema-driven commerce
  relationships, richer media editing, and the develop admin visual
  refresh are included from the post-alpha.16 develop line.

### Changed

- **skills**: install/provision guidance now matches the landing-driven
  user-owned provisioning flow: the user's coding agent creates/pushes
  the private repo, Cloudflare Dashboard performs the first deploy,
  the user owns the per-site GitHub OAuth App, and Wrangler performs
  post-deploy secret/config updates. The base flow no longer asks for a
  broad Cloudflare API token (#345).
- **docs**: locale guidance now clarifies script-subtag rejection, and
  Skill docs align with starter feature overlays and launch-session
  handoff behavior.

### Fixed

- **`@aotter/mantle-spec`**: CLI emit paths are safer on Windows and no
  longer rely on shell redirection for generated artifacts.
- **`@aotter/mantle-cloudflare` / admin UI**: schema editor publishing
  and media upload flows were tightened around runtime use cases.

## [0.0.11-alpha.16] - 2026-05-25

### Added

- **`@aotter/mantle-spec`**: `Trigger.source.kind: "mcp"` is promoted
  from DRAFT to v0.1 (#281). A Trigger may now declare
  `source: { kind: "mcp", surface: "staff" | "public" }` to expose
  its target Procedure as a tool on the matching MCP endpoint. The
  Procedure's own `requires.auth` continues to gate the call; the
  surface only controls discovery in `tools/list`. ADR-0001 updated.
- **`@aotter/mantle-runtime`**: per-Procedure MCP tools land in
  `McpJsonRpcDispatcher` for both surfaces. The dispatcher accepts an
  `invokeProcedure` use case and a procedure list, routes tool calls
  by mangled tool name, and plumbs the bearer-derived McpAuthContext
  into `ctx.{user,staff}` so `requires.auth.all` fires the same way
  HTTP Triggers do (#281). `ValidateBootUseCase` extends
  `MCP_TOOL_NAME_COLLISION` to flag Procedures whose mangled name
  collides with built-in tools, reserved `create_draft_` /
  `update_draft_` / `query_view_` prefixes, or an existing Schema's
  segment.

### Fixed

- **`@aotter/mantle-cloudflare`**: HTTP Trigger ctx now populates
  `user` and `staff` from the Better Auth cookie session instead of
  hardcoded `null`. Any Procedure declaring
  `requires.auth.all: [{ "ctx.staff": [<role>] }]` is now reachable
  over HTTP for staff callers; bearer-only callers still belong on
  the MCP surface (#299, #281). `handleHttpTrigger` mirrors
  `handleViewRequest`'s 401-vs-403 discipline.

## [0.0.11-alpha.15] - 2026-05-24

### Added

- **`@aotter/mantle-runtime`**: render contexts now receive a resolved
  `mediaAssets?: ReadonlyMap<string, MediaAsset>` for entry, list,
  live, preview, and publish paths. The resolver scans entry data for
  `*AssetId`, nested `assetId`, and `*AssetIds` references, batches
  them through `MediaAssetRepository.findManyByIds`, and threads the
  result into consumer templates so starters can emit `<picture>`
  without manually calling `runtime.media.resolveMany`.
- **`@aotter/mantle-runtime`**: MCP media upload flow now includes
  `upload_media_variant`, covering sandboxed-agent uploads where the
  agent requests the upload group first and then PUTs variant bytes
  through the runtime-managed path.
- **`@aotter/mantle-runtime`**: `/llms.txt` and `/:locale/llms.txt`
  have a live-compose fallback, closing the cold-start gap before the
  first publish writes derived cache entries.

### Changed

- **`@aotter/mantle-spec`**: `MediaPurposePolicy.required` accepts an
  `<input accept>`-style grammar, including shorthand image subtypes
  and comma-separated alternatives per required slot. Variant role
  remains independent of slot order.
- **repo**: shared third-party dependency versions now live in the
  pnpm catalog so workspace package manifests do not drift.
- **repo metadata**: package homepages now point at
  `https://mantle.tools/`.

### Fixed

- **release**: `release.yml` now authenticates npmjs explicitly before
  publishing, skips already-published npmjs/GitHub Packages artifacts
  on rerun, mirrors GitHub Packages before dispatching starters, and
  treats an existing GitHub release as an idempotent success. This
  reduces partial-release recovery work after transient registry or
  Actions failures.

## [0.0.11-alpha.14] - 2026-05-20

### Breaking

- **`@aotter/mantle-spec`**: `SiteConfig.media.purposes` reshaped from
  `readonly string[]` to `readonly MediaPurposePolicy[]` —
  `{ name, required: string[], maxBytes: Record<mime, number> }` per
  purpose. `SiteDefaults.media.purposes` matches. New exports
  `MediaPurposePolicy`, `MediaPurposeIssue`. `InvalidMediaPurposesError`
  now carries `issues[]` (structured `{ name, reason, detail? }`)
  instead of `invalidPurposes[]`. See aotter/mantle#272.
- **`@aotter/mantle-spec`**: new diagnostic codes
  `MEDIA_VARIANTS_INCOMPLETE`, `MEDIA_VARIANT_SIZE_EXCEEDED`,
  `MEDIA_VARIANTS_SUSPICIOUS_SIZE`, `MEDIA_ASSET_NOT_FOUND` with
  HTTP 400/400/400/404 mapping.
- **`@aotter/mantle-runtime`**: `MediaAsset` reshaped — required
  `variants: ReadonlyArray<MediaVariant>` replaces the top-level
  `publicUrl` / `storageKey` / `mimeType` / `byteSize`. New helper
  `pickPrimaryVariant(asset)` for renderers that want a single URL.
- **`@aotter/mantle-runtime`**: `MediaStorage` port multi-variant.
  `createUpload` now takes `{ uploadGroupId, purpose, variants[], … }`
  and returns `{ uploadGroupId, capabilities[], expiresAt }`.
  `commitUpload` takes `{ uploadGroupId, variants[], alt?, caption?, now }`
  and returns the full `MediaAsset`. `getPublicUrl` / `deleteObject`
  take `{ storageKey }` only; the asset-id → storage-key lookup
  happens at the use-case layer via `MediaAssetRepository`. Removed
  type alias `DeleteAssetArgs`; added `CreateUploadVariantSpec`,
  `CommitUploadVariantSpec`, `UploadCapability`, `DeleteObjectArgs`,
  `MediaVariant`, `MediaVariantRole`.
- **`@aotter/mantle-runtime`**: MCP `create_media_upload` schema
  changed — `mimeType`/`byteSize` top-level fields replaced by a
  required `variants: [{ mimeType, byteSize, role }, ...]` array.
  `commit_media_upload` takes `uploadGroupId` instead of `uploadId`.
  The per-purpose policy summary (required mimes + per-mime byte
  caps) is inlined into the `create_media_upload` tool description
  so MCP agents see the contract via `tools/list`.
- **`@aotter/mantle-runtime`**: `CreateMediaUploadUseCase` ctor adds
  `IdGenerator` between `clock` and `siteConfig`; drops the
  `maxBytes` opts field (per-purpose caps replace it).
  `CommitMediaUploadUseCase` ctor adds `MediaAssetRepository`; drops
  the `maxBytes` opts field. Adopters constructing these use cases
  directly need to update call sites.
- **`@aotter/mantle-runtime`**: `SiteConfigRepository.readMediaPurposes()`
  returns `readonly MediaPurposePolicy[]` (was `readonly string[]`).
  `McpUseCases.media.purposes` follows the same shape.
- **`@aotter/mantle-cloudflare`**: `CmsConfig.mediaMaxBytes` removed —
  per-purpose caps replace the runtime-wide ceiling. `R2MediaStorage`
  rewritten for multi-variant; storage-key layout is now
  `<purpose>/<uploadGroupId>/<role>.<ext>`. `getPublicUrl` /
  `deleteObject` follow the new port shape. Removed support for the
  `checksum` field on commit — the multi-variant HEAD-verify path
  enforces mime + size invariants; client-side checksums can be
  reintroduced later if needed.
- **`@aotter/mantle-cloudflare`**: admin `POST /admin/api/media/uploads`
  accepts the variants manifest. The commit endpoint is
  `POST /admin/api/media/uploads/:uploadGroupId/commit` (param
  renamed from `:uploadId`).

### Added

- **`@aotter/mantle-runtime`**: `MediaAssetRepository` port and
  `DatabaseMediaAssetRepository` impl for the new `media_assets`
  D1 table (migration `0002-media-assets`). Persists committed
  assets keyed by `MediaAsset.id`; `findManyByIds` batches at
  100 ids per query for the renderer's DataLoader-style consumer.
- **`@aotter/mantle-runtime`**: `runtime.media.resolve(id)` and
  `runtime.media.resolveMany(ids)` materialise `MediaAsset`s from
  entry-data references for the render path.
- **`@aotter/mantle-runtime`**: `image/avif` added to
  `MEDIA_MIME_ALLOWLIST` + `extensionForMime` map.

### Why

See ADR-0017. toa-shop hit two gaps in the pre-#272 media subsystem:
URL-in-entry tied content to bucket identity, and one-artifact-per-
upload made `<picture>` impossible without ugly downstream
workarounds. The fix ships agent-side optimization (`sharp` runs
where it works, not in workerd) + asset-id refs (entries store
`MediaAsset.id` via the existing `x-mantle-ref` extension; renderer
resolves at render time) + per-purpose policy enforcement (required
mime set, per-mime byte caps, suspicious-shape heuristic). The
companion `@aotter/mantle-media-tools` agent CLI ships separately
from `mantle-starters`.

## [0.0.11-alpha.13] - 2026-05-20

### Changed

- **release**: re-spin after `0.0.11-alpha.12` so the fixed release workflow publishes the SDK mirror to GitHub Packages as well as npm.

## [0.0.11-alpha.12] - 2026-05-20

### Changed

- **BREAKING**: complete the public grammar/contract rename from the pre-rename vocabulary to Mantle vocabulary. Manifest `apiVersion` is now `cms.mantle.aotter.net/v1`; extension keys/env vars/internal queue names now use `mantle` naming.
- **release**: re-spin SDK packages so downstream starters can validate the renamed manifest grammar from npm instead of relying on local unreleased SDK builds.

## [0.0.11-alpha.11] - 2026-05-19

### Changed

- Renamed the public SDK packages from the pre-rename scope to `@aotter/mantle*`.
- Updated package metadata, docs, release fanout, and GitHub repository links for the `aotter/mantle` migration.
- Added explicit npmjs.org registry usage in the release workflow so `@aotter/*` publishes through GitHub Actions even when local or org npm config points that scope at another registry.

## [0.0.11-alpha.10] - 2026-05-19

No SDK code changes. alpha.10 re-spins the release fanout to ship starter content that should have been part of alpha.9 (see aotter/mantle-starters#140).

### Why

v0.0.11-alpha.9 made `SiteConfig.media` required and fail-closed `create_media_upload` on undeclared purposes, but the paired `mantle-starters` release tag `v0.0.11-alpha.9` was cut from a starter state that didn't yet declare `siteDefaults.media.purposes` in any archetype's `mantleConfig.ts`. Consumers running `create-mantle@v0.0.11-alpha.9` to scaffold publication / intake / transaction therefore got a starter that fail-closed every `create_media_upload` with `MEDIA_PURPOSE_REJECTED`.

The taxonomy fix landed on `mantle-starters` develop after the alpha.9 tag was already published. alpha.10 republishes the SDK packages so `bump-from-sdk.yml` regenerates the `mantle-starters` v0.0.11-alpha.10 tag + GitHub release tarball with the corrected starter content. See `docs/release-process.md` § "Re-spin release for a downstream-content-only fix" for the recipe; future SDK breaking changes should run the § "Cross-repo type-shape changes" audit to avoid this situation.

## [0.0.11-alpha.9] - 2026-05-19

### Breaking

- **`@aotter/mantle-spec`**: `SiteConfig` gains a required `media: { purposes: readonly string[] }` field (the runtime read shape; always present after seed, possibly empty). `SiteDefaults` (author-time, written in `mantleConfig.ts`) gains an optional `media?: { purposes?: readonly string[] }`. Consumers constructing a `SiteConfig` literal must include `media: { purposes: [] }` at minimum (#262 / #263). Boot-time `assertSiteDefaultsCanonical` now also throws `InvalidMediaPurposesError` if any declared purpose fails the `^[a-z0-9]+(-[a-z0-9]+)*$` slug shape.
- **`@aotter/mantle-runtime`**: `create_media_upload` is now fail-closed on purpose. Calls with a `purpose` not in `siteDefaults.media.purposes`, with a missing `purpose`, or against a deployment that declared no purposes at all are rejected with the new `MEDIA_PURPOSE_REJECTED` diagnostic (HTTP 400). Deployments that previously relied on the unrestricted free-form `purpose` string must declare their taxonomy in `mantleConfig.ts > siteDefaults.media.purposes` before upgrading. There is no warn-and-allow compatibility mode.
- **`@aotter/mantle-runtime`**: `CreateMediaUploadUseCase` constructor signature gains a `SiteConfigRepository` parameter between `clock` and `opts`. Adopters that construct the use case directly (not via `createCmsRuntime`) need to update the call site.
- **`@aotter/mantle-runtime`**: `McpUseCases.media` (used by adopters wiring `McpJsonRpcDispatcher` directly) gains a required `purposes: readonly string[]` field. The dispatcher reads it to mark `create_media_upload`'s `purpose` schema as `required` + emits the declared purposes as an `enum`, so agents see the right contract via `tools/list`.

### Added

- **`@aotter/mantle-spec`**: new exports `SiteMediaConfig`, `SiteMediaDefaults`, `MEDIA_PURPOSE_SLUG_PATTERN`, `InvalidMediaPurposesError`, `MEDIA_PURPOSE_REJECTED` diagnostic code (HTTP 400 mapping).
- **`@aotter/mantle-runtime`**: new port method `SiteConfigRepository.readMediaPurposes()`. `DatabaseSiteConfigRepository` seeds + loads the declared set via the same `INSERT … ON CONFLICT DO NOTHING` discipline as other site config keys, so operator edits via admin Settings stay sticky across deploys.
- **`@aotter/mantle-cloudflare`**: `createMcpApiHandler` rebuilds the MCP tool catalog when `site_config.mediaPurposes` changes within the same isolate. Operator edits take effect without a redeploy; tools/list reflects the current taxonomy.

### Changed

- **`@aotter/mantle-cloudflare`**: `create_media_upload` / `commit_media_upload` MCP tools are hidden from `tools/list` when either `mediaStorage` is unbound OR `siteDefaults.media.purposes` is empty (previously only the former). Symmetric "no first-party media uploads" gate.
- **`@aotter/mantle-cloudflare`**: `create_media_upload` MCP schema marks `purpose` as required and emits the declared `siteDefaults.media.purposes` as a JSON Schema `enum` so agents reading `tools/list` self-correct without a round trip.

## [0.0.9-alpha] - 2026-05-15

### Breaking

- **`@aotter/mantle-cloudflare`**: MCP OAuth surface carved out from Better Auth's `mcp()` plugin to `@cloudflare/workers-oauth-provider`. Better Auth keeps owning staff sign-in (D1 session, role, social/email-OTP/magic-link), but the OAuth AS surface (`/.well-known/oauth-*`, DCR, PKCE, token issue) is now served by `OAuthProvider` at the top level of the worker module. **Adopter migration**: `export default new Hono({...}).fetch` → `export default new OAuthProvider({...})`, where the Hono app becomes `defaultHandler` and each MCP endpoint becomes an entry in `apiHandlers`. New SDK exports: `createOAuthProvider`, `createMcpApiHandler`, `mountAuthorize`. Removed: `mountMcp`, `mountOAuthEndpoints`, `WorkersOAuthVerifier` (the lib does bearer verification internally before calling `apiHandler.fetch` with `ctx.props` set). See `docs/adr/0014-...md` § "Amendment 2026-05-15" for empirical context.
- **`@aotter/mantle-cloudflare`**: staff MCP resource path renames from `/staff/mcp` to `/mcp/staff`. claude.ai's MCP OAuth client (verified 2026-05-15 against `the legacy MCP test deployment`) silently drops the session after a server-correct `/token` success when the resource path doesn't start with `/mcp`. `/mcp` for the public MCP endpoint is unchanged. The `/admin/api/site` response field `mcpUrl` / `staffMcpUrl` automatically reflect the new path, so admin UI copy-fields update without consumer code changes — adopter-hardcoded references (skill docs, custom routes) need to migrate.
- **`@aotter/mantle-cloudflare`**: OAuth `scopes_supported` collapses from `["mcp:read", "mcp:staff"]` to a single `["mcp"]` (no colon). claude.ai silently omits `scope=` from `/authorize` when `scopes_supported` contains colons, producing a zero-scope token grant the client then rejects post-token. Staff vs public differentiation moves entirely server-side: the SDK enforces admin role via D1 lookup inside `createMcpApiHandler` based on the `surface: "staff" | "public"` option, not via OAuth scope. The default scope is overridable via `createOAuthProvider({ scopesSupported })`.
- **`@aotter/mantle-cloudflare`**: OAuth endpoint URLs namespace under `/oauth/*` (was `/api/auth/mcp/*` via Better Auth). claude.ai web reads AS metadata (RFC 8414) so the namespace is followed correctly. Adopters who hard-coded `/api/auth/mcp/{authorize,token,register}` references in scripts or external configs need to update.
- **`@aotter/mantle-cloudflare`**: `Auth.getMcpSession()` removed. The OAuth lib verifies bearer tokens against its KV grant store and sets `ctx.props` before calling `apiHandler.fetch` — adopters read identity from `ctx.props.{userId, role}`, no port indirection.
- **`@aotter/mantle-cloudflare`**: `CreateAuthConfig.betterAuthOptions?: Partial<BetterAuthOptions>` escape hatch (added in `0.0.8-beta.4` via PR #175) is removed. With the carved-out OAuth surface the SDK no longer needs adopters to reach un-curated Better Auth internals; the remaining adopter surface (`methods[]`, `rateLimit`, `bootstrapOwner`) is fully first-class. Apple's `trustedOrigins` auto-append and `sameSite=none` cookie injection stay; only the un-curated passthrough is retracted. ADR-0014 § "Auth as contract, Better Auth as default" framing remains correct — only the §"Implementation status" reference to `betterAuthOptions` is retracted.

### Added

- **`@aotter/mantle-cloudflare`**: new dependency `@cloudflare/workers-oauth-provider@^0.6.0`. Top-level OAuth provider library that owns DCR + PKCE + token issue + KV grant store. The SDK exports thin helpers (`createOAuthProvider`, `createMcpApiHandler`, `mountAuthorize`) so adopters compose the worker entrypoint declaratively.
- **`@aotter/mantle-cloudflare`**: new SDK exports `createOAuthProvider({ defaultHandler, apiHandlers, scopesSupported? })`, `createMcpApiHandler({ ref, surface })`, `mountAuthorize({ auth, loginPath? })`, plus path constants `OAUTH_{AUTHORIZE,TOKEN,REGISTER}_PATH`.
- **landing**: new `OAUTH_KV` binding alongside the existing `KV`. Holds the OAuth provider's clients / grants / tokens; separate namespace so future cleanup can wipe it independently.

### Changed

- **docs**: ADR-0014 amended with the empirical findings (§ "Amendment 2026-05-15"). `docs/adapter-guide.md` updated for the new MCP mount pattern. `skills/provision/SKILL.md` updated to point operators at `/mcp/staff`.

## [0.0.8-beta.5] - 2026-05-14

### Breaking

- **`@aotter/mantle-cloudflare`**: `mountMcp` now serves the OAuth Protected Resource Metadata document at the [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) §3.1 standard URL — `/.well-known/oauth-protected-resource<resource-path>` instead of the previous (non-standard) `<resource-path>/.well-known/oauth-protected-resource`. Example: a staff MCP at `/staff/mcp` now publishes metadata at `/.well-known/oauth-protected-resource/staff/mcp`. The `WWW-Authenticate: Bearer ... resource_metadata=` hint emitted on 401 responses also points at the new URL, so MCP clients that follow the hint (Claude Code does) re-discover automatically on next call; spec-strict clients that compose the well-known URL themselves now succeed. New helper `protectedResourceMetadataPath()` is exported from the package index for downstream consumers that need to compute the URL themselves (#188).

## [0.0.8-beta.4] - 2026-05-14

### Added

- **`@aotter/mantle-cloudflare`**: `CreateAuthConfig` gains `betterAuthOptions?: Partial<BetterAuthOptions>` — the curated escape hatch for raw Better Auth options the SDK doesn't surface as first-class fields. Per ADR-0014 § "Auth as contract, Better Auth as default" we refuse to add `CreateAuthConfig` fields just to forward a Better Auth knob verbatim (e.g. `account.accountLinking`, `emailOTP.storeOTP`/`.resend`/`.disableSignUp`, extra plugins like `twoFactor()`, `advanced.defaultCookieAttributes`); adopters reach those via this passthrough. Merge semantics: (a) top-level keys we don't manage pass through verbatim; (b) SDK-managed top-level keys (`database`, `secret`, `baseURL`, `socialProviders`, `rateLimit`) replace adopter values wholesale; (c) `advanced` / `user` / `databaseHooks` are MERGED one level deep — SDK leaves `advanced.backgroundTasks`, `user.additionalFields.githubLogin`, and `databaseHooks.user.create.after` SDK-owned (adopter's `create.after` composes BEFORE SDK's bootstrap promotion when both are set) while letting other entries pass through (`advanced.defaultCookieAttributes`, `user.additionalFields.foo`, `databaseHooks.session.*`); (d) `plugins` are concatenated with id-dedupe so adopter dups of SDK plugin ids (`admin`, `mcp`, `email-otp`, `magic-link`) are dropped — Better Auth does NOT dedupe internally so duplicates would double-fire hooks; (e) `trustedOrigins` is array-merged (Set dedupe), and function-form `(req?) => Awaitable<string[]>` is wrapped so SDK auto-origins still ride.
- **`@aotter/mantle-cloudflare`**: `createAuth` auto-appends `https://appleid.apple.com` to `trustedOrigins` when a `social` method with `provider: "apple"` is registered. Apple uses `response_mode=form_post` (Apple POSTs cross-site to the callback) — Better Auth's default state cookie is `sameSite: "lax"` which does NOT ride a cross-site POST, surfacing as an opaque "state mismatch". The SDK now also auto-injects `advanced.defaultCookieAttributes: { sameSite: "none", secure: true }` whenever Apple is registered (adopter's explicit `sameSite` always wins — power users opt out by overriding). Other social providers don't currently demand auto-origins or cookie tweaks.

### Added

- **`@aotter/mantle-cloudflare`**: new export `appleClientSecret()` — signs the ES256 JWT Apple requires for "Sign in with Apple". Apple's `clientSecret` field is a JWT derived from team id + key id + the `.p8` private key + the Services ID audience; the helper does it in ~80 LOC against `crypto.subtle` (no `node:crypto`, no third-party JWT lib). Defaults to a 30-day JWT lifetime; rejects above Apple's 180-day cap. Adopter usage: `await appleClientSecret({ teamId, keyId, privateKey, audience })` → feed the returned string as the Apple method's `clientSecret`. Accepts both PEM-wrapped `.p8` contents and bare base64 of the DER (#172).

### Breaking

- **repo**: `engines.node` bumped from `>=20` to `>=22`. Wrangler 4 requires Node 22+ at runtime; consumers, CI workflows, and contributor machines must update. Local: `nvm install 22 && nvm use 22`. CI step `actions/setup-node@v4` now sets `node-version: 22` (#170).
- **`@aotter/mantle-cloudflare`**: dev dependency `wrangler` bumped from `^3.103.2` to `^4.0.0`, and peer-aligned `@cloudflare/workers-types` from `^4.20251101.0` to `^4.20260508.1`. Adopter starter projects deploying via the Cloudflare adapter inherit the Node 22 floor. Motivation: Cloudflare surfaces an explicit out-of-date warning for wrangler 3 on every deploy, and known v3 dev-server cleanup bugs (orphan `workerd` holding the local port across Ctrl+C / terminal close) won't be back-ported (#170).
- **`@aotter/mantle-cloudflare`**: `AuthMethodConfig` collapses the `kind: "github"` case into the new generic `kind: "social"` discriminated by `provider`. Mirrors Better Auth's own `socialProviders` block shape and unlocks ~35 upstream IDPs (`google`, `apple`, `microsoft-entra-id`, `facebook`, `discord`, `twitter`, `linkedin`, `spotify`, `twitch`, `gitlab`, `tiktok`, `reddit`, `kick`, `vk`, `naver`, `kakao`, `line`, `slack`, `atlassian`, `zoom`, `notion`, `figma`, `linear`, `vercel`, `paypal`, `huggingface`, `cognito`, `salesforce`, `polar`, `railway`, `roblox`, `paybin`, `wechat`, `dropbox`, plus `github`). Adopter migration: `{ kind: "github", clientId, clientSecret }` → `{ kind: "social", provider: "github", clientId, clientSecret }`. `bootstrapOwner: { match: "github-login" }` continues to work; the internal `mapProfileToUser` shim still populates `user.githubLogin` when `provider === "github"`. Provider-specific fields (Apple's `teamId` / `keyId` / `privateKey`, Microsoft Entra ID's `tenantId`, etc.) ride via the new `extras?: Record<string, unknown>` field merged verbatim into Better Auth's per-provider config (#166).
- **`@aotter/mantle-cloudflare`**: `Auth.methods` now returns structured `AuthMethodInfo[]` objects instead of `AuthMethodKind[]` strings — `{ kind: "email-otp" } | { kind: "magic-link" } | { kind: "social"; provider }`. The `GET /api/auth/methods` endpoint reflects the new shape so the admin SPA can dispatch per-provider (#166).

### Added

- **`@aotter/mantle-runtime`**: new optional port `EmailSender` (`domain/port/EmailSender.ts`). Transactional-email contract for features that need to send mail — passwordless sign-in, order receipts, etc. The SDK never owns email body templates; the port hands the sender a `locale` (BCP 47) so adopter-supplied senders branch on language without the runtime owning translation tables (#158).
- **`@aotter/mantle-cloudflare`**: new `AuthMethodConfig` union case `{ kind: "email-otp", sender, otpLength?, expiresInSeconds?, allowedAttempts?, fallbackLocale? }`. Better Auth's `emailOTP` plugin wires in; locale resolves from request `Accept-Language` falling back to `fallbackLocale`. Plays alongside `github` via the `methods[]` array — adopters mix-and-match. Per ADR-0014 (#158).
- **`@aotter/mantle-cloudflare`**: new `ConsoleEmailSender` dev impl — logs the email body instead of sending. Convenience for `wrangler dev`; not for production wiring (#158).
- **`@aotter/mantle-cloudflare`**: new endpoint `GET /api/auth/methods` returning `{ methods: AuthMethodKind[] }` for the registered sign-in methods. Secrets and sender refs are intentionally excluded — the admin SPA reads this to render per-method UI sections without baking the method list into its build (#159).
- **`@aotter/mantle-cloudflare`**: `Auth.methods` field on the returned `Auth` interface — the in-order list of method kinds. Adapters / mount code can introspect what's wired (#159).
- **`@aotter/mantle-admin-ui`**: SignInView is now data-driven — fetches `/api/auth/methods` on mount and renders one section per registered method. When `email-otp` is registered, a two-step inline form (email → 6-digit code). When `github` is registered, the existing social button. Multiple methods stack with separators. Adding a new method (passkey, google) becomes a new section + new i18n keys, not new SignInView code (#159).
- **`@aotter/mantle-admin-ui`**: i18n key family `auth.signIn.method.<kind>.*` for per-method labels + body text + error states. EN canonical; zh-TW and ja carry translations for the email-OTP UI; other languages fall back to EN per the documented chain (#159).
- **`@aotter/mantle-cloudflare`**: new `AuthMethodConfig` union case `{ kind: "magic-link", sender, expiresInSeconds?, allowedAttempts?, fallbackLocale? }`. Better Auth's `magicLink` plugin wires in; `sendMagicLink` dispatches the click-URL through the configured `EmailSender` with category `auth.magic-link.sign-in`. Singleton-per-config like `email-otp`. Rate-limit default now fires when either `email-otp` OR `magic-link` is registered (#164).
- **`@aotter/mantle-admin-ui`**: `MagicLinkSection` added to SignInView — single email field → "check your inbox" confirmation state. POSTs to `/api/auth/sign-in/magic-link` with `callbackURL: returnTo` so the email link lands on the original destination after verification. New `auth.signIn.method.magic-link.*` i18n keys; EN/zh-TW/ja translated (#164).
- **`@aotter/mantle-admin-ui`**: generic `SocialSignInSection` replaces the GitHub-only button. Renders one button per registered social method, label templated from `auth.signIn.method.social.button` ("Continue with {provider}") with a brand display-name table (`SOCIAL_PROVIDER_DISPLAY_NAME`) so e.g. `microsoft-entra-id` → "Microsoft", `huggingface` → "Hugging Face". Brand names aren't translated; only the "Continue with" wrapper is, in EN/zh-TW/ja (#166).

### Changed

- **`@aotter/mantle-admin-ui`**: `auth.signIn.body` reworded from GitHub-specific framing ("GitHub OAuth keeps this console limited to your staff list.") to method-neutral ("Staff console. Access is gated by role after sign-in."). EN canonical updated; zh-TW + ja translations added; remaining languages fall back to EN per the documented chain (#159).

### Breaking

- **`@aotter/mantle-cloudflare`**: `CreateAuthConfig` reshaped. `github?: {…}` + `adminGithubLogin?: string` removed; replaced with `methods: AuthMethodConfig[]` (discriminated union, currently `{ kind: "github", … }`) + `bootstrapOwner?: BootstrapOwnerRule` (`{ match: "github-login" | "email", value: string }`) + optional `rateLimit: { window, max }` passthrough to Better Auth's built-in. Boot fast-fails on empty `methods`; constructor cross-checks that `bootstrapOwner: { match: "github-login" }` has a matching `github` method registered. Substrate for upcoming email-OTP / magic-link / Google methods per ADR-0014. Adopters: wrap GitHub config as `methods: [{ kind: "github", clientId, clientSecret }]` and move `adminGithubLogin` to `bootstrapOwner: { match: "github-login", value: ADMIN_GITHUB_LOGIN }` (#157).

## [0.0.8-beta.1] - 2026-05-13

First beta on the road to v0.1.0. Channel moves from `alpha` to `beta` — packages now ship under the `beta` dist-tag. All `0.0.x-alpha` versions are superseded by this release and have been deprecated on npm.

### Added

- Runtime parent-join across all four render paths (live entry / live list / preview / publish-time KV pipeline). Implements ADR-0010's declared "render path joins translation to parent on slug" behavior, which had been deferred since the rebuild — templates that expect parent-level fields (`posts.coverUrl`, `posts.authorId`, `posts.publishedAt`) on `entry.data` now see them on a child `post-translations` row without manual denormalization. New `JoinedEntryReader.joinParentIfTranslation` (single) + `joinParentForList` (batched with `IN (?, ...)` + dedup to avoid N+1) (#145).
- Install Skill workflow gate under Auto Mode clause 4 — reframes `npx create-mantle` invocation as a destructive action under the harness's own carve-out, so per-parameter user authorization survives the auto-mode "minimize interruptions" reminder. Replaces the prior ASK-override that triggered echo-conflict (#145).
- Picker-style archetype probes — `publication/SKILL.md` (and the install Skill's multi-round purpose discovery stance) converted from open-ended questions to 5 multiple-choice probes, leading with "what's this publication for" (mantle-starters #31).
- Audience-explicit interview — locale choice now derives from a user-stated audience scope (domestic / which country / international), not inferred from the user's writing language.

### Changed

- `publication/src/mantleConfig.ts`: `brand` / `title` / `description` now use `{{BRAND}}` / `{{DESCRIPTION}}` placeholder macros instead of literal `"Mantle Publication"` fallbacks. Real installs no longer seed D1 `site_config` with the literal default (mantle-starters #31).
- Install Skill cover-image source switched from the deprecated `source.unsplash.com` (2023 end-of-life, returning 503) to LoremFlickr; verification uses GET (not HEAD — Cloudflare-fronted image services reject HEAD with 405) (#145).
- `publication` / `presence` / `intake` Header components hide the language popover when `localesAvailable.length <= 1` — monolingual sites no longer render a single-item dropdown.
- `docs/release-process.md` clarifies that the retired `create-mantle` package is intentionally not published to npm; consumers invoke it via `npx <github-release-tarball-url>` (#146).
- `CLAUDE.md` "Where things live" table now surfaces `docs/release-process.md`, `CONTRIBUTING.md`, `CHANGELOG.md`; README adds quick-links so release / contribution docs are discoverable from the repo entry points (#146).

### Removed

- zh-TW illustrative blocks across install Skill, publication archetype hint, and editor first-prompt template. Skill bodies are EN-only; the agent renders output in the user's language at native register. Reverses a regression from earlier alpha cycles where translation examples leaked back in.

## [0.0.8-alpha] - 2026-05-12

### Added

- ADR-0016 site semantic layer: `AGENTS.md` (cross-tool entry) + `mantle/site.md` (Mantle's frontmatter + section bodies), filled from `{{PLACEHOLDER}}` templates and updated atomically (#107).
- Retired `create-mantle` npx scaffolder: fetches the starters monorepo tarball, merges `_common/` + `<archetype>/`, substitutes ADR-0016 placeholders, prints RUN_NOTES JSON. Replaces the manual `curl … | tar -xzf` + `setup:site` ritual (#109).
- 8 archetype briefs under `skills/install/archetypes/` — 4 ready/extension (`presence`, `publication`, `intake`, `blank`) + 4 roadmap-refuse (`transaction`, `reservation`, `community`, `membership`) (#110).

### Changed

- `skills/install/SKILL.md` rewritten as a Mantle-persona interview brief (~140 lines, down from 396); no more `mantle_request:` YAML block — Mantle gathers `brand` / `locales` / GitHub identity by conversation (#110).
- `skills/provision/SKILL.md` realigned to Mantle voice on user-facing strings; updates `mantle/site.md` `site_url:` + `revisions:` after deploy per ADR-0016. Stale `--seed-file` / `seed:initial` references removed (#111).
- `docs/prompts/` collapsed to single-sentence two-URL format; SKILL_INSTALL_URL + SKILL_ARCHETYPE_URL replace the YAML block (#110).
- CLAUDE.md table points at the starters monorepo `aotter/mantle-starters` (admin rename of `mantle-starters` is pending; auto-redirect keeps the old URL working).

### Removed

- `starters/blank/` migrated out of this SDK monorepo into `aotter/mantle-starters/blank/`. SDK keeps a stub README pointing outward, same engineering forcing function as `packages/adapters/netlify/` (#108).
- `pnpm-workspace.yaml` no longer includes `starters/*`; root `check:starters` script removed.

## [0.0.7-alpha] - 2026-05-10

### Added

- Contributor governance docs: contributing guide, issue templates, PR template, label guide, release process, security policy, and code of conduct.
- Website archetype ADR for the official-site selector (`presence`, `publication`, `intake`, `transaction`, `reservation`, `community`, `membership`).
- R2-backed media upload lifecycle: create upload, direct PUT, commit, and MCP/admin endpoints.
- Better Auth-backed admin and MCP OAuth/DCR wiring with dual `/staff/mcp` and `/mcp` surfaces.
- Deferred lifecycle after-hook delivery via an optional adapter dispatcher and Cloudflare Workers Queue implementation.

### Changed

- Publication starter replaces the older blog naming and carries the v0.1 agent-provisioned site path.
- Runtime authoring paths now share entry validation for schema `pattern`, `format`, locale membership, unique indexes, and translates parent checks.
- Provision/install docs and Skills now target `0.0.7-alpha`.

## [0.0.6-alpha] - 2026-05-08

### Added

- Alpha rebuild packages and starters for the v0.1.0 development line.

[0.0.8-alpha]: https://github.com/aotter/mantle/compare/v0.0.7-alpha...v0.0.8-alpha
[0.0.7-alpha]: https://github.com/aotter/mantle/compare/v0.0.6-alpha...v0.0.7-alpha
[0.0.6-alpha]: https://github.com/aotter/mantle/releases/tag/v0.0.6-alpha
