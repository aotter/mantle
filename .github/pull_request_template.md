## Summary

-

## Why

-

## Scope

-

## Non-goals

-

## Migration

<!--
Required when this PR breaks an application: an exports-map key of a published package removed, moved under
`internal/`, turned into a stub or losing a condition, a `bin` name removed, a published peer range changed or made
required, a commit subject with `!`, or a break the check cannot see (behaviour, types, generated output). One line per
item, `before` → `after`, naming the replacement in backticks or saying "no replacement"; a subpath with a replacement
keeps a throwing stub ("removed with stub"). Also apply the `breaking-change` label. The "Breaking changes declared"
check verifies this (scripts/check-breaking.mjs; CONTRIBUTING.md, "Breaking changes"). Otherwise write "None."
- `@aotter/mantle/old` → `thing` from `@aotter/mantle/new` (removed with stub)
- `@aotter/mantle/plumbing` → no replacement
-->

None.

## Test plan

- [ ] `pnpm check:pg` (PostgreSQL included)
- [ ] Only `pnpm check`, PostgreSQL tests skipped, because:
- [ ] Linux Full checks run on this branch (link; needed for PostgreSQL driver/dialect, auth, kernel request pipeline or generator output changes):
- [ ] Not run / not applicable:
- [ ] Other:

## Follow-ups

-

## Related

Refs #

## Contributor checklist

- [ ] Base branch is `develop`.
- [ ] Labels match `docs/labels.md`.
- [ ] ADR / grammar / security gates are called out when relevant.
- [ ] An application seam (`packages/mantle/tests/application-seams.ts`) is unchanged, or the ADR/ADR-lite and migration note are linked; new public surface for applications adds a registry entry.
- [ ] User-facing docs and release-note labels are accurate when relevant.
