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

`skills/*` are versioned consumer product artifacts. Maintainer instructions
live at the repository root and in `.agents/skills`; do not merge the two
audiences or copy maintainer policy into shipped skills.

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
pnpm check
```

`pnpm check` runs the boundary, skill, plugin-manifest and release
self-checks, builds, compiles the documented examples, typechecks, tests the
workspace and runs the reference service from exact packed tarballs. Use
package filters while iterating. PostgreSQL tests skip unless `MANTLE_PG_URL`
names a disposable database; native Bun conformance is separate
(`pnpm --filter @aotter/mantle test:native`, Bun 1.3.14).

Maintainers merge on a local `pnpm check` (judge by its exit code) plus review; CI does not gate their PRs, and a
failure found later is fixed forward. PR CI runs only for PRs from outside the organization (forks, bots).
PR CI builds once in each of two parallel jobs: typecheck plus boundaries,
skills, plugin manifests, startup graphs/budgets and release/packed-consumer
self-tests; and the three packages’ tests running concurrently. Both jobs use
the pnpm store cache and must pass the combined required status.
PR tests skip PostgreSQL; Full checks retains PostgreSQL-backed coverage.
Build typechecks library sources; `pnpm typecheck` checks the remaining test,
app, example and config roots (including their imports). Run build first.
Build before running package tests locally; `pnpm test` does not rebuild or pack.
Package and upload bytes are reports; cold-start checks remain gates.

Run the **Full checks** workflow (`.github/workflows/full-checks.yml`) by hand
(Actions → Full checks → Run workflow on the branch) before releases, or when a change to drivers, auth,
generator output or Admin UI may behave differently on Linux. It runs native
four-target and Wrangler/D1 integrations, packed-consumer checks, doc examples,
OSS plugin validation, the two Chrome sandbox-boundary tests (design preview
and MCP App host bridge), and size reports. Run the boundaries locally with
`pnpm --filter @aotter/mantle-admin test:browser` and Chrome installed. The
Admin sign-in/list/edit/publish/translation browser flow is covered by maintainer
manual acceptance; the packed worker-consumer smoke checks the service and Admin
API round trip. Shared Store, publishing and search scenarios run through
`test:native`; focused unit tests retain security and correctness invariants.
`pnpm check` remains the broad local/release check; the release workflow is
unchanged.

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
