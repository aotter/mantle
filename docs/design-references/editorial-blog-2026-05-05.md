# Editorial Blog Design Reference (2026-05-05)

This document preserves the visual system from the retired
`blog-editorial-2026-05-05` starter. The runnable starter was removed because
it looked like a maintained template, but the design work is still useful as a
reference for future themes.

Use this as a design specimen, not as implementation guidance. Apply it through
the version-matched `mantle:theme` workflow and the generated project's owned
theme paths, such as `styles/globals.css`, `components/`, and `src/web/`.

## Design Thesis

The direction was a quiet literary journal: warm paper, dark ink, a narrow
reading measure, editorial serif typography, and one vermilion accent. The UI
avoided dashboard styling and treated the site chrome as magazine furniture:
small caps, rules, careful spacing, and minimal controls.

The design was intentionally opinionated. That is why it should be reused as a
theme preset or design prompt, not shipped as the default blog starter.

## Visual Tokens

| Token | Light | Dark | Role |
|---|---:|---:|---|
| `paper` | `#f6f1e7` | `#1a1814` | Page background |
| `ink` | `#1a1814` | `#f1ebdf` | Primary text |
| `rule` | `#d4c8b3` | `#3d342a` | Hairlines, subtle borders |
| `rule-strong` | `#3d342a` | `#5a4d40` | Form underlines, stronger separators |
| `mute` | `#7a6d5e` | `#9a8d7e` | Metadata and secondary copy |
| `accent` | `#a3331f` | `#e6594a` | Links, drop caps, error states, preview banner |
| `accent-soft` | `#c9614a` | `#c9614a` | Secondary accent |
| `selection` | `#f0d6a3` | `#4a3520` | Text selection background |

Layout tokens:

| Token | Value | Role |
|---|---:|---|
| `measure` | `38rem` | Main article measure |
| `main max-width` | `48rem` | Single-column shell, slightly wider than the article |
| `gutter` | `clamp(1.25rem, 4vw, 3rem)` | Responsive page padding |
| `base font size` | `18px` | Reading-first default |
| `line height` | `1.65` | Long-form prose rhythm |

## Typography

The type system used four families:

| Use | Font stack |
|---|---|
| Display | `Fraunces`, `Noto Serif TC`, `Source Serif 4`, `Georgia`, `serif` |
| Body | `Source Serif 4`, `Noto Serif TC`, `Georgia`, `serif` |
| Mono/meta | `JetBrains Mono`, `ui-monospace`, `SF Mono`, `Menlo`, `monospace` |
| CJK fallback | `Noto Serif TC` |

Important behaviors:

- Body text enables `kern`, `liga`, and `onum`.
- Headings use Fraunces variable optical sizing with `opsz` and `SOFT`.
- `h1` scales from `2.2rem` to `3.4rem`; hero `h1` scales up to `4rem`.
- Metadata uses JetBrains Mono at `0.75rem`, uppercase, and `0.04em` tracking.
- Paragraphs indent after the first paragraph with `p + p { text-indent: 1.5em; }`.
- Post bodies reset the first paragraph indent and add a vermilion drop cap.

## Page Chrome

Header:

- Sticky top header with a one-pixel rule.
- Warm translucent paper background using `color-mix`, `saturate(140%)`, and
  `blur(10px)`.
- Wordmark uses display serif and inserts a vermilion middle dot between the
  first word and the remaining brand words.
- Navigation is centered, uppercase, display serif, and tracked at `0.18em`.
- Current nav item is shown by a one-pixel underline in `ink`; hover uses
  `accent`.

Controls:

- Language and theme are small popovers in the header.
- Popover trigger typography follows mono/meta styling.
- The language trigger shows a globe icon, full locale label, and chevron.
- The theme trigger is icon-only and supports system, light, and dark.
- Menu items use `menuitemradio` semantics and show a check icon for the active
  value.
- Popovers close on outside click and `Escape`.

Footer:

- One-pixel top rule.
- Mono text at `0.75rem`.
- Left side shows `site.brand` and `site.description`.
- Right side links to `mantle`.

## Templates

Home:

- Starts with a `hero` block: mono eyebrow, large display title, muted intro,
  and markdown body.
- Recent posts appear below the hero as an `entry-list`.

Post:

- Uses a narrow `article` measure.
- Header contains optional publish date and title.
- Optional cover image is bordered by `rule`.
- Body markdown supports headings, blockquotes, inline code, code blocks, and
  lists.
- First body paragraph gets an editorial drop cap.

Post list:

- Reuses the hero grammar with an index eyebrow.
- Entries render as a two-column grid: fixed `7rem` date rail plus flexible
  title/excerpt column.
- On narrow screens, entries collapse to one column.

Page:

- Same article shell as posts.
- Uses page `intro` as muted mono metadata under the title.
- `about` and `contact` slugs drive active nav hints.

Contact:

- Article intro and body are followed by a vertical form.
- Field labels are uppercase mono.
- Text inputs use underline-only styling; textarea uses a bordered box.
- Submit button uses display serif, uppercase tracking, and an inverted
  `ink`/`paper` fill.
- Cloudflare Turnstile is mounted explicitly so it can re-render when the site
  theme changes.

404:

- Centered block with a huge display-serif `404` glyph in `accent`.
- Copy follows the same i18n bundle pattern as the rest of the chrome.

## Interaction Model

Theme preference is a three-way choice:

- `system`: no stored value, follows `prefers-color-scheme`.
- `light`: explicit localStorage override.
- `dark`: explicit localStorage override.

A bootstrap script runs in `<head>` before paint to avoid theme flash. Runtime
theme changes dispatch a `mantle:theme` event. The contact page listens to that
event and re-renders Turnstile with the resolved light/dark value.

Language switching rewrites the leading locale segment in the current path. It
does not translate content itself; it navigates to the equivalent route under
the selected locale.

## I18n Surface

The archived design included two UI bundles:

| Locale | Label |
|---|---|
| `en` | `English` |
| `zh-TW` | `繁體中文` |

The bundles covered:

- Header labels: posts, about, contact.
- Theme labels: auto, light, dark.
- Language aria label.
- Home and post-list eyebrows.
- 404 title, body, and return link.
- Contact labels, submit states, success message, and error prefix.

Content translations were intentionally separate from UI chrome translations.
Posts and pages came from CMS entries; nav and form labels came from the local
i18n bundles.

## Icons

The icon system was deliberately tiny:

- Inline SVG strings injected by templates.
- Monochrome `currentColor` stroke.
- Default size `16`.
- Default stroke width `2`, with check icons at `2.5`.
- No runtime icon dependency until the set grows beyond roughly 20 icons.

The archived set included `sun`, `moon`, `monitor`, `globe`,
`chevron-down`, `check`, `menu`, and `x`.

## Reuse With The Current Theme Stack

Map the design into the maintained starter layers instead of reviving the old
runnable starter:

| Current layer | What to reuse |
|---|---|
| L1 tokens | Colors, font stacks, measure, gutter, base rhythm |
| L2 components | Popover styling, entry list, post body, drop cap, contact form |
| L3 slots | Header, footer, language switcher, theme switcher |
| L4 templates | Home, post, post list, page, contact, 404 composition |

Do not copy the old package metadata, Wrangler config, fixtures, workspace
dependencies, or smoke tests. Those belonged to the removed runnable starter and
will drift from the maintained SDK packages.

## If Reviving This Direction

Revive it as one of these:

- A documented visual preset selectable during agent seeding.
- A project-owned theme preset applied through `mantle:theme`.
- A generated design prompt that tells the provisioning agent how to style a
  user's own brand.

Do not bring it back as a runnable starter in this SDK repository. Agents treat
runnable code as current product surface, so the preserved design belongs only
in this reference.
