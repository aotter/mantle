---
description: Index of the Mantle 0.2.0 examples — whole services in the v2 grammar, each compiled by mantle generate, and the runnable reference service.
---
# Examples

Each example is a whole service whose manifests compile with `mantle generate`;
its handlers are written against the generated types. They live beside this
handbook in [`docs/examples/`](../../examples/README.md).

| Example | Shows |
|---|---|
| [Reference service](../../examples/reference-service/README.md) | a runnable service with its smoke test: scope, SQL Views and Procedures, hooks, a cron, REST, both MCP surfaces, Admin's API and sign-in |
| [Intake form](../../examples/intake.md) | an anonymous form: one SQL `INSERT` and a staff View |
| [Intake with bot check and notification](../../examples/intake-hooks.md) | a guard and an after hook |
| [Reservation requests](../../examples/reservation.md) | a request queue with a `check` |
| [Publication](../../examples/publication.md) | localized posts, per-locale Views and `mantle.search` |
| [Legal documents and consent](../../examples/legal-documents.md) | immutable revisions and a conditional insert |
| [Procurement approvals](../../examples/procurement.md) | own rows through `auth.uid()`, a locked staff review |
| [Commerce catalog and orders](../../examples/commerce.md) | a published catalog and guest orders |
| [Commerce inventory](../../examples/commerce-inventory.md) | atomic stock reservation, a scheduled expiry, a verified payment callback |
| [Guarded API access](../../examples/guarded-api.md) | API keys, scopes and an entitlement guard |
