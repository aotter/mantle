# Fresh consumer: Bun + PostgreSQL procurement

Baseline: Core `develop` at `5c9a6ae08740702dd683d6a13d64eed260f5cdc9`.
Issue: #1335. A fresh coding agent received no earlier application context and
used installed consumer instructions and exact packed Core/UI, outside the SDK
checkout. This is a local developer-experience experiment, not a deployment or
publication claim.

## Environment and application

Bun 1.4.2, PostgreSQL 17.11 in an isolated container, dedicated empty databases
owned by a non-superuser application role. The application uses native Bun.SQL,
Mantle identity, real email OTP sessions, Admin, REST and public/staff MCP.
No private SDK imports or direct business-table writes are used. The independent
database assertion reads only; all business writes run through Mantle surfaces.

The agent authored one-item requisitions: draft -> submitted -> approved/returned,
revision and resubmission, member ownership, owner/editor review, no self-review,
and optimistic version checks. Schema generic writes are disabled. An application
Admin Surface wrapper denies contributor raw collection access; owner/editor
reviewers are explicitly allowed all request details.

## Findings and repairs

- Unversioned CLI/quickstart installation selected registry latest, outside the
  packed SDK's exact peers. Presence-only generate checks accepted it. Generate
  now derives install versions from the consumer's installed Core metadata and
  rejects incompatible peers before writing; UI must match Core's version.
- Better Auth 1.7.7 introduced eager schema validation before Mantle's lazy
  convergence. All auth dependencies and the nested provider override are upgraded
  together. Mantle now executes Better Auth's public explicit schema check after
  convergence, including a current ledger; schema drift still refuses auth.
- Consumer instructions now separate Bun and Cloudflare dev dependencies, explain
  Bun local OTP, email normalization, shared loopback/plugin-specific rate limits,
  and automatic schema preparation. The reference consumer's auth pins match.
- Application test mistakes involved OTP email case, folded PostgreSQL field
  identifiers, bigint assertions and a final revision's quantity. These were
  repaired in the consumer, without changing SDK semantics.
- Application review caught contributor raw Admin reads; the wrapper and real
  denial test repair that policy gap. Concurrent review verifies exactly one
  success and one conflict, with one version increment.
- Sandbox networking and Bun's cached same-filename local tarball required
  network access and a new tarball filename. Installed metadata was checked before
  accepting upgraded-package evidence, and another empty database was used.

## Real consumer validation

With the upgraded packed SDK, exact Better Auth 1.7.7 peers, and a fresh database:
`bun run check` (generate check + TypeScript) and fourteen smoke checks pass.
They cover anonymous denial, three real OTP users and persisted sessions, input
validation, forged owner rejection, duplicate request numbers, member isolation,
Admin promotion, public MCP submit, Admin return, REST revise/resubmit, staff MCP
approve, generic create/edit/delete denial, stale and simultaneous-review conflicts,
self-review denial, immediate role revocation, CSRF, tool visibility, and a separate
PostgreSQL persistence read. First startup has no schema mismatch diagnostic.

A separate real installed-consumer fixture with Better Auth 1.7.2 is refused by
the upgraded generator with `bun add better-auth@1.7.7` and no generated writes.
OTP, cookies, secrets and database URLs are excluded from records.

The standalone application and its detailed README, BLOCKERS, VERIFICATION and
redacted server observations remain in the task workspace at
`/workspace/procurement-bun-pg`. It is not bundled into Core or deployed.
