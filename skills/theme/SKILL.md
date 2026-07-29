---
name: theme
description: Apply brand and visual direction in a generated Mantle project using its repo-owned theme and UI contracts.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/theme/SKILL.md
  applies_to: mantle@v0.1.0
---

# Mantle Theme

Theme work is project-owned source editing. Starters may ship Kiwa files,
tokens, or recipes, but the skill contract is Core-owned.

## First Read

1. `.mantle/handoff.md` and `.mantle/recipes/` if present.
2. `styles/`, `components/`, `src/web/`, `src/theme*`, and `kiwa-ui.json`
   if present.
3. `kiwa/manifest.json` for the pinned source and per-file `mirrors`.
4. `manifests/` to understand which content shape drives the public UI.

## Ownership

- `styles/globals.css` is the token contract. Start a whole-site reskin with
  its `:root` and `.dark` values; Kiwa components inherit those variables.
- `src/web/` is project-owned. Put new sections and page composition there.
- `kiwa/` is a vendored snapshot. In `components/`, treat paths whose manifest
  entry's `mirrors` contains `blank` as sync-managed in the project root. For
  a structural variant, fork or wrap the block under `src/web/sections/`
  instead of editing a synced file.

## Work

- Use existing tokens, CSS, components, and installed dependencies first.
- When the generated section type exposes `showImage`, set it to `false` for
  a text-only hero/content block. Put custom media in a project-owned section.
- Keep accessibility basics: semantic HTML, focus states, contrast, and
  keyboard reachability. Against a non-default background, check
  `--foreground-muted` and `--primary`, not only `--foreground`; keep normal
  text at 4.5:1 or better.
- Do not require registry access for a project that already vendors UI source.
- Add UI dependencies only when existing source cannot cover the requested
  change.

## Check

```bash
pnpm validate
pnpm typecheck
pnpm dev
```

If utility classes changed, rebuild `styles/generated.css` with the project's
`build:styles`, `check`, or `dev` script. Remove routes/imports for replaced
assets or styles, then visually verify light/dark contrast and responsive
behavior before calling the work done.
