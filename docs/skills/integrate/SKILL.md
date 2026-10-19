---
name: integrate
description: Add Mantle 0.2 to an existing application, or rebuild one on Mantle and migrate its data. Use when the application already has its own code, routes, users, storage or deployment.
metadata:
  source: "@aotter/mantle"
  sourcePath: docs/skills/integrate/SKILL.md
  applies_to: mantle 0.2
  projection: package
---

# Integrate Mantle into an existing application

## Workflow

Read the installed SDK README, then follow the version-matched [project and CLI
workflow](../../handbook/start/project-and-cli.md) before editing.

Keep the application router, database/pool, identity and frontend. Replace
Core consumers explicitly and compose only selected generated entries. Resolve
one Caller per request with the shared cookie-session origin check. Rehearse
data-preserving schema/auth/role migrations on a copy and retain rollback artifacts.
Initial schema.sql is for an empty database, not an in-place upgrade. Requests run
no DDL or storage checks; the only request-time write outside app operations is
the configured OAuth resource row (see [OAuth](../../handbook/guides/oauth.md)).
Verify cutover with actual app tests.

Preserve the app router, verified identity and native resources. For selected
Admin, follow the [native guide](../../handbook/guides/native-admin.md) for its
application-built bundle and service composition.
Do not import old `/spec`, `/core` or runtime surface APIs. Review data/role
migrations explicitly; full cross-target int64 parity and automated transfer
are not this release's upgrade contract.

## Partial adoption in TypeScript/Node

Keep the app's router, pool/handle, identity and frontend. Declare only the Schemas and operations being adopted; import selected `views/<encoded-name>.ts` or `procedures/<encoded-name>.ts`, then call `(appHandle, verifiedCaller, validatedInput)`. Bun.SQL and postgres.js fit directly; [node-postgres can adapt](../../handbook/guides/postgres-adapters.md). No Admin/auth/surface module is required for direct queries.

Existing tables need explicit migration into the declared storage shape, including system columns and constraints. Initial schema.sql must not be applied over an occupied database. Rehearse on a copy and test scope, TTL, publication, OCC and persisted state with the app's own identity.

Writes use Store or declared Procedures; never raw SQL writes to adopted collections. Use internal Views for joins, aggregates, OR and reusable reads. Store findById/find/first remain useful for simple AND lookups in existing handlers.

Direct declared Schema-column outputs in Views and SQL Procedure `RETURNING`
keep their authored field names; explicit aliases keep SQL casing rules. Store
rows and nested SQL relations use storage names. Boundary validators support a
permissive `format: email` check (one `@`, non-empty parts, no whitespace). For
LEFT JOIN paging, join on the joined Schema's id or single-field unique key and
keep the base indexed, non-null order/id tuple. Generation always emits `Handlers`
(empty without ref Procedures); pass `handlers` at `adminBindings()`, generated REST/MCP options and
`webmcpRoutes(catalogue, tools, handlers)`, as the app shell does.
