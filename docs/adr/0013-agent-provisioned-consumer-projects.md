# ADR-0013: Agent-provisioned consumer projects

## Status

Superseded for first launch by provisioning v2 (2026-06-27). Historical
record only.

## Date

2026-05-09

## Context

> **Current direction:** Mantle landing creates the GitHub repo from
> `mantle-starters` `provision-bundles/<type>.json`, commits the blank
> or type bundle, and connects Cloudflare Workers CI when possible.
> Do not extend the old `create-mantle launch --session` or
> `provision:up` path.

mantle is not optimized for a human developer reading a long
installation guide and hand-editing boilerplate. The intended v0.1.0
entry path is:

1. The official site asks for a small set of launch choices: site name,
   project/repo slug, starter/theme, locale(s), visibility, and GitHub
   account context supplied through the Mantle GitHub App when present.
2. The site creates a short-lived launch session and produces a one-line
   `create-mantle launch --session ...` command for the user's agent.
   The older localized starting prompt plus pinned Skill URL remains a
   fallback when the session path is unavailable.
3. A coder agent runs in the user's chosen parent directory, claims the
   session, scaffolds immediately, initializes local launch state, installs
   npm packages, validates it, and then proceeds toward Cloudflare
   provision.
4. The deployed site gives the owner an admin sign-in path and an MCP
   URL for ongoing content operations.

This is a different architecture from "SDK docs plus templates." The
template must be safe for agents to mutate, the package dependency
story must work outside this monorepo, and first-run content cannot
depend on an operator MCP session that does not exist yet.

## Decision

Consumer projects are provisioned by an agent, using repo-hosted
Skills as the operational contract.

The source of truth for first-run scaffold intent is the website-created
launch session. It carries structured values such as `archetype`,
`theme`, `features`, `locales`, `project_name`, `site_name`,
`github_owner`, `admin_github_login`, and `repo` intent. The install
Skill should consume a valid launch session instead of running a long
generic interview before scaffold. Prompt-first install remains the
fallback when no valid launch session is available.

The launch session is not a general provider credential. It authorizes
the scaffold values the website just collected, and the agent writes
only non-secret resumable state such as `.mantle/launch-state.json`.
Cloudflare API tokens, GitHub OAuth App client secrets, paid-provider
features, and custom domains still require explicit user authorization
during provision.

Published npm packages are the runtime dependency source. Starter files
may still be copied from the GitHub repo or a release tag, but
`setup:site` rewrites `workspace:*` dependencies to the requested
`@aotter/mantle-*` npm version before `pnpm install`. This keeps
consumer projects independent from the monorepo and avoids private-repo
token friction in the install path.

Starter-owned setup scripts are the only supported way to rewrite
standard template fields. Agents should not hand-edit `wrangler.toml`,
`src/mantleConfig.ts`, `package.json`, or similar standard fields when a
starter script exists. Hand edits are reserved for actual product
customization.

Starter source is copied from pinned public GitHub refs by downloading
source tarballs, not by leaving a normal clone in place. The extracted
project initializes its own Git repo and should only set `origin` after
the user creates or selects a user-owned repository. This avoids agents
accidentally pushing back to the template source.

First-run content is not seeded during real-user install/provision.
Provision creates the operating surface first: public site, owner
sign-in, and Staff/User MCP URLs. After owner sign-in, the operating
agent interviews the owner and asks whether to create initial
pages/posts through Staff MCP or admin authoring. `seed:initial` and
fixture data are reserved for tests and contributor local dev.

Cloudflare provisioning is owned by the starter's provision script. It
creates the required free-path resources, writes bindings/secrets,
deploys once with the real origin, and returns the handoff URLs.
Agents should not decompose this into ad-hoc Wrangler steps unless
they are debugging a failed provision.

## Consequences

- Skills become part of the compatibility surface. Updating install or
  provision behavior requires updating the relevant Skill in the same
  change.
- Starter templates must remain script-configurable. Adding a new
  standard field without updating `setup:site` is a regression for
  agent provisioning.
- npm publishing must precede realistic end-user provisioning tests.
  `file:` or workspace dependencies are acceptable only for local SDK
  development.
- The first-run success criterion is product-level: public site,
  owner sign-in, MCP URL, and an owner-approved path to create initial
  content through MCP/admin authoring. A deployed but unauthored site
  can be a valid intermediate checkpoint, not a direct-seed failure.
- Provisioning must preserve the no-credit-card path. Optional paid or
  billing-gated features must be opt-in after the site is already live.

## Alternatives

- **Human-first docs with manual edits.** Rejected because it makes the
  non-coder path fragile and forces agents to infer boilerplate edits
  from prose.
- **Git dependency only.** Rejected for the default path because private
  repos and Git authentication add friction. Git refs remain useful for
  copying starter files, not for installed runtime dependencies.
- **Direct seed creates the initial content.** Rejected for real-user
  onboarding because it bypasses the same operating path we want to
  validate. MCP/admin authoring after owner sign-in is the product
  loop; fixtures and seed utilities remain for tests/local dev.
- **One universal starter.** Rejected. The current publication starter
  is intentionally fixed-manifest during bootstrap; custom workflows
  belong in `blank` or future dedicated starters.

## How to apply

- If a website launch session supplies structured install values, run
  `create-mantle launch --session ...` first and ask content/voice
  questions later.
- If only a website prompt supplies structured install values, consume
  them directly and only confirm public/resource-name-impacting details.
- Run the starter's `setup:site` script before installing
  dependencies.
- Download starter source as a pinned tarball/zip, extract it, run
  `git init`, and only add a remote that belongs to the user.
- Keep first-run provision scripts on the free Cloudflare path unless
  the user explicitly opts into a paid feature.
- After provisioning, hand the user to: view the site, sign in as
  owner, then connect an MCP-capable agent to create/operate content.

## Implementation status

- `skills/install/SKILL.md` and `skills/provision/SKILL.md` encode the
  current agent workflow, including the launch-session fast path.
- `aotter/mantle-starters` hosts `packages/create-mantle`, whose
  `launch --session` mode validates the session before writing files.
- Starters ship `provision:up` where supported; `seed:initial` remains
  a test/contributor utility, not part of real-user provisioning.
- Current prerelease package versions are documented in
  `docs/release-process.md`.
