# Recipes

A multilingual recipe site. Admins write recipes in Admin as drafts and publish them; visitors read the published
recipes in Traditional Chinese (`zh-TW`, the default) and English (`en`) without signing in. The visitor pages are
plain app-owned HTML with the head tags search and answer engines read, plus Markdown and `llms.txt` for AI agents.

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

Search for `AGENT:` for what an app must still provide: layout and styling, cache policy, list paging, the S3 signer.

## Combine with

- Need members to see or edit only their own rows? Add club-events' `restrict: { recipes: "author_id = auth.uid()" }` on a View.
- Need review before publishing, or an AI that approves? Add purchasing's guarded status transitions and admin MCP.

## Copy

```sh
cp -R node_modules/@aotter/mantle/docs/examples/app-shell/. my-app/
cp -R node_modules/@aotter/mantle/docs/examples/recipes/. my-app/
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
- Each locale's detail page has title, description, canonical, hreflang (`zh-TW`, `en`, `x-default`) and a switcher link.
- JSON-LD parses as a `Recipe` with the recipe name; the en page inherits `totalTime` from its parent; the short answer is present.
- `.md` returns `text/markdown`; `llms.txt` and both locale lists show the published recipe; `/` redirects to `/zh-TW/`.
