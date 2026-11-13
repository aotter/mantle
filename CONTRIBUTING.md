# Contributing to Mantle

This file and accepted ADRs are the tool-neutral authority for human and agent
contributors. Historical issue plans explain migrations; the checked-out
source, tests, package READMEs, and accepted ADRs define the current contract.

## Product and architecture contract

Mantle Core is an embeddable manifest engine. It compiles manifests into native
SQL and typed TypeScript. Consumers
generate selected queries and bind their own native handles and verified Caller,
or compose optional REST, MCP, web, auth and separate Admin/UI modules. The parser
and linker are private compiler implementation, not public consumer exports.
`mantle generate <target> <output-directory> <manifest>...` writes generated
artifacts and selected Workers build settings; applications own their entry,
routes, auth and resources. It does not scaffold a website or service preset.
A directly authored reference consumer validates the package contract.

The sealed build-time pipeline is:

```text
ManifestSourceSet -> parse -> link -> compile -> native SQL + generated TypeScript
```

Applications pass native database handles and their own verified Caller to generated
queries. The compiler owns grammar, diagnostics, SQL allowlist and row policy;
request code does not interpret a RuntimePlan. Public APIs remain usable by human engineers without a generated Starter.

[ADR-0045](docs/adr/0045-next-runtime-core.md) defines the native dialect/driver,
generated Store and row-policy ownership. Authors own application routing,
auth configuration, migrations and side effects; scope/auth, OCC, atomicity and
uncertain commit outcomes remain required.

| Package | Responsibility |
|---|---|
| `@aotter/mantle` | Native SDK, generator and `mantle` CLI. Request modules live in `src/kernel` and selected `src/auth`; the single private compiler closure lives in `src/build`. |
| `@aotter/mantle-ui` | Pure UI and the framework-free controller, with no SDK or server dependency. |
| `@aotter/mantle-admin` | Optional native Admin API, application-built React Admin, public slots/hooks, developer workspace, design preview and MCP App; SDK peer and shared UI dependency. |

Applications own frontend MCP App entries and domain pages. They may use the
official ext-apps client and optional pure UI without Admin. Core accepts generic
resources and enforces endpoint/renderer ownership; Admin owns its built-asset
identity and thin official-client adapter. Do not add another bridge package,
provider, slot registry or query cache beside the application-built composition.

Extension points are opened on evidence. An application that works around the SDK
(re-implementing its logic, patching a package, importing an undocumented entry)
files an "Extension point request" and marks the workaround
`drop when aotter/mantle#N`. Repeated requests for one need decide the design.
Values the SDK returns are in one normal form; accept unions only in parameters,
so wrapping a returned value never needs the SDK's own normalisation.

`skills/*` are versioned consumer product artifacts. Maintainer instructions
live at the repository root and in `.agents/skills`; do not merge the two
audiences or copy maintainer policy into shipped skills.

### Application seams

Some public entry points exist on purpose for hand-written application code beyond mounting the generated modules:
running the application's own SQL in a Store transaction, reading a JSON body on its own route, calling a generated
tool or applying the generated input conversion directly, serving its own MCP tools and Apps, issuing extension-grant
tokens, registering a page's app tools. Each is listed, by the capability it gives, in the registry
[`packages/mantle/tests/application-seams.ts`](packages/mantle/tests/application-seams.ts), with the stacks it applies
to and the decision that keeps it. Its hand-written consumer module is typechecked against the built package and run on
those stacks by `application-seams.test.ts` in Core and Admin, part of `pnpm test` and of PR CI.

- Removing, moving or narrowing a registered seam (a subpath, export, parameter, option or its behaviour) needs an
  accepted ADR or ADR-lite and a migration note in the release notes that names the replacement. Moving plumbing under
  `./internal/` is such a move when a seam lives there.
- Adding public surface for applications adds a registry entry and its consumer module in the same PR.
- Describe a seam by the generic capability only, with invented, neutral fixtures.

## Hard invariants

- `src/build/spec` keeps the closed v2 grammar (`cms.mantle.aotter.net/v2`), diagnostics
  and SQL allowlist. Grammar changes require an accepted ADR amendment.
- Compiler code stays build-time only. `src/kernel` and `src/auth` do not import
  `build`, `domain`, `usecase`, `infrastructure`, Admin, or another SDK.
- Generated operations call only the selected native driver and dialect. Bare
  query output preserves native driver values, except that Store rows return
  `version` as a number; selected HTTP/MCP/Admin boundaries own static
  declared-column transport conversion, including exact stored int64 text.
- Auth, REST, MCP, web, site/media and Admin remain selected capabilities.
  Better Auth and the MCP SDK load on a matching request, outside Worker startup.
  The application writes `auth.ts` and resolves Caller; Mantle does not wrap Auth.
- Runtime runs no DDL or boot-time schema checks. Apply initial `schema.sql` to an
  empty database; application authors own migrations.
- Scope/auth, publishing visibility, explicit OCC, atomic writes and uncertain
  commit outcomes remain enforced. Input at transport boundaries uses generated
  checks; never remove data-loss protection, security or accessibility to meet size.
- Every `exports` subpath of `@aotter/mantle` is classified in `packages/mantle/tests/public-surface.test.ts`: developer
  API (documented, a compatibility promise), host platform contract (versioned, names and paths stay), or generated-code
  plumbing under `./internal/*` (no promise; only `mantle generate` output imports it).
- Generated module imports perform no kernel initialization. Store metadata is
  initialized once on first `store()`, with database/Caller/handlers bound per call.

### Clean architecture

```text
kernel <- domain <- usecase <- infrastructure
                   build-time compiler: src/build
```

- `kernel/` contains native request primitives. `auth/` owns selected Auth integration.
- `domain/` does not import `usecase/` or `infrastructure/`; `usecase/` does not
  import `infrastructure/`. Build-time layers may consume the one private compiler.
- Infrastructure owns source loading, CLI envelopes and deployment assembly.
- The pure UI imports no SDK or server. Admin composes generated authorized reads,
  native Procedures and generated validators; it does not become a second Store.
- Each rule has one source owner. Reuse compiler/dialect/native helpers rather
  than duplicate SQL policy, schema interpretation, routing or resource management.

## Local setup and checks

Requirements: Node.js 22.22 or newer and pnpm 9 or newer.

```bash
pnpm install --frozen-lockfile
pnpm check:pg   # pnpm check + test:native against a throwaway PostgreSQL
```

Formatting is owned by Biome: run `pnpm format`, and `pnpm check` fails on
unformatted source. Brevity is measured in logic, not characters: "one line"
and "shortest diff" mean the least logic, never the fewest physical lines or
the shortest identifiers. Startup budgets are measured on minified output, so
readable names and layout are free; the one exception is the runtime kernel,
where object property names and string literals survive minification and do
cost bytes.

`pnpm check` runs the boundary, skill, plugin-manifest and release
self-checks, builds, compiles the documented examples, typechecks, tests the
workspace and runs the reference service from exact packed tarballs. Use
package filters while iterating. Native four-target conformance is separate
(`pnpm --filter @aotter/mantle test:native`, Bun 1.3.14).

Mantle commits to three production stacks: `cloudflare-d1`, `cloudflare-postgres` (postgres.js, usually through
Hyperdrive) and `bun-postgres` (Bun.SQL). A change that touches what applications run works, is typed and is tested on
all three; a capability that is inherently dialect-specific says which of them it covers. `bun-sqlite` remains a
generate target and stays in the native four-target conformance.

PostgreSQL is a first-class target. Its tests skip unless `MANTLE_PG_URL`,
`MANTLE_NEXT_BUN_PG_URL` and `MANTLE_NEXT_WORKER_PG_URL` name a disposable
database, and `pnpm check` then ends with a `PostgreSQL tests SKIPPED` line.
`pnpm check:pg` runs `pnpm check` and `test:native` against a throwaway local
cluster (`scripts/with-postgres.mjs`: initdb in a temp directory, deleted
afterwards; as root it runs the server as `postgres` or `nobody`); with the
three variables already set (for example a `postgres:16` container) it uses
them instead. `pnpm with-pg <command>` runs any command the same way, such as
`pnpm with-pg pnpm --filter @aotter/mantle test`. A PR's local evidence is
`pnpm check:pg`, and the PR body states whether that or plain `pnpm check` ran.

Every ready PR into `develop` runs the PR CI (`.github/workflows/ci.yml`), for every author; drafts skip until marked
ready. It builds once in each of two parallel jobs: typecheck plus boundaries, skills, plugin manifests, startup
graphs/budgets and release/packed-consumer self-tests; and the three packages’ tests, including every PostgreSQL test,
against a PostgreSQL 16 service, then `test:native`. Both must pass the required `Typecheck + tests` status. Dependabot
patch and digest bumps merge automatically once it is green. A PR into `main` (promotion or hotfix) runs the
**Full checks** workflow instead, and there `Typecheck + tests` passes only when the whole suite does.
Build typechecks library sources; `pnpm typecheck` checks the remaining test,
app, example and config roots (including their imports). Run build first.
Build before running package tests locally; `pnpm test` does not rebuild or pack.
Package and upload bytes are reports; cold-start checks remain gates.

Full checks (`.github/workflows/full-checks.yml`) also runs by hand
(Actions → Full checks → Run workflow on the branch). Do that before every release, alpha included (an alpha releases
from `develop` and never passes the `main` gate), before merging a change to the PostgreSQL driver/dialect, auth, the
kernel request pipeline or generator output, or when an Admin UI change may behave differently on Linux. It runs native
four-target and Wrangler/D1 integrations, packed-consumer checks, doc examples,
OSS plugin validation, the two Chrome sandbox-boundary tests (design preview
and MCP App host bridge), and size reports. Run the boundaries locally with
`pnpm --filter @aotter/mantle-admin test:browser` and Chrome installed. The
Admin sign-in/list/edit/publish/translation browser flow is covered by maintainer
manual acceptance; the packed worker-consumer smoke checks the service and Admin
API round trip. Shared Store, publishing and search scenarios run through
`test:native`; focused unit tests retain security and correctness invariants.
`pnpm check:pg` is the broad local/release check.

The `cloudflare-postgres` target runs the generated code in workerd under local
Wrangler with a Hyperdrive binding whose `localConnectionString` points at the
test database. Cloudflare documents that this mode connects "directly to the
database without going through Hyperdrive" and that "Hyperdrive's connection
pooling and query caching do not take effect". It therefore shows the Worker
runtime, `nodejs_compat`, postgres.js and transactions, but not Hyperdrive's
transaction-mode pooling, named prepared statements through the pooler, query
caching, or its connection and statement limits. A claim about those needs a
deployed Hyperdrive configuration; `wrangler dev --remote` uses one, but runs on
Cloudflare against that configuration's real database, so it is an opt-in
maintainer check with a dedicated database, never CI.

## Branches, commits, and pull requests

- `develop` is the integration branch. `main` moves only through deliberate
  release promotion.
- Branch from `origin/develop` with `feat/issue-N-topic`,
  `fix/issue-N-topic`, `docs/issue-N-topic`, or `chore/issue-N-topic`.
- Use conventional commit subjects. Keep each commit and PR coherent and
  reviewable.
- Open PRs against `develop`. `main` is the repository's default branch, so
  GitHub's pull-request prompt and a bare `gh pr create` target `main` instead;
  pass `--base develop` and check the base before you open. Only promotion and
  hotfix PRs target `main`. Human-authored PRs merge with a merge commit.
  Dependabot patch and digest updates are the only rebase-merge exception;
  minor and major dependency updates require human review. Do not squash.
- Before merge, update the branch with its base and pass the required checks on
  that combined state.
- Start non-trivial work from an issue. Use the templates and labels described
  in [`docs/labels.md`](docs/labels.md).
- A PR body states outcome, scope/non-goals, commands actually run, omitted
  checks, and related issues/ADRs. Use `Closes #N` only when complete.
- Architecture, grammar, persistence, trust-boundary, auth, MCP, and public
  transport changes need an existing accepted decision or an ADR-lite/ADR as
  appropriate.

The canonical public change history is GitHub Releases, generated from PR
metadata through `.github/release.yml`. Do not add version entries to
`CHANGELOG.md`.

## Release and security

Release mechanics are governed by [`docs/release-process.md`](docs/release-process.md)
and the canonical [maintainer release skill](.agents/skills/mantle-release/SKILL.md).
No task implies permission to publish.

Both branches require one approving review, and while `@guyspy` is the sole
owner in `.github/CODEOWNERS`, every release PR is authored by the account that
administers the repository. GitHub does not permit self-approval, so no
reviewer is obtainable and the organization-admin ruleset bypass is the normal
merge path for version and promotion PRs, not an exception. Record the reason
and the resulting state on each bypassed PR so it stays auditable. Outside the
release sequence, prefer a reviewed merge; the bypass is for cases where review
is genuinely unavailable or the repository needs recovery.

Do not file public vulnerability issues. Follow [`SECURITY.md`](SECURITY.md).

## Public/private boundary

- This repository is public. Keep private service source references, internal
  implementation details, operational handoffs, tenant identifiers and access
  lifecycle evidence in private storage. Public documents, issues, PR bodies,
  comments and generated metadata should contain Core contracts and generic
  validation evidence only. Review generated bundles for internal metadata.
