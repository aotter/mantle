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
   by the generic capability it gives, the production stacks it applies to and the decision that keeps it. Each entry
   names a hand-written consumer module (public imports only, no casts) that `application-seams.test.ts` in Core and
   Admin typechecks against the built package and, where the seam has run-time behaviour, runs on `cloudflare-d1`,
   `cloudflare-postgres` and `bun-postgres`. These tests are part of `pnpm test`, so they run on every PR into
   `develop`; a failure names the seam and the registry.
2. **The rule.** Removing, moving or narrowing a registered seam needs an accepted ADR or ADR-lite and a migration note
   naming the replacement. New public surface for applications adds a registry entry and its consumer module in the
   same PR (CONTRIBUTING.md, "Application seams").
3. **Three production stacks.** Mantle commits to `cloudflare-d1`, `cloudflare-postgres` and `bun-postgres`; a seam is
   typed and tested on each one it applies to. `bun-sqlite` remains a generate target.
4. **JSON body.** `body(request, limit?, refuse?)` of `@aotter/mantle/rest` takes the caller's refusal, so an
   application's own route keeps its own error code and path; the default stays `INPUT_VALIDATION_FAILED` at `rest`. No
   `./json-body` subpath returns: one reader, in the module that already exports it.
5. **Input conversion.** `convertInput` of `@aotter/mantle/contracts` is the function the surfaces call, re-exported
   beside `wireRows` (the output half); a test pins that it is the same function. `callTool` of `@aotter/mantle/mcp`
   remains the first choice for calling a generated tool without its transport.
6. **Upload card input.** With `forward`, the upload card waits for the host's tool input at most `inputTimeoutMs` after
   connecting (5,000 ms by default), then calls without the forwarded arguments, so the server's answer shows instead
   of a card that waits forever.

## Consequences

The registry is a compatibility list, not a second API: the handbook remains the documentation. A seam's consumer
module is small and invented; it shows the shape an application writes, not any particular application.
