---
name: customize-design
description: Customize a Mantle site's project-owned UI with the smallest direct edit or selected-source eject that solves the request.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/customize-design/SKILL.md
  applies_to: mantle@v0.1.0
---

# Customize a Mantle Site

Do not assume a hidden theme framework. When a provisioned site has
`public/index.html`, it is already project-owned, ejected source: edit it
directly. A headless `blank` site intentionally has no page; add or eject one
only when the product needs UI. If the site imports a real UI directory, work
there instead.

## Escalate only as needed

1. **Direct edit:** change copy, CSS variables, spacing, layout, and native
   interactions in the existing page.
2. **Selected-source eject:** copy only the version-matched overlay recipe or
   component the design needs into a project-owned path, keep its provenance
   and license, then import/edit it freely.
3. **Custom UI stack:** replace the page or renderer when the product truly
   needs reusable components, client state, or a different delivery model.

This is the shadcn principle: Mantle provides a useful default, but the
developer owns copied source. Do not vendor the old full Kiwa tree to change
one block. Do not recreate `src/theme.default`, production overlay seed
machinery, a fork/reset framework, or a locked `Layout` contract unless the
application itself needs those concepts. Explicit project-owned local/test seed
fixtures remain valid.

When looking for a former Kiwa/overlay implementation, first inspect the
already materialized page. If more source is needed, use the starter ref in
`.mantle/launch-state.json` to locate the exact upstream overlay, copy only the
selected implementation, and record the source ref. Never copy from `develop`
into a versioned site by accident.

For a checked minimal page and the historical dependency/recovery map, read
`node_modules/@aotter/mantle/docs/site-overrides.md`. The last full Kiwa catalog
is starter `v0.0.11-alpha.63`; current minimal refs intentionally omit it.

## Keep contracts aligned

- Form names, required fields, numeric coercion, and option values must match
  the manifest Procedure input exactly.
- Keep semantic HTML, visible focus, keyboard access, responsive behavior,
  useful alternative text, and at least 4.5:1 contrast for normal text.
- Preserve Turnstile and other security/error/retry behavior while restyling.
- Add a dependency only when the requested interaction or reuse justifies it.
- Connect a custom renderer through the existing Worker façade/extension or
  the public low-level SDK; do not fork Core internals.
- Do not edit `.mantle/generated/` or provision-bundle JSON.

## Verify

```bash
pnpm validate
pnpm typecheck
pnpm check
pnpm dev
```

Visually verify narrow and wide layouts, keyboard interaction, loading/error
states, and light/dark contrast where supported. Report which level was used
and which new files became project-owned; there is no special reset command
beyond normal version control.
