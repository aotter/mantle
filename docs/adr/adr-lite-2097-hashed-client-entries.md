# ADR-lite: Content-hashed copies of the browser entries

**Status:** Accepted, issue #2097. Adds the developer-API subpath `@aotter/mantle/client-assets` and an output of
`mantle bundle`; no grammar. Additive: the stable names and an application that changes nothing behave as before.

## Context

`mantle bundle` builds each browser entry `client/<name>.ts|tsx` into `/assets/client/<name>.js` (and `.css`) under a
stable name ([#2036](https://github.com/aotter/mantle/issues/2036)), served by Workers static assets with the platform
default `Cache-Control: public, max-age=0, must-revalidate` and an ETag. Every page view revalidates every file.

Measured 2026-11-20 on Workers Free (method and raw numbers in #2097):

- A `304` for a stable name costs about one network round trip to the edge (about 50 ms in the test) and is never a
  cache hit (`REVALIDATED`). A content-hashed file served `immutable` makes no request on a repeat view, also on reload.
- Behind a dispatcher Worker with Placement in another region, every asset request, a `304` included, paid the placement
  round trip (about 300 ms per `304`). A repeat view of a page with two browser files loaded in 874 ms with stable names
  and 430 ms with hashed names.
- After a deploy, a previous build's hashed name answers `404` (a Worker version serves only its own assets), and that
  `404` carries the `_headers` rule matching its path: served `immutable`, it was cached.
- A tab opened before a deploy that lazily imports a hashed file afterwards fails the import. With stable names the
  same tab silently gets the new build's code under the old name, a version mismatch.
- A deploy starts Workers Cache cold, and a Worker version includes its assets, so HTML a version renders names files
  that version has.

## Decision

1. **Hashed copies beside the stable names.** For each entry `mantle bundle` also writes
   `<assets>/assets/client/h/<name>-<hash>.js`, and `<name>-<hash>.css` when the entry imports CSS. The hash is the
   first 16 hex digits of the SHA-256 of the file's bytes, so identical content keeps its name across builds. The
   browser files never name each other (an island loader gets its island's URL from the HTML), so no hashing order
   applies. The stable files are written as before.
2. **The map, imported by the Worker.** `@aotter/mantle/client-assets` exports
   `clientAssets: Readonly<Partial<Record<string, ClientAsset>>>`, `ClientAsset = { js: string; css?: string }`. Its
   module in the package is an empty map; when `mantle bundle` bundles the Worker it replaces the import with this
   build's map. It is typed before any build, so `tsc` runs before `mantle bundle`, and a Worker that does not import it
   bundles nothing of it. Outside a Worker build (a `bun-*` server run as TypeScript, a test) the map is empty, which is
   why the type makes every entry optional: code falls back to the stable name.
3. **One year, immutable.** The build's `_headers` gets
   `/assets/client/h/*` with `! Cache-Control` and `Cache-Control: public, max-age=31536000, immutable`, through the
   same file as Admin's rule: written when absent; rewritten when it holds only rules `mantle bundle` writes; appended to
   a copy of `public/_headers`; printed, not written, for a file the build did not copy. `! Cache-Control` drops a
   broader rule's value, which `_headers` would otherwise join to this one. A rule the application wrote for the path is
   kept.
4. **Opt-in use.** Applications choose per page whether to link the hashed names. The recipes example does; the
   purchasing example's static `public/app/index.html` cannot read the map and keeps the stable names.

## Not done, and why

- **Keeping a previous build's hashed files.** New HTML always names files of its own version (a version includes its
  assets), so old files only serve tabs opened before a deploy.
- **Answering a missing hashed path from the Worker with `no-store`.** It would put `/assets/client/h/*` back on the
  Worker's path (`run_worker_first`) for the same remaining case.

That case is a tab opened before a deploy that lazily imports afterwards. The SDK adds no mechanism; the recipes
example's island loader reloads the page once when an island's `import()` fails, and the handbook describes it.

## Known limits

- An open tab that lazily imports after a deploy fails that import (handled by the application, above).
- That failed request's `404` is stored by the browser for a year under a name no current HTML references. If the
  name is served again later (a rollback to that build, or two versions served at once during a gradual deployment
  without a version key), that browser keeps the `404` until its cache is cleared. Admin's chunks use one day for this
  reason (#2088); the browser entries take a year because the measured gain is on every repeat view and the case needs
  a lazy import across a deploy followed by a rollback.

## Acceptance

- `tests/bundle-client.test.ts`: the copies exist with the stable files' bytes; names stay with the content and change
  with it; the map reaches a bundled Worker through the registered consumer module (`client-assets` in
  `tests/application-seams.ts`) and is empty without entries and in the package's own module; a Worker that does not
  import it holds none of it; the `_headers` rule is written, appended to a copied `public/_headers`, kept when the app
  has one, and only printed for the app's own file. `tests/bundle-admin.test.ts`: Admin's rule and this one share one
  file.
- The recipes example's `smoke.mjs` checks in workerd that its HTML links hashed files that answer `200` with the
  immutable header and that the stable names still answer.
