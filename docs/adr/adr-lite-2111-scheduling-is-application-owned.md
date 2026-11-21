# ADR-lite: Scheduling is application-owned

**Status:** Accepted, issue #2111. Records the 0.2.0 decision that the 2026-10-19 amendment of
[ADR-0027](0027-scheduled-procedure-triggers.md) says no ADR records, and declines a manifest-level `schedules:`
declaration for now. No grammar, API or runtime change.

## Context

- **0.1.5** ([ADR-0027](0027-scheduled-procedure-triggers.md), #1087): `Trigger.spec.source` gained `kind: schedule`
  with a cron expression. The compiled plan carried it, and Cloudflare's `scheduled` entry invoked the matching
  Procedures through the Procedure pipeline with a system context.
- **The 0.2.0 plan** ([ADR-0032](0032-store-centric-core-and-service-contract.md)): schedule Triggers took POSIX cron;
  a service that wired schedules passed `schedules: true` to `createMantle`, whose `invokeSchedule(cron, scheduledTime,
  env, ctx)` turned a cron event into Trigger invocations; the generated Cloudflare preset wired `scheduled` to it and
  wrote `triggers.crons`; `toCloudflareCron` translated POSIX weekdays to Cloudflare's.
- **What 0.2.0 shipped** is native Core ([ADR-0045](0045-next-runtime-core.md)): generated queries that applications
  call with their own handles and Caller, and an application-owned entry. `mantle generate` "does not scaffold a
  website or service preset", and request code "does not interpret a RuntimePlan" ([CONTRIBUTING](../../CONTRIBUTING.md)).
  ADR-0027's amendment of 2026-10-19 records the result: generation rejects every `schedule` and `lifecycle` source,
  scheduling is application-owned, TTL maintenance calls the generated `<schema>.sweepExpired`, and ADR-0032's
  `invokeSchedule` and `schedules: true` are withdrawn. Its amendment of 2026-11-10 moves the refusal into the parser
  (`INVALID_MANIFEST_ENVELOPE` at `/spec/source/kind`).
- #2111 proposes a top-level `schedules:` declaration that generation validates, with a generated `runSchedule(cron,
  ctx)` dispatcher and a generated cron list, so that `scheduled()` is one line and the platform's cron list cannot
  drift from the code.

## Decision

1. **Withdrawn in 0.2.0, recorded here:** `schedule` as a Trigger source (with `lifecycle`), `invokeSchedule`,
   `createMantle`'s `schedules: true`, and the generated preset's `scheduled` wiring and `triggers.crons`.
2. **Core keeps:** `toCloudflareCron` (`@aotter/mantle/cron`), the generated system-only, bounded
   `<schema>.sweepExpired`, the system Caller (`{ kind: "system", reason }`), and generated Procedures that application
   code calls directly with it.
3. **The application owns** its `scheduled()` export, its platform cron list (`triggers.crons` in `wrangler.jsonc`),
   the map between the two, the reason each system Caller carries, and how outcomes are reported. The handbook's
   pattern is one checked map from cron to generated Procedures, a `scheduled()` that refuses an unknown cron and
   reports each job (`Promise.allSettled`), and a test that the map's keys, through `toCloudflareCron`, equal the
   declared `triggers.crons` ([scheduled work](../handbook/cloudflare/deploy-and-operate.md#scheduled-work)).
4. **Declined for now:** a manifest-level `schedules:` key, a generated dispatcher and a generated cron list.

## Why

What the record states:

- In 0.2.0 no Core-owned entry receives a platform event: applications own their entry, routes and resources, and
  generated modules perform no initialization on import ([ADR-0045](0045-next-runtime-core.md),
  [CONTRIBUTING](../../CONTRIBUTING.md)). `invokeSchedule` lived on the `createMantle` service that 0.2.0 did not ship.
- "The host never enters the plan" ([ADR-0036](0036-host-and-dialect.md)); a schedule is a host event.
- TTL cleanup is explicit and bounded, and "no host automatically invokes it" ([ADR-0028](0028-schema-ttl-expiry.md)).
- "Native configuration belongs at the existing host or dialect seam. Avoid a new configuration language or generic
  option bag when application-owned code already expresses the choice" ([ADR-0040](0040-thin-native-toolkit.md) §4).

A motive for removing schedule Triggers in 0.2.0 beyond these is not recorded: ADR-0027's amendment cites the native
Core handbook, and the handbook states the result, not a reason.

Why no `schedules:` key now:

- **It would be a second declaration.** The platform runs what its own configuration lists (`triggers.crons`); a
  manifest key would either duplicate that list, which is the drift #2111 wants to remove, or generate it, which puts
  Mantle back in the business of writing platform configuration that 0.2.0 gave to the application. The checked map and
  the drift test keep the one declaration and the code together with no Core feature.
- **The drift that hurts is between a host and its tenants.** A host that runs applications as Workers it dispatches to
  invokes each application's `scheduled()` itself, so the list it must follow is each application's platform
  declaration. The host resolves that by reading the declaration it already receives; a manifest key would be a third
  copy for it to reconcile.
- **The checks #2111 asks for exist without it.** `toCloudflareCron` refuses an invalid or ambiguous cron when the
  map is loaded; `tsc` checks each job's call against the generated function's types; a target with `requires.auth`
  refuses the system Caller (it satisfies no predicate), which the first test run of `scheduled()` shows.

## Evidence that would reopen this

- Extension point requests (CONTRIBUTING, "Extension points are opened on evidence") from several applications whose
  hand-written maps a generated dispatcher would replace with less code and the same checks.
- A host that cannot read an application's platform declaration and needs the schedule from the manifest or
  `describe` instead.
- A second scheduling platform among Mantle's targets whose declaration is not a single file the application owns, so
  that the manifest would be the only portable source.
- A drift incident that the checked map and its test did not prevent.

## Consequences

- `describe` lists no schedules; the Trigger reference and the features Refused list stay as they are.
- Applications follow [scheduled work](../handbook/cloudflare/deploy-and-operate.md#scheduled-work); its example runs in
  `packages/mantle/tests/scheduled-work.test.ts`.
