# Contributing to Mantle

This file and accepted ADRs are the tool-neutral authority for human and agent
contributors. Historical issue plans explain migrations; the checked-out
source, tests, package READMEs, and accepted ADRs define the current contract.

## Product and architecture contract

Mantle Core is an embeddable manifest engine. A consumer may use only the parser
and linker, bind Runtime to application-owned storage, add generated TypeScript
bindings, or compose optional Web, Admin, UI, and platform adapters. For new
applications, `mantle generate` assembles a full blank site by default or a
smaller positively selected composition (ADR-0026). Application source remains
user-owned; a minimal reference consumer validates the package contract.

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
| `@aotter/mantle-admin` | Optional thin native Admin API, SPA, extension client API, developer workspace, design preview and MCP App; SDK peer and shared UI dependency. |

`skills/*` are versioned consumer product artifacts. Maintainer instructions
live at the repository root and in `.agents/skills`; do not merge the two
audiences or copy maintainer policy into shipped skills.

## Hard invariants

- `src/build/spec` keeps the closed v2 grammar (`cms.mantle.aotter.net/v2`), diagnostics
  and SQL allowlist. Grammar changes require an accepted ADR amendment.
- Compiler code stays build-time only. `src/kernel` and `src/auth` do not import
  `build`, `domain`, `usecase`, `infrastructure`, Admin, or another SDK.
- Generated operations call only the selected native driver and dialect. Bare
  query output preserves native driver values; selected HTTP/MCP/Admin boundaries
  own declared-column transport conversion. Complete int64 parity is deferred.
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

Requirements: Node.js 22 or newer and pnpm 9 or newer.

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

PR CI runs install, build, typecheck, unit tests, boundaries, startup graphs and
per-surface startup budgets, plus the cheap skill and plugin-manifest checks.
Build before running package tests locally; `pnpm test` does not rebuild or pack.
Package and upload bytes are reports; cold-start checks remain gates.

Run the **Full checks** workflow (`.github/workflows/full-checks.yml`) before
releases and after changes to drivers, auth, generator output or Admin UI: add
the `full-checks` label to the PR (later pushes rerun it). It runs native
four-target and Wrangler/D1 integrations, packed-consumer checks, doc examples,
Cloud plugin validation, Chrome Admin smoke tests and size reports. For local
browser smoke set `MANTLE_NEXT_ROOT` to `$PWD/packages/mantle` and run
`pnpm --filter @aotter/mantle-admin test:browser` with Chrome installed. `pnpm check` remains the
broad local/release check; the release workflow is unchanged.

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
