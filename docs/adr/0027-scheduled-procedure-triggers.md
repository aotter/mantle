# ADR-0027: Scheduled Procedure Triggers

**Status:** Accepted for 0.1.5 (#1087). Revises the closed Trigger-source grammar from ADR-0001 and the host-only cron guidance of #322. Cron dialect and host requirement amended by [ADR-0032](0032-store-centric-core-and-service-contract.md). Superseded for 0.2.0 by the native Core handbook (#1566); see the amendment below.

> **Amended 2026-10-19.** No ADR records the 0.2.0 decision; the 0.2.0 native
> Core handbook (#1566) superseded this one. Mantle is no longer the schedule
> host: `mantle generate` rejects every `schedule` Trigger source, including
> disabled ones, and every `lifecycle` source with `GENERATE_UNSUPPORTED`, so
> no generated plan carries a schedule. Scheduling is application-owned: the app
> exports `scheduled()`, lists its crons in Wrangler `triggers.crons`, and calls
> generated Procedures directly as the system caller; TTL maintenance calls the
> generated `<schema>.sweepExpired`. ADR-0032's `invokeSchedule` and
> `schedules: true` are withdrawn with it. The body below is historical. See
> [Trigger reference](../handbook/reference/trigger.md),
> [features](../handbook/reference/features.md#refused) and
> [TTL maintenance](../handbook/guides/native-execution.md#ttl-maintenance).

**Date:** 2026-09-25

## Context

The earlier contract kept cron outside the Manifest graph. That forced an application Worker to invoke a Procedure by name with its own caller context, leaving scheduling invisible to validation and the compiled plan. A portable declaration is needed without pretending that every host can register a cron event.

## Decision

`Trigger.spec.source` gains `kind: schedule`, a five-field Cloudflare UTC `cron` (weekday 1=Sunday), and optional `enabled` (default true). It targets one Procedure whose input accepts `{}` and requires no user or staff authorization. The compiled plan carries Trigger identity, expression, target, enabled state, and the required `cloudflare` host. No HTTP route or user identity is granted.

Cloudflare's `scheduled` entry finds enabled plan entries with the exact incoming expression and invokes them in Trigger-name order through the existing Procedure pipeline, continuing after individual failures and reporting them together. The system context has null user and staff, no credential, and `ctx.schedule` with stable `${trigger}:${scheduledTime}` identity. The application registers exact expressions with Wrangler. Cloudflare Cron Triggers do not document automatic retries; handlers still use the identity for possible duplicate/manual replay. Other hosts reject enabled schedules rather than silently omit them.

## Consequences

The grammar and sealed plan version advance. Applications must rerun `mantle generate` after upgrading. A Procedure needing staff authorization cannot run from a schedule. Cron provisioning, retries, retention and exactly-once execution remain host/operator responsibilities; the runtime does not claim them.

## Alternatives

Keeping host-only calls would preserve the old grammar but fail static validation and omit the feature from introspection. A general background-job framework would add storage and scheduling responsibilities without a second host implementation.

## How to apply

Declare a schedule Trigger, export `worker.scheduled`, and register its expression in `wrangler.jsonc`. Use `ctx.schedule.id` to deduplicate writes. See [Trigger reference](../handbook/reference/trigger.md#schedule).

## Implementation status

Implemented in the 0.1.5 scheduled Procedure PR, with parser, linker, compiler, runtime and Cloudflare adapter tests.
