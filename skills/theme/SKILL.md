---
name: theme
description: Apply brand and visual direction in a generated Mantle project using its repo-owned theme and UI contracts.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/theme/SKILL.md
  applies_to: mantle grammar v0.1
---

# Mantle Theme

Theme work is project-owned source editing. Starters may ship UI files,
tokens, or recipes, but the skill contract is Core-owned.

## First Read

1. `.mantle/handoff.md` and `.mantle/recipes/` if present.
2. `styles/`, `components/`, `src/web/`, `src/theme*`, and UI-library config
   if present.
3. A vendored UI palette's manifest and license, if present.
4. `manifests/site.yaml` to understand which content shape drives the public UI.

## Ownership

- `styles/globals.css` is the token contract. Start a whole-site reskin with
  its `:root` and `.dark` values; runtime components inherit those variables.
- `components/` is the runtime-facing component surface when present.
  `src/web/` is project-owned composition; put new sections there.
- `public/site-icon.svg` and `public/site-icon.png` are one site identity.
  Keep both listed in `src/mantle/config.ts > siteDefaults.icons`: PNG first as
  the 64x64 compatibility rendition, then SVG as the editable `any` size source.
  The same list drives browser favicons, Admin chrome, and MCP
  `serverInfo.icons`; do not edit generated files under `public/_mantle/`.
- If the project includes a vendored UI reference palette, treat it as
  offline source material and provenance, not runtime source. Copy only a
  needed primitive or block into the project's runtime directories, or
  fork/wrap it under `src/web/sections/`; do not import the palette from
  Worker or runtime code.

## Work

- Use existing tokens, CSS, components, and installed dependencies first.
- When replacing the site mark, regenerate PNG from the same SVG artwork so
  every surface presents the same identity. Check it at the Admin's 28px slot
  in both light and dark themes; a single high-contrast rendition is preferred
  over theme-specific variants unless the artwork genuinely needs both.
- For a standard hero image, set the section's `image: { src, alt }`; use
  `showImage: false` for text-only hero/content blocks. Put non-image media in
  a project-owned section.
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
