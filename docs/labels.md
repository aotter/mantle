# GitHub labels

Labels keep issues and PRs sortable for humans and cold-start AI agents. Apply the smallest useful set: one kind label, one or more area labels, and any gate labels that change review requirements.

## Kind and status

| Label | Meaning | Who applies | Remove when |
|---|---|---|---|
| `bug` | Broken, surprising, unsafe, or regressed behavior. | Reporter or triager. | The issue is reclassified. |
| `enhancement` | New capability, behavior, or process improvement. | Reporter or triager. | The issue is reclassified. |
| `documentation` | Docs-only change or docs gap. | Reporter, triager, or PR author. | The issue is reclassified. |
| `question` | Needs an answer or convergence before action. | Reporter or triager. | The answer is captured or the issue is converted. |
| `good first issue` | Suitable for a new contributor with repo docs only. | Maintainer. | Scope grows or hidden context is required. |
| `help wanted` | Maintainers want external help. | Maintainer. | No longer seeking help. |
| `duplicate` | Same work exists elsewhere. | Triager. | Usually never; close with link. |
| `invalid` | Not actionable for this repo. | Triager. | Usually never; close with reason. |
| `wontfix` | Valid but intentionally not planned. | Maintainer. | Usually never; close with reason. |
| `epic` | Tracks a multi-issue initiative. | Maintainer. | The epic closes. |
| `spike` | Exploratory work, not guaranteed to land. | Triager or maintainer. | The work becomes a concrete proposal or implementation issue. |

## Area

Use at least one `area:*` label when the affected surface is known.

For package README or package-local docs changes, prefer the package area label (`area:spec`, `area:runtime`, `area:cf`, or `area:admin-ui`). Use `area:docs` for repo-wide docs, governance, ADRs, release docs, root README content, and cross-cutting documentation work.

| Label | Meaning |
|---|---|
| `area:runtime` | `packages/mantle-runtime` behavior, ports, use cases, dispatcher, and MCP runtime. |
| `area:spec` | `packages/mantle-spec`, manifest parsing, validation, diagnostics, CLI, spec types. |
| `area:cf` | `packages/adapters/cloudflare`, Workers adapter, D1/KV/ASSETS wiring, Cloudflare deploy behavior. |
| `area:starters` | External `aotter/mantle-starters` integration, release fanout, and the local moved-starter stub. |
| `area:skills` | `skills/*` agent briefs and install/extend/provision workflows. |
| `area:admin-ui` | `packages/mantle-admin-ui` React admin SPA. |
| `area:docs` | Repo-wide human docs, governance docs, ADR text, release docs, root README content, and cross-cutting documentation work. |
| `area:adapter` | Adapter boundary work spanning Cloudflare or future adapters. |
| `area:ci` | GitHub Actions, dependency automation, and repository checks. |

## Release and review gates

| Label | Meaning | Review consequence | Remove when |
|---|---|---|---|
| `release-gate` | Blocks a public release or release-quality claim. | Must be resolved or explicitly deferred before release. | The gate is closed or deferred by maintainer decision. |
| `v0.1.0` | Required for the v0.1.0 release gate. | Track in the v0.1.0 release pass. | The item lands or is moved out of v0.1.0. |
| `breaking-change` | Semver-relevant breaking change. | Generated release notes must call it out. | The change is redesigned to be non-breaking. |
| `skip-release-notes` | Release bookkeeping with no user-facing change. | Excluded from generated GitHub Release notes. | The PR contains a user-facing change. |
| `needs-adr` | Architecture, trust boundary, package boundary, or long-lived decision needs an ADR or ADR-lite proposal. | Do not merge implementation until the decision is captured. | ADR/proposal lands or maintainer confirms an existing ADR covers it. |
| `needs-grammar-revise` | Manifest grammar or closed-enum change. | Requires grammar-revise round before code/types/starters change. | Grammar decision lands or the change no longer affects grammar. |
| `needs-discussion` | Not converged enough for implementation. | Do not start coding from this issue. | Closing criteria are met and scope is concrete. |

## Creating missing labels

Use these commands from a checked-out repo:

```bash
gh label create "area:runtime" --description "Runtime package, ports, use cases, dispatcher, render, MCP runtime" --color "1d76db"
gh label create "area:spec" --description "Spec package, manifest parsing, validation, diagnostics, CLI, types" --color "1d76db"
gh label create "area:cf" --description "Cloudflare Workers adapter and bindings" --color "1d76db"
gh label create "area:starters" --description "Starter templates and starter validation" --color "1d76db"
gh label create "area:skills" --description "Agent Skills and install/extend/provision workflows" --color "1d76db"
gh label create "area:admin-ui" --description "React admin UI" --color "1d76db"
gh label create "area:docs" --description "Documentation and governance" --color "1d76db"
gh label create "area:adapter" --description "Adapter boundary and future adapter work" --color "1d76db"
gh label create "area:ci" --description "CI, dependency automation, and repository checks" --color "1d76db"
gh label create "breaking-change" --description "Semver-relevant breaking change" --color "b60205"
gh label create "skip-release-notes" --description "Release bookkeeping only; omit from generated GitHub notes" --color "ededed"
gh label create "needs-adr" --description "Requires an ADR or ADR-lite decision before merge" --color "d93f0b"
gh label create "needs-grammar-revise" --description "Requires manifest grammar review before implementation" --color "d93f0b"
gh label create "needs-discussion" --description "Not converged enough for implementation" --color "fbca04"
gh label create "spike" --description "Exploratory work, not guaranteed to land" --color "bfdadc"
```
