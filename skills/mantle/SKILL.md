---
name: mantle
description: Create, continue, test or deploy a Mantle application using installed @aotter/mantle docs, including manifests, SQL Views and Procedures, MCP tools, app-built Admin, mantle generate and Mantle upgrades.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/mantle/SKILL.md
  applies_to: mantle 0.2
  projection: plugin
  projectionReason: The plugin's authoring entry skill is installed from the repository; workflow documentation comes from the installed SDK package.
---

# Mantle

The Mantle plugin's one skill. It installs no SDK and creates nothing by
itself. Once a project has `@aotter/mantle`, the installed package is the
authority: `node_modules/@aotter/mantle/README.md` and
`node_modules/@aotter/mantle/docs/`. Prefer them over this file, the SDK
checkout, or any online copy.

## Start with `mantle help`

Run `mantle help` first (in a project: `npx mantle help`; before one exists:
`npx @aotter/mantle@<exact version> help`). It prints the installed version's
entry page and every topic; `mantle help <topic>` prints one page with the next
and linked topics as commands. Follow it rather than browsing the SDK checkout
or an online copy.

## Find the project and its version

Work in the user's application, outside the SDK checkout. Read package.json, the lockfile, installed SDK README and node_modules/@aotter/mantle/docs/. Those files define the exact version's contract. Preserve existing identity, handles, routes and resources.
For existing older applications, use their installed docs until the user requests an upgrade; if an older version
lacks a guide named here, record the missing guidance and keep that version's contract.

## Choose the installed package skill

- Read `node_modules/@aotter/mantle/docs/skills/develop/SKILL.md` to change an existing project's manifests, SQL, handlers, service entry or surfaces.
- Read `node_modules/@aotter/mantle/docs/skills/integrate/SKILL.md` to add Mantle to an application with existing code, users or data.
- Read `node_modules/@aotter/mantle/docs/skills/update/SKILL.md` to upgrade Mantle, including from 0.1.x.
- Read `node_modules/@aotter/mantle/docs/skills/provision/SKILL.md` only for an authorized production deployment.
- Read `node_modules/@aotter/mantle/docs/skills/media-gc/SKILL.md` only to audit or remove stale uncommitted media uploads.
- Read `node_modules/@aotter/mantle/docs/skills/performance/SKILL.md` after acceptance converges, or when a page, first request or query is slow.

## New application

Node must be 22.22 or newer. Stable 0.2.0 is available as `@aotter/mantle@0.2.0`; pin selected Mantle packages to that exact version. Create it with `npx @aotter/mantle@<exact version> init <directory>`, then follow
`mantle help` ("Build from a product brief") and the app's `README.md`. Without the user listing them, a complete app
includes:

- Email OTP sign-in, the two roles `admin` and `user`, Admin for `admin`, MCP for both roles (`/mcp`, `/mcp/admin`)
  and REST: the shell already wires them; keep them.
- Real business rules in SQL Procedures (`mantle help sql-patterns`), not in handler code around separate writes.
- For visitor pages, everything in `mantle help public-pages` (SEO, AEO, sitemap, robots, `llms.txt`), styled.
- Local HTTP checks (`mantle help local-testing`), then independent acceptance with `pnpm accept`
  (`mantle help agent-workflow-acceptance`), then the installed `docs/skills/performance/SKILL.md`.

Take patterns from `mantle help examples` into the app's own manifests and `src/`; do not copy an example directory
over the app. Resolve each `AGENT:` or name the ones you left. Generation only, inside an app you already have: skip
`init` and use `mantle generate` (`mantle help project-and-cli`).

## Accept before reporting done

Before reporting any new app or feature as done, follow `mantle help agent-workflow-acceptance`: a private rubric,
then one fresh agent per role given only its role and the URLs `pnpm accept` prints, at most three rounds. The first
delivery covers every role and surface; after a repair, the guide's "Re-verify what a repair touches" rule decides what
re-runs: a page-only repair re-runs the affected UI, while auth, scope, SQL Procedure or shared-transport changes widen
to every surface they reach. State the round and revision of any evidence you reuse. If it was
not run, report the work as UNVERIFIED rather than done; if it could not run, BLOCKED. Report status per layer as that
guide's "Report done-ness in layers" defines; a block from your environment (approval policy, missing browser,
network) is BLOCKED on its layer, not a product failure, and does not discard the other layers.

Once acceptance is CONVERGED, read the installed `docs/skills/performance/SKILL.md`: it decides which of front end,
cold start and backend load apply, and runs them before you report done. This is the one exception to installed docs
winning: if the installed package predates that skill, read
[the 0.2.1 copy](https://github.com/aotter/mantle/blob/v0.2.1/docs/skills/performance/SKILL.md) and the pages it links
from the installed docs with `mantle help <topic>`.

## Deployment

Deploy only when the user requests it, following the installed `docs/skills/provision/SKILL.md` and the selected
host's native workflow. Local project creation alone is not deployment authorization.

## Existing project and handoff

Preserve the user's manifests, `src/` files, identity, package versions and provider resources. Run the project's
generate command with `--check` and its own tests before and after a change.

Report the project path, the exact Mantle version, what you changed, the four-layer status with each layer's checks
and results (the independent acceptance verdict, CONVERGED / BLOCKED / UNVERIFIED, is layer 3), the performance verdict
(PASS / PARTIAL / SKIPPED) with its before and after numbers, and anything left for the user, including what would
unblock a BLOCKED layer.
