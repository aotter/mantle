# Contributing to mantle

mantle is built for AI agents to be primary authors of consumer projects. Human maintainers still own review and release decisions, but the contributor workflow must be clear enough that a fresh AI agent can file a good issue or open a good PR by reading only this repo.

Start here before changing code or docs. For deeper engineering rules, read [`CLAUDE.md`](CLAUDE.md) and the ADR index in [`docs/adr/README.md`](docs/adr/README.md).

## Project shape

- `develop` is the integration branch.
- `main` is release-only and moves through `develop -> main` release merges.
- PRs target `develop`, not `main`.
- Merge completed PRs with `gh pr merge --merge --delete-branch`. Do not squash; the project preserves reviewable commits.
- Feature work should normally start from an issue unless it is a tiny docs or hygiene fix.

## Local setup

Requirements:

- Node.js >= 22
- pnpm >= 9

Install and check the repo:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

The full local gate is:

```bash
pnpm run check
```

Use the narrowest command that proves your change while developing. Run the full gate before a release-sensitive or broad PR.

## Branches

Cut branches from `develop`:

```bash
git fetch origin
git checkout -b feat/issue-81-short-topic origin/develop
```

Use these prefixes:

- `feat/issue-NN-topic` for user-visible features or new docs/process surfaces.
- `fix/issue-NN-topic` for bug fixes.
- `docs/issue-NN-topic` for documentation-only changes.
- `chore/issue-NN-topic` for tooling, metadata, dependency, or maintenance work.

If no issue exists, create one first unless the change is obviously trivial. For trivial no-issue work, omit the `issue-NN` segment and keep the branch descriptive, for example `docs/spec-readme-typo` or `chore/update-ci-comment`.

## Commits

Use conventional commits:

- `feat(scope): short summary`
- `fix(scope): short summary`
- `docs(scope): short summary`
- `chore(scope): short summary`
- `test(scope): short summary`
- `refactor(scope): short summary`

When an AI agent authored or substantially rewrote a commit, add a co-author trailer when the agent identity is known:

```text
Co-Authored-By: Claude <noreply@anthropic.com>
```

Keep commits reviewable. A PR may have multiple commits if each one is coherent and independently understandable.

## Issues

Use the GitHub issue templates:

- **Bug report**: broken or surprising behavior.
- **Feature request**: a concrete capability with user value.
- **Discussion**: convergence work where the right answer is not known yet.
- **Proposal**: ADR-lite decision record for process, architecture, or product shape.

Apply labels using [`docs/labels.md`](docs/labels.md). In particular:

- Use `needs-discussion` when a ticket is not ready for implementation.
- Use `needs-adr` when the change affects architecture, package boundaries, trust boundaries, or long-lived product decisions.
- Use `needs-grammar-revise` for manifest grammar or closed-enum changes.
- Use an `area:*` label for the affected package or surface.

## Pull requests

Open PRs against `develop`. A useful PR body includes:

- Summary of the change.
- Why the change is needed.
- Scope and non-goals.
- Test plan with commands actually run.
- Any standard checks that were not run, marked as not applicable with a short reason.
- Follow-ups that should not block this PR.
- Related issues, ADRs, and docs.

Use `.github/pull_request_template.md`. Link issues with `Closes #NN` only when the PR fully resolves the issue. Use `Refs #NN` when it is partial.

## Architecture and grammar gates

Read the relevant ADRs before touching architecture. The most common gates are:

- Runtime must stay adapter-agnostic. `@aotter/mantle-runtime` must not import Cloudflare-specific types.
- Manifest grammar is locked at v0.1. New grammar keys or closed-enum entries need grammar-revise work before implementation.
- New top-level `domain/`, `usecase/`, or `infrastructure/` folders need an ADR-lite paragraph in the PR body.
- Trust-boundary changes, auth changes, MCP surface changes, persistence boundaries, and public HTTP semantics need `needs-adr` unless an existing ADR clearly covers the decision.
- **Auth surface — no Better Auth pass-through.** Better Auth is the default `createAuth` implementation, not the SDK's contract; the `Auth` interface is the contract (see ADR-0014 § "Auth as contract, Better Auth as default", as amended 2026-05-15 by the OAuth carve-out). PRs that only rename a Better Auth option into `CreateAuthConfig` and forward it verbatim must be refused. **Picking a different literal default for an existing Better Auth field does not justify a new field by itself** — that's pass-through dressed up. When a Better Auth knob is genuinely missing from the SDK contract, the answer is a curated first-class field with a concrete justification: Workers-aware behavior Better Auth doesn't supply, a cross-adapter port the runtime needs, a safety net Better Auth doesn't provide, a new abstraction that fuses multiple Better Auth surfaces, or a DX helper that removes a Workers-hostile dep. The un-curated `CreateAuthConfig.betterAuthOptions` escape hatch (from PR #175) was retracted by PR #193's carve-out — the carved-out OAuth surface plus the curated `methods[]` / `rateLimit` / `bootstrapOwner` fields cover the adopter contract without needing a passthrough.

## Changelog

**Don't add `CHANGELOG.md` entries on every PR.** The PR title + body + commit messages are the source of truth for what changed in any given PR. Per-PR `[Unreleased]` entries bloat unboundedly between releases, force conflict-merging the section on every release cycle, and duplicate information that's already in git.

Changelog entries are written at release time as part of the release PR (see [`docs/release-process.md`](docs/release-process.md) § Release PR). The release author aggregates `git log` since the previous tag into Keep-a-Changelog buckets (`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`), prefixes package scope when relevant (`**`@aotter/mantle-runtime`**: ...`), and cross-links closing PR + issue. The entry lives under a new `## [vX.Y.Z] - YYYY-MM-DD` heading; no `[Unreleased]` placeholder.

## Release process

See [`docs/release-process.md`](docs/release-process.md). Until v0.1.0, the repo is alpha and the public API may still move. Release mechanics must still be documented in PRs that affect packages, tags, or publish behavior.

## Security

Do not file public issues for vulnerabilities. Follow [`SECURITY.md`](SECURITY.md).
