# Contributing to Mantle

This file and accepted ADRs are the tool-neutral authority for human and agent
contributors. Historical issue plans explain migrations; the checked-out
source, tests, package READMEs, and accepted ADRs define the current contract.

## Product and architecture contract

Mantle Core is an embeddable manifest engine, not a site framework. A consumer
may use only the parser and linker, bind Runtime to application-owned storage,
add generated TypeScript bindings, or compose optional Web, Admin, UI, and
platform adapters. The official Starter is an example and project bootstrap;
it does not own Core's application shape.

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
| `@aotter/mantle-spec` | Pure manifest grammar, parse, link, diagnostics, and authoring CLI. |
| `@aotter/mantle-runtime` | Adapter-neutral plan compilation, semantic storage ports, preparation, and runtime invocation. |
| `@aotter/mantle` | Core umbrella, code generation, and authoring CLI; optional packages are peers. |
| `@aotter/mantle-web` | Optional HTML, Markdown, `llms.txt`, sitemap, SEO, and preview composition. |
| `@aotter/mantle-admin` | Optional Admin API, auth, and static-asset composition. |
| `@aotter/mantle-admin-ui` | Optional pre-built Admin SPA. |
| `@aotter/mantle-bun` | Bun adapter over caller-owned `bun:sqlite`. |
| `@aotter/mantle-vercel` | Vercel Functions adapter over injected durable storage; optional libSQL subpath. |
| `@aotter/mantle-cloudflare` | Cloudflare Workers adapter over D1 and selected platform services. |

`skills/*` are versioned consumer product artifacts. Maintainer instructions
live at the repository root and in `.agent/skills`; do not merge the two
audiences or copy maintainer policy into shipped skills.

## Hard invariants

- `@aotter/mantle-spec` stays environment- and adapter-free and retains
  `sideEffects: false`.
- `@aotter/mantle-runtime` must not import Cloudflare, Bun, Vercel, SQL-client,
  or other platform-specific types. Concrete adapters bind Core ports.
- Storage is semantic at the Core boundary. SQLite/D1 is an official adapter,
  not the Runtime contract; Postgres, MongoDB, or application-owned tables may
  implement the same semantic ports directly.
- Web, Admin, Admin UI, and every platform adapter remain optional. Core must
  not require routes, HTML, static assets, auth, or an Admin surface.
- Runtime input is a sealed `RuntimePlan`, never raw manifests. Deployment
  preparation owns migrations, indexes, native query lowering, and readiness.
- Manifest grammar is locked for v0.1. New keys and closed-enum members require
  grammar-revise work before implementation. Atom names remain Schema, View,
  Procedure, and Trigger.
- Trust-boundary input fails with structured diagnostics or stable transport
  errors. Never simplify away validation, authorization, data-loss protection,
  or accessibility basics.
- Auth is a selected product/platform contract, not a Runtime port. Better Auth
  is the Cloudflare default implementation, not an option pass-through API;
  see [ADR-0014](docs/adr/0014-auth-better-auth-and-multi-tenant-mcp.md).

### Clean architecture

`mantle-spec` and `mantle-runtime` follow:

```text
kernel <- domain (model + port + service) <- usecase <- infrastructure
```

- `kernel/` imports only external libraries and other kernel files.
- `domain/` does not import `usecase/`, `infrastructure/`, or assembly code.
- `usecase/` does not import `infrastructure/`.
- Port interfaces live in `domain/port/`; concrete implementations live in
  infrastructure or downstream adapters.
- Use cases accept request DTOs and explicit dependencies. Infrastructure is
  thin envelope handling and delegation.
- `MantleRuntime.ts` assembles prepared ports and use cases. It must not regain
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

`pnpm check` runs package-boundary and release self-checks, builds exact packed
consumer fixtures, typechecks, and tests the workspace. Use package filters
while iterating. Changes to Cloudflare request/storage performance must also run
`pnpm bench:wrangler`.

## Branches, commits, and pull requests

- `develop` is the integration branch. `main` moves only through deliberate
  release promotion.
- Branch from `origin/develop` with `feat/issue-N-topic`,
  `fix/issue-N-topic`, `docs/issue-N-topic`, or `chore/issue-N-topic`.
- Use conventional commit subjects. Keep each commit and PR coherent and
  reviewable.
- Open PRs against `develop` and merge with a merge commit, not squash.
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
and the canonical [maintainer release skill](.agent/skills/mantle-release/SKILL.md).
No task implies permission to publish.

Do not file public vulnerability issues. Follow [`SECURITY.md`](SECURITY.md).
