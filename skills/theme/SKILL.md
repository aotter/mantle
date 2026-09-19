---
name: theme
description: Apply brand and visual direction in a Mantle application using its repo-owned theme and UI contracts.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/theme/SKILL.md
  applies_to: mantle grammar v0.1
  projection: project, plugin
---

# Mantle Theme

Theme work is project-owned source editing. Use the actual frontend and its
tokens; Core does not install a default home page or UI tree. If the
application has no public frontend, this skill does not apply — do not invent
a homepage to theme it.

## First Read

1. `styles/`, `components/`, `src/web/`, `src/theme*`, and UI-library config
   if present.
2. A vendored UI palette's manifest and license, if present.
3. `manifests/` to understand which content shape drives the public UI.
4. Leftover `.mantle/handoff.md` or `.mantle/recipes/` only if present; they
   are not required.

## Ownership

- Use the actual token contract (for example `styles/globals.css`) when present.
  Check its light/dark values before changing components.
- `components/` is the runtime-facing component surface when present.
  `src/web/` is project-owned composition; put new sections there.
- `public/site-icon.svg` and `public/site-icon.png` are one site identity.
  Keep both listed in the actual entry/config `siteDefaults.icons`: PNG first as
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
