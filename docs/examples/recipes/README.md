# Recipes

A multilingual recipe site. Admins write recipes in Admin as drafts and publish them; visitors read the published
recipes in Traditional Chinese (`zh-TW`, the default) and English (`en`) without signing in. The visitor pages are
plain app-owned HTML with the head tags search and answer engines read, plus Markdown and `llms.txt` for AI agents.
Signed-in members also have a React app under `/app` to save recipes ("my saved recipes"): the shape of most real sites,
crawlable public pages plus an interactive area.

## Capabilities shown

- Publishing lifecycle (draft → publish): `lifecycle: publishing` on both Schemas in `manifests/recipes.yaml`;
  Admin's publish action runs the generated `recipes.publish` Procedure. Public Views and anonymous Store reads see
  published rows only.
- Translations: `recipe_translations` is `localized` and `translates: { parent: recipes, on: slug }`. A translation
  publishes only while its parent is published, and its reads merge the parent's `total_minutes`, `servings` and
  `cover_url` (`src/routes.ts` `read`).
- Visitor pages in `src/routes.ts` (routing, reads) and `src/pages.ts` (rendering), always read as an anonymous caller:
  - every item of [public pages](../../handbook/guides/public-pages.md): head tags, Open Graph, JSON-LD `Recipe`, the
    short answer block, hreflang and `x-default`, per-language Markdown alternates, `llms.txt`, sitemap and robots.
- Cover images on R2: `wrangler.jsonc` (the shell's file plus the `MEDIA` bucket and two vars), `src/site-config.ts`
  (media purpose `cover`) and `src/media.ts` (`r2MediaStorage`). See "Cover images" below to switch it on.

- A React single-page app under `/app` (see "Public pages plus an app" below): `src/spa/main.tsx`, its shell
  `public/app/index.html`, the build `build-spa.mjs`, and `manifests/saved-recipes.yaml`: a Schema owned by the member
  (`scope: "owner = auth.uid()"`), the View `my_saved_recipes`, the Procedures `save_recipe` and `unsave_recipe`, and their
  REST Triggers (`PUT` and `DELETE /api/saved-recipes/{slug}`, plus MCP Triggers).

Search for `AGENT:` for what an app must still provide: layout and styling, cache policy, list paging, the S3 signer.

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

## Public pages plus an app

The public pages above are unchanged and complete without JavaScript. `/app` is one more route in `src/routes.ts`
(`appShell`), ahead of the public-page matcher:

| Path | Answer |
|---|---|
| `/app`, `/app/`, `/app/recipes/{slug}`, any deeper path without a dot | An anonymous visitor: 303 to `/sign-in?return=<path>`, and back after sign-in (`signInRedirect`). A signed-in one: the shell, `public/app/index.html`, fetched from `ASSETS` with `noindex` in its markup and `X-Robots-Tag: noindex`. |
| `/app/missing.js`, `/application`, any other unknown path | 404 |
| `/assets/spa.js` | The built app, served by the edge from `dist/client` without running the Worker (`run_worker_first` excludes `/assets/*`). |

The app lists recipes from the public View `published_recipes` and the member's from `my_saved_recipes`, and saves or
unsaves through the REST Triggers only; it never calls a Procedure with request data directly. `save_recipe` is a ref
handler (`src/handlers.ts`) that checks the recipe is published, then runs the SQL Procedure `save_recipe_write`, which
leaves `owner` out so Mantle fills it from the verified caller. `scope` keeps every read and write to the caller's own
rows, so one member cannot see or unsave another's. Each public recipe page ends with a "Save this recipe" link to
`/app/recipes/{slug}`; `/app` is in neither `sitemap.xml` nor `llms.txt`, and `robots.txt` does not disallow it, so
crawlers can read its `noindex`.

**Build.** `mantle bundle` builds the Worker and Admin and copies `public/`, but not an app's own browser code, and
`mantle generate` owns the `build.command` in `wrangler.jsonc`, so the app is a separate, app-owned step:
`node build-spa.mjs` (esbuild; the shell lists `esbuild` and `@types/react-dom` as dev dependencies, add them to an app
made before that) writes `dist/client/assets/spa.js`. Run it before `pnpm dev` and `wrangler deploy`; `pnpm smoke` runs
it for you. Without it `/assets/spa.js` is a 404 and the shell stays empty. For a build-time static page from the same
data (a landing page), the same step could write HTML into `public/`; this example does not.

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
- Each locale's detail page has title, description, canonical, hreflang (`zh-TW`, `en`, `x-default`) and a switcher link.
- JSON-LD parses as a `Recipe` with the recipe name; the en page inherits `totalTime` from its parent; the short answer is present.
- `/app/...` sends an anonymous visitor to `/sign-in` with the way back; for a member it returns the shell with `noindex`
  (markup and header), the bundle is served, other unknown paths (and missing files under `/app`) are 404, and the
  public detail page still links into the app while the sitemap, `llms.txt` and `robots.txt` do not mention `/app`.
- Saving is REST-only, idempotent, refuses a draft or unknown recipe (404) and a malformed slug (400), is private to each
  member (another member's list is empty and their unsave changes nothing), and unpublishing a recipe hides it from the list.
- `.md` returns `text/markdown`; `llms.txt` and both locale lists show the published recipe; `/` redirects to `/zh-TW/`.
