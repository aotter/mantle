# Recipes

A multilingual recipe site. Admins write recipes in Admin as drafts and publish them; visitors read the published
recipes in Traditional Chinese (`zh-TW`, the default) and English (`en`) without signing in. It is the reference for
the recommended shape of a public page: server-rendered HTML with the content in the body, React on the server with
plain elements, a small interactive part (a "save this recipe" button) hydrated in the browser and loaded late, and
Markdown, `llms.txt` and the sitemap from the generated `web()`.

## Capabilities shown

- Publishing lifecycle (draft → publish): `lifecycle: publishing` on both Schemas in `manifests/recipes.yaml`;
  Admin's publish action runs the generated `recipes.publish` Procedure. Public Views and anonymous Store reads see
  published rows only.
- Translations: `recipe_translations` is `localized` and `translates: { parent: recipes, on: slug }`. A translation
  publishes only while its parent is published; the page View `recipe_translation` joins the parent's `total_minutes`,
  `servings` and `cover_url`.
- Visitor pages, always read as an anonymous caller, with every item of
  [public pages](../../handbook/guides/public-pages.md): head tags, Open Graph, JSON-LD `Recipe`, the short answer
  block, hreflang and `x-default`, per-language Markdown alternates, `llms.txt`, sitemap and robots.
- A save button for signed-in members: `manifests/saved-recipes.yaml` has a Schema owned by the member
  (`scope: "owner = auth.uid()"`), the View `my_saved_recipes`, the Procedures `save_recipe` and `unsave_recipe`, and
  their REST Triggers (`PUT` and `DELETE /api/saved-recipes/{slug}`).
- Cover images on R2: `wrangler.jsonc` (the shell's file plus the `MEDIA` bucket and two vars), `src/site-config.ts`
  (media purpose `cover`) and `src/media.ts` (`r2MediaStorage`). See "Cover images" below to switch it on.

Search for `AGENT:` for what an app must keep or still provide: list paging, Markdown headings per locale, the S3 signer.

## Files

| File | Purpose |
|---|---|
| `manifests/recipes.yaml` | Schemas `recipes` and `recipe_translations`; page Views `recipe` and `recipe_translation` (one row by its key, with the whole recipe as `markdown`); `recipe_locales` (hreflang); list Views `published_recipes`, `published_translations` and `translation_index` (no body) |
| `manifests/saved-recipes.yaml` | The member's saved recipes: Schema, View, Procedures and REST Triggers the save button uses |
| `src/routes.ts` | Routing, reads, `Cache-Control`, and `web()` (`.md`, `llms.txt`, `sitemap.xml`, head tags); imports no React |
| `src/html.tsx` | `renderToString` of the pages; reached only through `import()` from `src/routes.ts` |
| `src/pages.tsx` | The pages as React components with plain elements and class names, and the save button's markup |
| `src/client/page.ts` | The one script of every page: a few hundred bytes, no React; loads an island's code late |
| `src/client/page.css` | The one stylesheet: the kit's `kit.css` plus two layout rules |
| `src/client/save.tsx` | The save button's island: React, hydrated in the browser |
| `src/client/css.d.ts` | Lets TypeScript accept the stylesheet import |
| `src/handlers.ts` | `save_recipe`: saves only a recipe the member may read |
| `src/site-config.ts` | The locales, and the site defaults for the media library |
| `src/media.ts` | Cover-image storage on R2 |
| `smoke.mjs` | The checks below, with plain `fetch` |

## How a page is served

| Path | Answer | `Cache-Control` |
|---|---|---|
| `/{locale}/`, `/{locale}/recipes/{slug}` (GET, HEAD) | HTML rendered by React on the server | `public, max-age=60, stale-while-revalidate=600, stale-if-error=86400` |
| `/{locale}/recipes/{slug}.md`, `/llms.txt`, `/sitemap.xml` | The generated `web()`: page Views for `.md`, list Views for the indexes | the same (`cacheControl`) |
| `/robots.txt` | `Disallow: /admin/` and the sitemap | the same |
| `/` | 302 to `/zh-TW/` | `no-store` |
| A draft, an unknown recipe or path; a missing `.md` | 404 | `no-store` |
| Another method on a page | 405 | `no-store` |
| `/api/...` (the save button); an error | REST; the shell's `surfaceFailure` | `private, no-store` |
| `/sign-in` | Member sign-in (the shell's `src/sign-in.ts`) | `no-store` |

Pages read as the anonymous caller, so a signed-in visitor gets the same bytes and a shared cache may keep them; the
member's saves are only read by the button, through `/api`. `/assets/*` (the stylesheet and scripts) is served by the
edge without the Worker.

**React loads when a page route matches.** `src/routes.ts` reaches `src/html.tsx` (and with it `react-dom/server` and
`src/pages.tsx`) only through `import()`, started beside the page's read. The Worker's startup graph holds no React, so
`.md`, `llms.txt`, the sitemap, REST, MCP and Admin do not load it; `smoke.mjs` checks the built Worker for that. The
server pages use plain elements with the kit's class names, never kit components: those only produce class names and
double a new isolate's first render.

**The save button is an island, loaded late.** The server renders the whole recipe and a plain `<button>` inside
`<div data-island="save" data-props="...">`. Each page loads one module script, `/assets/client/page.js` (no React; a
module script does not block rendering). When the button nears the viewport, or on the first click, it imports
`/assets/client/save.js`, which hydrates the button with the same component (`SaveButton` in `src/pages.tsx`), asks
`my_saved_recipes` whether the recipe is saved, and saves or unsaves through the REST Triggers; an anonymous visitor's
click goes to `/sign-in` and back. A click that arrives before the code is replayed. Without JavaScript the visitor reads
the full recipe; only the button does nothing. `mantle bundle` builds each `src/client/*.ts(x)` into one self-contained
file, so the loader imports the island by a computed URL: a literal `import()` would be inlined, bringing React into it.

**One stylesheet.** `src/client/page.ts` imports `src/client/page.css` (the kit's compiled `kit.css` plus two layout
rules), which `mantle bundle` writes to `/assets/client/page.css`; every page links it. Only the classes in that file
exist: `smoke.mjs` checks that every class the pages use is in it. No Tailwind build step.

**Page Views and list Views.** A page View reads one row by its key (`slug` on `recipes`' unique index; `slug, locale`
on `recipe_translations`') and returns everything the page and its `.md` need. A list View returns only what a list
item, the sitemap and `llms.txt` need (`slug`, `locale`, `title`, `description`, `updated_at`), never the body: those
indexes walk it row by row, and `llms.txt` still links each row's `.md` because the page declares `markdown`.

**Markdown.** Each page View composes the whole recipe as `markdown` with `||` from text fields, which stays typed text on
D1 and PostgreSQL. The ingredient and step lines stay plain lines: making them a Markdown list (`replace`) or adding the
cooking time (a number) would make the column untyped, and `web()` takes only a text column.

## Combine with

- Need members to see or edit only their own rows? Add club-events' `restrict: { recipes: "author_id = auth.uid()" }` on a View.
- Need review before publishing, or an AI that approves? Add purchasing's guarded status transitions and admin MCP.

## Run it

This runs the example by itself, to read and try. For your own app, run `mantle init` and take only the patterns you need into its manifests and `src/` (`mantle help examples`).

```sh
npx mantle init my-app
cp -R node_modules/@aotter/mantle/docs/examples/recipes/. my-app/   # run the example as is
cd my-app && pnpm install && pnpm generate && pnpm types && pnpm check
```

Then follow the shell README (`db:init`, `dev`). Sign in at `/admin`, add a recipe, publish it, open `/zh-TW/`.
Add a translation from the recipe's language tab and publish it to get `/en/`.

## Cover images

The media library needs the generated site module, which the shell does not generate. To switch it on:

1. In `package.json`, add `--site src/site-config.ts` to both the `generate` and `check` commands, then
   `pnpm generate` (this adds the `site_config`/`media_assets` tables to `generated/schema.sql`).
2. In `src/service.ts`, import `site` from `../generated/site.js` and `coverStorage` from `./media.js`, and add
   `site, media: coverStorage(env, signer)` to `adminOptions`. The signer is app-owned (see `src/media.ts`).
3. Create the bucket, set CORS and the two `vars` in `wrangler.jsonc` (see `docs/handbook/cloudflare/media-r2.md`).

Admin's media library then uploads straight to R2 with presigned URLs; copy a committed image's URL into `cover_url`.
The smoke does not cover upload: local `wrangler dev` has an R2 binding but no S3 endpoint to presign against.

## `pnpm smoke` proves

- Drafts (zh-TW and en) are absent from detail, `.md`, list and `llms.txt`, even when the request has an admin session.
- A translation cannot publish before its parent; publishing both through the Admin API makes them visible.
- The detail HTML holds the title in an `<h1>`, every ingredient and every step, in order; each list page holds its recipes.
- Each locale's detail page has title, description, canonical, hreflang (`zh-TW`, `en`, `x-default`) and a switcher link.
- JSON-LD parses as a `Recipe` with the recipe name; the en page inherits `totalTime` from its parent; the short answer is present.
- `.md` returns `text/markdown` with title, summary, ingredients and steps; `llms.txt`, the sitemap (with `lastmod`)
  and both locale lists show the published recipe; the list Views' rows carry no body; `/` redirects to `/zh-TW/`.
- Every response it reads states the `Cache-Control` in the table above; a member's and an admin's page, `.md` and
  `llms.txt` equal the anonymous ones, with no cookie set.
- The HTML loads one stylesheet holding every class it uses and one module script under 1 KB without React; it never
  references the island's bundle; the built Worker's startup graph holds no React.
- Saving is REST-only, idempotent, refuses a draft or unknown recipe (404) and a malformed slug (400), is private to each
  member (another member's list is empty and their unsave changes nothing), and unpublishing a recipe hides it from the
  list, both locales and the Markdown.

A browser run of the button (lazy load, hydration, save and sign-in) is acceptance work, not part of the smoke.
