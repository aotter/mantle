# ADR-0022: Caller-observed `expectedVersion` for Admin and builtin upsert

**Status:** Accepted

**Date:** 2026-09-14

**Related:** [#850](https://github.com/aotter/mantle/issues/850),
[ADR-0020](0020-builtin-handler-contracts-and-matched-upsert.md)

## Context

ADR-0020 remains the authority for builtin static contracts, `handler.match`
matching a declared unique index, natural-key lookup without a system `id`,
and `CONFLICT` without automatic retry.

Its **matched-upsert OCC** rule is outdated. Matched upsert forbade
`expectedVersion` on the Procedure input and, at runtime, substituted the
preloaded row's `version` for the caller's token. ID-based upsert did the same
whenever a preloaded row was supplied. The repository still rejected races
*after* the handler read, but a change made since the **client** read the row
was overwritten.

Admin rendered `expectedVersion` as an editable number. Operators had to type
a technical version, or a handler that re-read at submit time quietly dropped
read-time protection. Downstream (mantle-home organization quota) reproduced
this.

The intended contract: callers POST the **observed** native `entry.version`
from read time. Mantle enforces that token atomically. A successful write
still bumps storage to `expectedVersion + 1`. The token is **not**
`version + 1`.

## Decision

### 1. Wire semantics

`expectedVersion` is the observed native `entry.version` at read time.

- Successful repository writes still persist `expectedVersion + 1`.
- Callers must not send the next version.
- Core does **not** auto-inject `expectedVersion` into Manifests. Authors
  declare it. Omit → fail-closed `BUILTIN_HANDLER_CONTRACT_INVALID`.

### 2. Closed reserved wire names

The reserved Procedure input wire name for OCC is `expectedVersion`. Business
fields must not collide with it. New reserved wire names require an ADR.
OCC behaviour must not depend on `x-mcp-hint`. The magic word is the property
name only.

### 3. Static contracts (amends ADR-0020 §2 matched upsert)

Keep ADR-0020 for `update` (`id` + `expectedVersion` both strict and
required), `delete`/`archive` (`id` required), `handler.match` vs
`uniqueIndexes`, and forbidding `id` on matched upsert.

**Matched upsert (`op: upsert` + `match`):**

- `input.properties.expectedVersion` **must** be a strict, non-nullable
  `number`.
- `expectedVersion` is **not** globally required: the create branch has no
  version. Authors may list it in `required` only when the Procedure is
  update-only.
- `input` must still **not** declare `id`.

**ID-based upsert (`op: upsert` without `match`):**

- `input.properties.expectedVersion` **must** be a strict `number` (fail-closed
  if omitted). It is not in `required`.
- If `id` is declared, it must be a strict `string`. Neither `id` nor
  `expectedVersion` is required, so create can omit both.

### 4. Runtime (amends ADR-0020 §3)

Intent is the presence of a finite numeric `expectedVersion`, not the
presence of an id or a preload hit.

| Branch | Caller token | Existing row | Result |
|---|---|---|---|
| Create | absent | none | `create` (no version) |
| Create race | absent | unique collision after miss | `CONFLICT`; no silent overwrite |
| Update | present | found | atomic OCC with **caller** token; never `preloaded.version` |
| Update, stale | present | found, version ≠ token | `CONFLICT`; no retry |
| Update, missing | present | none (deleted / unknown) | `NOT_FOUND`; do **not** create |
| Create-intent vs existing | absent | found | `INPUT_VALIDATION_FAILED`; do **not** overwrite |

`opUpdate` always reads `expectedVersion` from caller input when a versioned
write is attempted. Preload supplies identity (`id`) and PATCH base data only.

There is still **no automatic retry**.

### 5. First-party Admin / SDK bind (not grammar)

When Procedure `input` declares `expectedVersion`, first-party Admin (and any
first-party SDK helper) treats the name as magic:

- Auto-bind the OCC target row's current `version` captured at read.
- Hide the field from the editable form (same UX idea as
  `x-mcp-hint: idempotency-key`, keyed by reserved **name**).
- Rebind when the selected target changes. An organization row must not
  supply `expectedVersion` for a membership mutation.
- On `CONFLICT` / HTTP 409: keep operator business inputs; require an
  explicit re-read; **no** auto-retry with the latest version.
- Background refetches of the same target must not replace a captured
  token while the form still holds older values.

Other callers (HTTP Trigger, MCP, custom clients) supply the observed
version themselves. Magic bind/hide is first-party only.

OCC target for Admin bind:

1. If `input` declares `id`, the target is `form.id` (the membership / row
   being mutated), never a merely contextual parent ref.
2. Else if the Procedure is builtin, prefer the `rowBindings` entry whose
   `collection` equals `handler.schema`.
3. Else if another row binding (not the launch collection) identifies an
   entry id, use that once filled.
4. Else use the launch row (quota-style actions bound only to that row).

A not-yet-existing target has no version: omit `expectedVersion` so upsert
takes the create branch.

### 6. Compatibility

This is a **breaking** change for:

- Matched-upsert Manifests that omitted `expectedVersion` (now fail
  validate).
- Callers that updated via matched or ID-based upsert without sending an
  observed version (preload OCC). Those writes now fail closed instead of
  overwriting with the version read inside the handler.
- Matched-upsert Manifests that declared `expectedVersion` (previously
  rejected; now required as a property).

Callers that already sent the observed version on `op: update` are
unchanged. HTTP and MCP share the Procedure input contract; only Admin/SDK
auto-fill the reserved name.

## Consequences

- Read-time OCC works through Admin forms, HTTP Triggers, and MCP for both
  `update` and version-checked upsert.
- Create remains possible without a version; a versioned write cannot
  silently recreate a deleted row.
- AI authors must declare `expectedVersion` as a strict number on OCC
  builtins. Tool descriptions state **observed** version, not `+1`.

## Alternatives considered

1. **`x-mcp-hint: entry-version`.** Rejected. OCC must not depend on hints;
   the reserved property name is the contract.
2. **Keep preload OCC for matched upsert.** Rejected. Accepting
   `expectedVersion` and ignoring it is worse than forbidding it.
3. **Require `expectedVersion` in `input.required` for every upsert.**
   Rejected: that makes create impossible at validate time.
4. **Auto-retry upsert on `CONFLICT`.** Rejected in ADR-0020; unchanged.
5. **Auto-inject the property into Manifests.** Rejected: fail-closed
   grammar; authors (often agents) must see the field.

## How to apply

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: upsert-membership
spec:
  input:
    type: object
    required: [organizationId, userId, role]
    properties:
      organizationId: { type: string, x-mantle-ref: organizations }
      userId: { type: string }
      role: { type: string }
      expectedVersion: { type: number }
  output:
    type: object
  handler:
    kind: builtin
    op: upsert
    schema: organization-members
    match: [organizationId, userId]
```

- Create: `{ organizationId, userId, role }` — no version.
- Update: the same fields plus `expectedVersion` equal to the membership
  row's current `version`.
- Stale token → `CONFLICT` (409). Deleted membership + token → `NOT_FOUND`.

## Implementation status

- `@aotter/mantle-spec`: `ManifestGraphValidator` fail-closed
  `expectedVersion` on upsert; `EXPECTED_VERSION_PROPERTY` reserved name.
- `@aotter/mantle-runtime`: `InvokeBuiltinUseCase` uses the caller token;
  MCP catalog copy states observed version.
- `@aotter/mantle-admin` / `@aotter/mantle-admin-ui`: operations expose
  builtin `targetCollection`; Admin binds and hides `expectedVersion`.
- Docs: this ADR, ADR-0020 amendment pointer, design-atoms, handbook.
