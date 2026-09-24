# ADR-0028: Logical Schema TTL before explicit physical cleanup

**Status:** Accepted for 0.1.5 (#1088).

**Date:** 2026-09-25

## Context

An application needs a portable expiry rule across D1 and Bun SQLite. A cron-only delete task cannot guarantee that readers stop seeing expired data if it runs late or fails. Applying a new policy to a populated table must not silently bulk-delete rows.

## Decision

`Schema.spec.ttl` names one top-level date-time field and a nonnegative `expireAfterSeconds`. At `timestamp + duration <= now`, semantic reads exclude the row. Missing, null and unparseable legacy dates never expire. Declarative Views include the same predicate. Native SQL Views are rejected while any TTL Schema exists, and shared caching of a TTL View is rejected. The compiled plan and introspection expose the policy. Public Cloudflare pages derived from TTL collections use `no-store` rather than shared caching.

SQLite storage implements an optional bounded `ExpirySweeper`. A sweep previews by default; `delete: true` is required for physical removal. It returns counts and a cursor, selects at most 100 expired IDs in stable order, and rechecks expiry in one bounded delete statement. A failed page can be retried with the previous cursor. Ref Procedures can call the semantic capability, including from a scheduled Trigger. No host automatically invokes it.

Physical TTL removal does not fire before/after entry lifecycle hooks. Expiry already changed logical visibility; cleanup reclaims storage rather than representing an editorial deletion. Consumers needing business actions at expiry must implement them in an idempotent scheduled Procedure before calling the sweep.

## Consequences

Adding or shortening TTL changes read visibility immediately but never starts physical deletion. Owners preview counts and choose when to sweep; expired rows can still occupy unique indexes until removal. Other adapters must implement equivalent read filtering and a sweep or fail closed for TTL plans. The runtime does not promise an exact deletion time.

## Alternatives

Scheduler-driven deletion alone leaves a visibility gap. Implicit migration-time cleanup risks irreversible bulk deletion. Firing ordinary deletion hooks during storage reclamation would cause delayed, retry-sensitive business effects after the row was already logically gone.

## How to apply

Declare `ttl` on a Schema, use declarative Views, preview with `runtime.sweepExpired`, then explicitly request deletion page by page. See [Schema TTL](../handbook/reference/schema.md#ttl).

## Implementation status

Implemented in the 0.1.5 TTL PR for the SQLite family, with Bun and local D1 conformance checks.
