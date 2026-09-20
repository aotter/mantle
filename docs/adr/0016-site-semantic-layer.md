# ADR-0016: Site semantic layer — `AGENTS.md` + launch state

## Status

Accepted (slimmed 2026-05-12 per Epic #116; `mantle/site.md` letter
surface suspended 2026-06-19 and removed from first-run scaffolds;
amended 2026-06-27 for landing provision bundles).

## Decision

Every agent-authored mantle project carries a small cross-tool entry file
and deterministic launch state at fixed paths:

| File | Audience | Size budget | Format |
|---|---|---|---|
| `AGENTS.md` | Any cross-tool agent harness (Codex / Cursor / Aider / Amp / Factory / Claude Code) | ~30 lines | Plain markdown |
| `.mantle/launch-state.json` | Install/provision context captured by landing or direct CLI flags | Small JSON record | JSON |

`AGENTS.md` answers "what is this and how do I run it." Launch state
carries install-critical facts such as archetype, brand, description,
locales, selected features, GitHub owner/admin login, starter ref, and
repo target.

The earlier `mantle/site.md` semantic/letter surface and `## welcome`
5-card letter surface are suspended for the first-run path. Provisioning
must not block on prose completion; a first deploy should be possible
from deterministic scaffold state.

## Placeholder macros

Mantle landing substitutes these across provision-bundle `*.template`
files in a single pass:

| Macro | Source | Example |
|---|---|---|
| `{{ARCHETYPE}}` | CLI flag | `presence` |
| `{{BRAND}}` | CLI flag | `Lab Cafe` |
| `{{DESCRIPTION}}` | CLI flag | `Coffee + research notes from Taipei.` |
| `{{LOCALES}}` | CLI flag (JSON array) | `["zh-TW","en"]` |
| `{{CANONICAL_LOCALE}}` | first locale | `zh-TW` |
| `{{SITE_URL}}` | placeholder until provision | `https://example.com` |
| `{{GITHUB_OWNER}}` | CLI flag | `phsu` |
| `{{INSTALL_TIMESTAMP}}` | ISO 8601 of install run | `2026-05-12T14:03:00Z` |
| `{{INSTALL_SUMMARY}}` | CLI flag | `bootstrapped publication site for Lab Cafe in zh-TW/en` |

New macros must be added here, to `mantle-starters` bundle templates,
and to the landing substitution pass.

## Update rules

- **Mantle on return**: read `AGENTS.md`, `.mantle/launch-state.json`,
  and repo-local skills before changing code.
- **provision on deploy**: rewrite `AGENTS.md` `Public site:`
  placeholder → real Workers URL. Single commit at end of provision.
- **No hidden letter gate.** Prose may be added later, but first deploy
  only depends on deterministic scaffold state and provider configuration.

## Cross-tool compatibility

`AGENTS.md` lives at repo root because that is where the AGENTS.md ecosystem (`agents.md`) looks. `.mantle/` is for Mantle-owned non-secret state.

## Implementation

- Templates: `mantle-starters/blank/AGENTS.md.template` and
  generated `.mantle/*.template` bundle files.
- Substitution: Mantle landing provision-bundle substitution.
- Install handoff: `skills/install/SKILL.md` describes how agents continue from the landing-provisioned repo.
- Provision update: `skills/provision/SKILL.md` describes the `AGENTS.md` public-site rewrite after deploy.
- Type overlays are applied while building `provision-bundles/<type>.json`; generated repos should not need a second overlay step.
