---
name: customize-design
description: Layer custom design over a mantle publication starter project using the L1–L4 theme stack (tokens / extraCss+icons+i18n / Header+Footer+PageShell slots / whole-template fork). Use when the user wants to rebrand, restyle, or swap UI pieces without forking the whole starter.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/customize-design/SKILL.md
  applies_to: mantle@v0.1.0 + publication archetype
---

# Customize the design of a mantle publication site

You are layering a consumer theme over a project built from the `publication` starter. The baseline lives at `src/theme.default/` (read-only by convention). Consumer overrides live at `src/theme/`. Always escalate from L1 → L4 and stop at the lowest layer that solves the user's stated need.

## Layer cheatsheet

| Layer | Where | Use for |
|---|---|---|
| **L1** tokens | `src/theme/tokens.ts` | palette, font stack, type scale, measure, gutter |
| **L2** extraCss | `src/theme/index.ts:extraCss` | extra CSS rules (border-radius, hero size, etc.) |
| **L2** icons | `src/theme/icons.ts` | replace baseline icons by name; add new ones |
| **L2** i18n | `src/theme/i18n/<locale>.json` | retitle UI strings per locale (deep-merge) |
| **L3** components — chrome | `src/theme/components/{Header,Footer}.tsx` | swap navigation chrome |
| **L3** components — body layout | `src/theme/components/PageShell.tsx` | reshape body layout: sidebar variants, sticky CTAs, full-bleed hero, alternative Header / `<main>` / Footer arrangement |
| **L4** templates | `src/theme/templates/<name>.tsx` | replace a page kind end-to-end |

## Conversation pattern

1. **Map the user's intent to a layer.** "Change the colors" → L1. "Different header structure" → L3. Tell the user the layer + the escape hatch ("I'll start at L1; if it doesn't get close enough, we can escalate to a custom Header at L3").
2. **Fork → edit → review.** Run `pnpm theme:fork <path>`, edit the new file in `src/theme/`, ask the user to reload `pnpm dev`.
3. **On dissatisfaction, iterate or revert.** `pnpm theme:reset <path>` removes the override and restores the baseline. The user can roll back any single layer without affecting others.

## Layer recipes

### L1 — tokens

```bash
pnpm theme:fork tokens.ts
```

Edit `src/theme/tokens.ts`:

```ts
export const TOKENS_CSS = `
:root {
  --paper: #fffbf3;
  --ink: #1a1814;
  --accent: #a3331f;
  --font-display: "Fraunces", Georgia, serif;
  --font-body: "Source Serif 4", Georgia, serif;
  --measure: 36rem;
}
[data-theme="dark"] {
  --paper: #1a1814;
  --ink: #f1ebdf;
  --accent: #e6594a;
}
`;
```

The override is concatenated AFTER baseline tokens, so later declarations win on standard CSS specificity. Only redeclare the vars you want to change.

**Custom web fonts**: if `--font-display` references a font not in the system stack, register it with L2 `extraCss` using `@font-face`. Don't use CSS `@import`: `extraCss` is appended after baseline rules, and browsers ignore late `@import` statements.

```ts
const overrides: ThemeOverride = {
  extraCss: `
    @font-face {
      font-family: "FrauncesLocal";
      src: url("/fonts/fraunces.woff2") format("woff2");
      font-weight: 400 700;
      font-display: swap;
    }
  `,
  tokens: `:root { --font-display: "FrauncesLocal", Georgia, serif; }`,
};
```

Revert: `pnpm theme:reset tokens.ts`.

### L2 — extraCss

Edit `src/theme/index.ts` — set the `extraCss` field directly (no fork needed, it's just a string):

```ts
const overrides: ThemeOverride = {
  extraCss: `
    .site-main { max-width: 64rem; }
    .post-cover { border-radius: 8px; }
    blockquote { background: var(--rule); padding: 1rem; }
  `,
};
```

Revert: clear the field.

### L2 — icons

```bash
pnpm theme:fork icons.ts
```

Edit `src/theme/icons.ts`:

```ts
const customIcons: Record<string, string> = {
  // override an existing baseline icon
  globe: '<circle cx="12" cy="12" r="9"/><path d="..."/>',
  // add a new icon
  logo: '<path d="M12 2L2 7v10l10 5 10-5V7l-10-5z"/>',
};
export default customIcons;
```

Use in any template via `icon("logo", { size: 24 })`. SVG path content only — no `<svg>` wrapper. The fork ships a stub (not a copy of the baseline), since you're extending a registry.

Revert: `pnpm theme:reset icons.ts`.

### L2 — i18n

```bash
pnpm theme:fork i18n/en.json
```

Edit `src/theme/i18n/en.json` — partial bundle, deep-merged over baseline:

```json
{
  "header": { "posts": "Articles" },
  "home": { "eyebrow": "the dispatch" },
  "notFound": { "title": "Lost at sea" }
}
```

Other keys carry forward from baseline. To support a new locale (`ja`, `de`, etc.), edit `src/i18n/<locale>.json` directly — locale set is consumer-level, not a theme slot.

Revert: `pnpm theme:reset i18n/en.json`.

### L3 — Header / Footer

```bash
pnpm theme:fork components/Header.tsx
pnpm theme:fork components/Footer.tsx
```

Use this when the user wants different chrome — different brand mark, nav arrangement, language switcher, footer copy — but the page body still reads top → main → bottom. Key contracts:

- Don't change the props signature: `Header(props: HeaderProps)`.
- `props.site.brand`, `props.site.locales`, `props.locale`, `props.current` are available.
- Baseline siblings (icon registry, etc.) auto-rewritten on fork to `../../theme.default/<path>`. Keep those unless you want to drop the baseline icon set.

Same shape for `Footer`.

Revert: `pnpm theme:reset components/Header.tsx`.

### L3 — PageShell (body layout)

```bash
pnpm theme:fork components/PageShell.tsx
```

Use this to reshape the **body layout** rather than swap chrome — for example:

- Sidebar with table-of-contents alongside `<main>` for docs-lite pages
- Sticky CTA bar between `<main>` and `<Footer>`
- Full-bleed hero section above Header on the home page
- Different Header / `<main>` / Footer ordering (e.g., side-rail logo)
- Custom `<main>` container width or padding rules per template kind

The forked PageShell takes ownership of how (or whether) to render the Header / Footer overrides. The baseline composes them top → main → bottom; a consumer-supplied PageShell can ignore or recompose them.

Revert: `pnpm theme:reset components/PageShell.tsx`.

### Layout is not forkable

Only `Header`, `Footer`, and `PageShell` are supported component slots. `theme:fork components/Layout.tsx` exits with a clear error pointing at PageShell as the body-layout escape hatch. Don't try to override Layout by hand-editing `src/theme/components/Layout.tsx` outside the fork machinery — the override surface won't register it.

`Layout` (the document envelope — `<html>` / `<head>` / `<body>` + SEO meta + theme bootstrap) is locked. If the user needs to change `<head>` content beyond what tokens / extraCss can express, that crosses the starter-family line — switch starter rather than fork every template.

### L4 — whole template (escape hatch)

```bash
pnpm theme:fork templates/post.tsx
```

Edit `src/theme/templates/post.tsx`. The forked file imports baseline Layout via `../../theme.default/components/Layout.js`.

L4 is the last resort. If the user wants more than two L4 forks, suggest the conversation: "The shape you're describing isn't really `publication` any more — it sounds closer to `community` (member posts), `micro-shop` (catalog + orders), or `leads-inbox` (lead pipeline). Once you cross those lines, switching starter family is cheaper than forking more templates."

Revert: `pnpm theme:reset templates/post.tsx`.

## Hard rules

- Don't edit `src/theme.default/`. Use fork.
- Don't add new top-level keys to `ThemeOverride` — extend through the existing slots.
- `Layout` is locked — change envelope shape via L4 forks (every template) or pick another starter.
- After a fork, the file is a normal `.ts` / `.tsx` / `.json` — TS errors surface on `pnpm typecheck` as usual.

## Diagnostic recipes

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm theme:fork X` exits with "Override already exists" | Already forked | `pnpm theme:reset X` first |
| `pnpm typecheck` fails in `src/theme/components/<Name>.tsx` after fork | A baseline import didn't auto-rewrite | Manually change `from "../<sibling>"` to `from "../../theme.default/<sibling>"` |
| Color change not visible after edit | Browser CSS cache | Hard reload (Cmd+Shift+R / Ctrl+F5); if it persists, restart `pnpm dev` |
| Forked `en.json` discards keys I didn't redeclare | Bundle isn't deep-merging | Verify `src/i18n/index.ts:deepMerge` is present. If missing, update to latest starter |

## When you're done

Tell the user three things:

1. **Layer landed at** — "I made the change at L1 (tokens) — palette only, no structural edits."
2. **Revert command** — "If you don't like it, `pnpm theme:reset tokens.ts` rolls it back."
3. **Next escalation step** — "If the colors aren't enough, the next layer would be L3 — replace the Header component."

Stop after one layer per turn unless the user explicitly says "go deeper". The point of layering is to keep each customization step reversible and inspectable.
