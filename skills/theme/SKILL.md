---
name: mantle:theme
description: Apply brand and visual direction in a Mantle project without depending on starter-owned skill semantics.
source: "@aotter/mantle"
sourcePath: skills/theme/SKILL.md
when_to_invoke: |
  User wants visual, brand, layout, copy, or UI polish in an existing Mantle project.
applies_to: mantle@v0.1.0
---

# Mantle Theme

Theme work is project-owned source editing. Starters may ship Kiwa files,
tokens, or recipes, but the skill contract is Core-owned.

## First Read

1. `.mantle/handoff.md` and `.mantle/recipes/` if present.
2. `styles/`, `components/`, `src/web/`, `src/theme*`, and `kiwa-ui.json`
   if present.
3. `manifests/` to understand which content shape drives the public UI.

## Work

- Edit source the repo owns.
- Use existing tokens, CSS, components, and installed dependencies first.
- Keep accessibility basics: semantic HTML, focus states, contrast, and
  keyboard reachability.
- Do not require registry access for a project that already vendors UI source.
- Add UI dependencies only when existing source cannot cover the requested
  change.

## Check

```bash
pnpm validate
pnpm typecheck
pnpm dev
```

Visually verify UI changes before calling them done.
