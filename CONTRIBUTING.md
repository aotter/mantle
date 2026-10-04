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

The sealed pipeline is:

```text
ManifestSourceSet -> parse -> ParsedManifestSet -> link -> LinkedManifestSet
  -> compile -> RuntimePlan -> prepare storage -> bind MantleRuntime
```

Each rule has one owner. Runtime and adapters consume the sealed output of the
previous stage rather than interpreting raw manifests again. Generated
bindings project typed lower-camel properties over the same plan; they are a DX
option, not a prerequisite for embedding Core. Public APIs must remain usable
and understandable by human engineers without a generated Starter.

The package topology is:

| Package | Responsibility |
|---|---|
| `@aotter/mantle` | One package, one folder of `src/` per subpath (ADR-0032 decision 13): Core (`.`), the grammar and compiler (`/spec`), the built-in dialects (D1/SQLite `/d1`, `/d1/compile`; PostgreSQL `/postgres`, `/postgres/compile`), the hosts (Cloudflare `/cloudflare`, Bun `/bun`), Auth, Admin, MCP and REST surfaces (`/auth`, `/admin`, `/mcp`, `/web`), the dialect compliance suite (`/testing`) and the `mantle` CLI. `check:boundaries` enforces what each folder may import. |
| `@aotter/mantle-ui` | The Admin console (`/admin`: built static files the preset binds) and optional shared UI (ADR-0029): the framework-free interaction controller (`/controller`), React interaction components (`/`), the UI kit (`/kit`, libraries as optional peers) and the MCP App (`/mcp-app`). Admin and MCP Apps both use it. |

`skills/*` are versioned consumer product artifacts. Maintainer instructions
live at the repository root and in `.agents/skills`; do not merge the two
audiences or copy maintainer policy into shipped skills.

## Hard invariants

- `src/spec` stays environment- and adapter-free (only its CLI front end,
  `spec/infrastructure`, reaches `d1/compile`); only the CLI runs on Node.
- `src/core` holds no engine or platform code: no Cloudflare or Bun
  primitive, no SQLite. It keeps the engine-neutral SQL allowlist and policy
  (ADR-0037); a dialect (ADR-0035) and a storage adapter bind Core's ports.
- Store is authored as SQL in PostgreSQL syntax (ADR-0035). PostgreSQL is the
  reference dialect and D1/SQLite runs its base subset (ADR-0037); both ship
  built in. Another engine implements `MantleDialect` and passes
  `@aotter/mantle/testing`'s compliance suite.
- Web, Admin, Admin UI, Auth, and every platform adapter remain optional. Core must
  not require routes, HTML, static assets, auth, or an Admin surface.
- Runtime input is a sealed `RuntimePlan`, never raw manifests. Deployment
  preparation owns migrations, indexes, native query lowering, and readiness.
- The manifest grammar is v2 (`cms.mantle.aotter.net/v2`). New keys and
  closed-enum members need an ADR amendment before implementation. Atom names remain Schema, View,
  Procedure, and Trigger.
- Trust-boundary input fails with structured diagnostics or stable transport
  errors. Never simplify away validation, authorization, data-loss protection,
  or accessibility basics.
- Auth is a selected product/platform contract, not a Runtime port. The
  portable surface lives in `@aotter/mantle/auth`; the preset owns host wiring
  (trusted IP headers, the auth database). Better Auth is the default implementation, not
  an option pass-through API; see
  [ADR-0014](docs/adr/0014-auth-better-auth-and-multi-tenant-mcp.md).

### Clean architecture

`src/spec` follows:

```text
kernel <- domain (model + service) <- usecase <- infrastructure
```

- `kernel/` imports only external libraries and other kernel files.
- `domain/` does not import `usecase/`, `infrastructure/`, or assembly code.
- `usecase/` does not import `infrastructure/`.
- Spec declares no ports. Core's ports (`MantleDialect`, the storage and
  driver interfaces) live in `src/core`; dialect and host folders implement
  them.
- Use cases accept request DTOs and explicit dependencies. Infrastructure is
  thin envelope handling and delegation.
- `src/core/runtime/createRuntime.ts` assembles the runtime. It must not regain
  database, Web, Admin, or platform ownership.
- A new top-level folder under `domain/`, `usecase/`, or `infrastructure/`
  needs an ADR-lite rationale in the PR description.

Spec owns authored and validated data types. Runtime owns execution facts and
rows supplied by dispatchers. If a Spec function accepts, returns, or validates
a type, that type belongs to Spec.

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
(`pnpm --filter @aotter/mantle test:bun`, Bun 1.3.14). CI runs both.

## Branches, commits, and pull requests

- `develop` is the integration branch. `main` moves only through deliberate
  release promotion. Until the 0.2 line merges into `develop`, its work
  branches from and targets `0.2.x` (see the release process).
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
