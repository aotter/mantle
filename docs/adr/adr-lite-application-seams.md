# ADR-lite: Application seams

**Status:** Accepted. Adds no subpath and no grammar; adds an optional parameter to `body`, the `convertInput` export
of `@aotter/mantle/contracts` and the `inputTimeoutMs` option of `mediaUploadCard`.

## Context

Applications build on public entry points beyond mounting the generated modules: their own routes beside the generated
surfaces, their own SQL in a Store transaction, hosts that call generated functions directly, their own MCP tools and
Apps. In 0.2.2-alpha.2 a cleanup separated generated-code plumbing from the developer API (#1967). Some entry points
applications used were removed or moved under `./internal/` with a release-note line only, because nothing in the
repository said they existed on purpose. Applications then imported plumbing or kept private copies of SDK code (a JSON
body reader, the input conversion), which drift when the SDK changes.

## Decision

1. **A registry of application seams.** `packages/mantle/tests/application-seams.ts` lists each deliberate entry point
   by the generic capability it gives, the stacks it applies to and the decision that keeps it;
   `application-seams.ids.json` pins the ids. Each entry names a hand-written consumer module that
   `application-seams.test.ts` in Core and Admin checks for the shape of application code (every `@aotter/*` import
   resolves through the exports map to `dist` by a key outside `./internal/`; no relative import out of its directory,
   no computed import, no cast, `any` or `@ts-` directive) and typechecks against the built package on each of its
   stacks. Where the seam runs, the test also executes it: bun-sqlite on bun:sqlite, cloudflare-d1 on the D1 stand-in
   over bun:sqlite (not workerd), cloudflare-postgres with postgres.js and bun-postgres with Bun.SQL under Bun when the
   PostgreSQL URLs are set (as in PR CI; otherwise the test prints the seams that did not run). Seams marked
   `run: false` (managed grants, a page's app tools) are typechecked only and tested elsewhere. workerd and Hyperdrive
   coverage stays in `test:native`. These tests are part of `pnpm test`, so they run on every PR into `develop`; a
   failure names the seam and the registry.
2. **The rule.** Removing, moving or narrowing a registered seam needs an accepted ADR or ADR-lite and a migration note
   naming the replacement. New public surface for applications adds a registry entry and its consumer module in the
   same PR (CONTRIBUTING.md, "Application seams").
3. **Four stacks.** Mantle commits to its four targets, `cloudflare-d1`, `cloudflare-postgres`, `bun-postgres` and
   `bun-sqlite`; a seam is typed and tested on each one it applies to.
4. **JSON body.** `body(request, limit?, refuse?)` of `@aotter/mantle/rest` takes the caller's refusal, so an
   application's own route keeps its own error code and path; when `refuse` returns instead of throwing, or without
   it, the refusal is `INPUT_VALIDATION_FAILED` at `rest`. An invalid `limit` is a `TypeError`. No `./json-body`
   subpath returns: one reader, in the module that already exports it.
5. **Input conversion.** `convertInput` of `@aotter/mantle/contracts` is the function the surfaces call, re-exported
   beside `wireRows` (the output half); a test pins that it is the same function. `callTool` of `@aotter/mantle/mcp`
   remains the first choice for calling a generated tool without its transport.
6. **Upload card input.** With `forward`, the upload card waits for the host's tool input at most `inputTimeoutMs` after
   connecting (5,000 ms by default; `false` waits as before), then calls without the forwarded arguments, so the
   server's answer shows instead of a card that waits forever; a late input re-reads the purposes. The wait has a unit
   test in PR CI; the browser test runs on demand and at release.

## Consequences

The registry is a compatibility list, not a second API: the handbook remains the documentation. A seam's consumer
module is small and invented; it shows the shape an application writes, not any particular application.
