# Examples hub

Every page is a whole service in the 0.2.0 grammar: its manifests compile with
`mantle generate` (the SDK repository compiles each one in its checks). Copy the shape you need into
your project's `manifests/`; none is a template to copy wholesale.

| Example | What it shows | Handler code |
|---|---|---|
| [`reference-service/`](./reference-service/README.md) | A runnable service with its smoke test: scoped orders, SQL Views and Procedures, hooks, a cron, REST, both MCP surfaces, Admin's API and console email-OTP sign-in. The release gate runs it. | yes |
| [Intake form](./intake.md) | An anonymous form: one SQL `INSERT` and a staff View. | none |
| [Intake with bot check and notification](./intake-hooks.md) | A Turnstile check as the Procedure's guard, an email from an after hook. | 2 handlers |
| [Reservation requests](./reservation.md) | A request queue with a Schema `check`. | none |
| [Publication](./publication.md) | Localized posts with a parent identity, per-locale lists and `mantle.search`. | none |
| [Legal documents and consent](./legal-documents.md) | Immutable revisions, and an acceptance written only for a published revision. | none |
| [Procurement approvals](./procurement.md) | Members see their own rows through `auth.uid()`; staff review with an optimistic lock. | none |
| [Commerce catalog and orders](./commerce.md) | A published catalog, guest orders and a locked staff review. | none |
| [Commerce inventory](./commerce-inventory.md) | Server-side pricing, atomic stock reservation with `checks` and locks, a scheduled expiry and a verified payment callback. | 3 handlers |
| [Guarded API access](./guarded-api.md) | API keys through a custom `CallerResolver`, scopes and a live entitlement guard. | 2 handlers |

Projects on 0.1.x move with [the upgrade guide](../upgrade-0.1-to-0.2.md).
