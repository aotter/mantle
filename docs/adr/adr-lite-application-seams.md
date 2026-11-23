# ADR-lite: Application seams

**Status:** Accepted. Adds no subpath and no grammar.

## Context

Some public entry points are required by applications although Core itself has no internal use for them. A cleanup
that looks only at Core's own callers can remove, move or narrow one with nothing failing, as happened in
0.2.2-alpha.2 (#1967).

## Decision

1. **Registry.** `packages/mantle/tests/application-seams.ts` lists the required entry points: id, entry point,
   stacks, the decision that keeps it, and a consumer module. `application-seams.ids.json` pins the ids. The source of
   each entry point carries a fixed marker comment pointing to the rule.
2. **Guard.** `application-seams.test.ts` in Core and Admin, part of `pnpm test` and so of PR CI, fails when a required
   seam disappears, moves under `./internal/`, loses an export or a type, or stops running:
   - each consumer module is checked by its syntax tree: every `@aotter/*` import resolves through the package's
     exports map to `dist` by a key outside `./internal/`; no relative import out of its directory, no computed import,
     no cast, non-null assertion, `any` or `@ts-` directive;
   - it is typechecked against the built package on each of its stacks;
   - it is executed unless the registry marks it typecheck-only: bun-sqlite on bun:sqlite, cloudflare-d1 on the D1
     stand-in over bun:sqlite (not workerd), cloudflare-postgres with postgres.js and bun-postgres with Bun.SQL under
     Bun when the PostgreSQL URLs are set (PR CI sets them; otherwise the test prints what did not run). workerd and
     Hyperdrive stay covered by `test:native`.
   A failure names the seam, the registry and the rule.
3. **Rule.** Removing, moving or narrowing a registered seam needs an accepted ADR or ADR-lite and a migration note
   naming the replacement. New public surface that applications depend on adds a registry entry, its id and its
   consumer module in the same PR. Entries, consumer modules and their tests state that a seam is required, not what it
   is used for; fixtures are minimal and neutral.
4. **Stacks.** Mantle commits to its four targets: `cloudflare-d1`, `cloudflare-postgres`, `bun-postgres` and
   `bun-sqlite`. A seam is typed and tested on each one it applies to.
