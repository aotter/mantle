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
   applies. The stable files are written as before. A build writes its files over the previous build's directory and
   removes what it did not write only once the Worker naming the new files is built, so a name both builds have is
   never missing while `wrangler dev` rebuilds, and the running Worker's names stay until its successor exists.
   An entry named like an `Object.prototype` member (`constructor`, `__proto__`) is refused, so a map lookup is only
   ever an entry or `undefined`.
2. **The map, imported by the Worker.** `@aotter/mantle/client-assets` exports
   `clientAssets: Readonly<Partial<Record<string, ClientAsset>>>`, `ClientAsset = { js: string; css?: string }`. Its
   module in the package is an empty map; when `mantle bundle` bundles the Worker it replaces the import with this
   build's map. It is typed before any build, so `tsc` runs before `mantle bundle`, and a Worker that does not import it
   bundles nothing of it. Outside a Worker build (a `bun-*` server run as TypeScript, a browser file, a test) the map is
   empty, which is why the type makes every entry optional: code falls back to the stable name. The map is the
   server's: `mantle bundle` prints a note when it survives tree shaking into a browser file.
3. **One day, immutable.** The build's `_headers` gets
   `/assets/client/h/*` with `! Cache-Control` and `Cache-Control: public, max-age=86400, immutable`, through the
   same file as Admin's rule: written when absent; rewritten when it holds only rules `mantle bundle` writes; appended to
   a copy of `public/_headers`; printed, not written, for a file the build did not copy; removed when it holds only
   such rules and a later build has none. `! Cache-Control` drops a broader rule's value, which `_headers` would
   otherwise join to this one. A rule the application wrote for the path is kept. One day, the value and reasoning of
   Admin's chunks (#2088): the edge sends the rule on its `404` too, and a browser keeps that `404` for the rule's
   `max-age`. A request can get a `404` for a **current** name while a deploy propagates (it reaches a location still
   on the previous version) or while `wrangler dev` rebuilds, and an old name is served again after a rollback. A day
   bounds each of these; the measured benefit, no request on a repeat view, is kept within the day.
4. **Opt-in use.** Applications choose per page whether to link the hashed names. The recipes example does; the
   purchasing example's static `public/app/index.html` cannot read the map and keeps the stable names.
5. **Workers only.** A `bun-*` server runs as TypeScript, so nothing gives it the map, and `bunAdminAssets` serves
   `/assets/client/` with revalidation. Its build writes no hashed copies and no rule; its pages link the stable names.
   Serving the copies on Bun would need a second way to deliver the map to a TypeScript server, which is left until an
   application asks for it.

## Not done, and why

- **Keeping a previous build's hashed files.** New HTML always names files of its own version (a version includes its
  assets), so old files only serve tabs opened before a deploy.
- **Answering a missing hashed path from the Worker with `no-store`.** It would put `/assets/client/h/*` back on the
  Worker's path (`run_worker_first`) for the same remaining case.

That case is a tab opened before a deploy that lazily imports afterwards. The SDK adds no mechanism; the recipes
example's island loader, when an island's `import()` fails, asks for the file again (`HEAD`, `no-store`) and reloads
the page once per URL only on a `404`, never offline or on another failure; the handbook describes it.

## Known limits

- An open tab that lazily imports after a deploy fails that import (handled by the application, above).
- That failed request's `404`, or one a request got for a current name during a deploy's propagation, is stored by
  the browser for up to a day. A first view after a day revalidates nothing but requests each file again.
- `bun-*` targets get no hashed copies (Decision 5).

## Acceptance

- `tests/bundle-client.test.ts`: the copies exist with the stable files' bytes; names stay with the content and change
  with it; the map reaches a bundled Worker through the registered consumer module (`client-assets` in
  `tests/application-seams.ts`) and is empty without entries and in the package's own module; a Worker that does not
  import it holds none of it; the `_headers` rule is written, appended to a copied `public/_headers`, kept when the app
  has one, only printed for the app's own file, and removed with the build's own file when a later build has no rules;
  an unchanged copy is not rewritten and a stale one is removed only after writing; a `bun-*` build writes no `h/`; the
  map's keys are in code-unit order; prototype member names are refused; a browser file holding the map is noted. `tests/bundle-admin.test.ts`: Admin's rule and this one share one
  file.
- The recipes example's `smoke.mjs` checks in workerd that its HTML links hashed files that answer `200` with the
  one-day immutable header and that the stable names still answer.
