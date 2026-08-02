---
name: theme
description: Change a Mantle site's visible design in the smallest project-owned UI surface that actually ships.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/theme/SKILL.md
  applies_to: mantle@v0.1.0
---

# Mantle Theme

Theme work is project-owned UI work. Do not assume a component framework,
vendored design system, or generated theme tree exists.

## First Read

1. `.mantle/handoff.md` and the manifest that defines visible content.
2. `public/index.html` when present; this is the editable page in minimal
   provisioned sites.
3. Only then inspect real project-owned `src/web`, `src/theme`, `components`,
   or styles directories that the Worker imports.

Never edit `.mantle/generated/` or a provision bundle. Do not recreate Kiwa,
Tailwind, React, or a component tree merely to change copy, spacing, colors, or
layout in a static page.

The minimal surface is a default, not a restriction. `public/index.html` is
already project-owned/ejected source. When a deeper structural override is
chosen, follow the shadcn model: copy only the selected overlay recipe or
component into a project-owned path, keep its provenance/license, and edit it
freely. Do not vendor an entire theme catalog for one block.

The checked zero-dependency page recipe and historical Kiwa recovery map live
in `node_modules/@aotter/mantle/docs/site-overrides.md`. The last full Kiwa
catalog is starter `v0.0.11-alpha.63`; its TSX requires its explicit JSX,
utility, and CSS dependencies and is not a drop-in minimal-starter default.

## Work

- Reuse the existing HTML, CSS variables, components, and dependencies first.
- Keep semantic HTML, visible focus, keyboard reachability, responsive layout,
  and at least 4.5:1 contrast for normal text.
- Keep form names and fixed option values aligned with the manifest Procedure.
- Add image `alt` text and avoid loading decorative media that does not help
  the page.
- Add a UI dependency only when the requested interaction or reuse cannot be
  expressed cleanly in the current surface.
- It is valid to replace the static page with a custom renderer or app when the
  developer chooses that tradeoff; connect it through the existing Worker
  façade/extension or public low-level SDK instead of forking Core internals.

## Check

```bash
pnpm validate
pnpm typecheck
pnpm dev
```

Visually verify narrow/wide layouts, keyboard interaction, and light/dark
contrast where supported. Run the full `pnpm check` before shipping.
