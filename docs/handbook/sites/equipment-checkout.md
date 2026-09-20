---
description: "Design a non-payment equipment checkout workflow with Mantle custom handlers, Sites identity and storage, and external Slack notifications."
---
# Equipment checkout and external notifications

**Turn a ChatGPT Site into an operational tool, with a Mantle-managed back
office and application-owned business rules.**

A production crew, school media room, or shared studio needs to know who has
each camera kit, who approved the loan, and when it should come back. A form
alone cannot prevent two people reserving the last kit. A notification alone
cannot enforce who may approve or return it.

This guide describes a non-payment application of the Sites integration:
members request equipment, staff approve and record handover, and a custom
handler notifies an equipment desk in Slack. There are no prices, deposits,
checkout charges, invoices, or payment-provider credentials.

**Status: implementation guide, not a shipped equipment app.** Start from the
[runnable article host reference](../../examples/host-chatgpt-sites/README.md).
That reference does not include these manifests, loan handlers, or a Slack
integration. The [verification boundary](#verification-boundary) distinguishes
the earlier deployment experiment from this proposed application.

## A useful first workflow

1. A member signs in with ChatGPT and requests a camera kit for tomorrow
   afternoon. The server derives the borrower from the verified identity, not
   a submitted user ID.
2. An owner or editor reviews the request in Mantle Admin. Approval claims the
   kit for that time slot only if it is still available. A pending request does
   not promise availability.
3. The approval commits, then the application attempts a Slack notification to
   the equipment desk. The message identifies the request and links to the
   authenticated Admin page; it contains no borrower email or private notes.
4. Staff record pickup and return. A return records condition and releases the
   current checkout once. A damaged unit becomes unavailable for new claims.
5. Staff can inspect pending requests, reservations, checked-out equipment,
   overdue returns, and notification failures in Admin Views.

Keep the first implementation bounded: identify individual kits, allow one kit
and one fixed half-day slot per request, and define slots in the team's chosen
time zone before storing UTC bounds. Multi-kit carts, arbitrary overlapping
intervals, recurring bookings and automated reminders are separate extensions.
An overdue checkout blocks physical handover to the next borrower even when a
future reservation exists; time passing is not evidence of a physical return.

## What Mantle owns, and what your application owns

| Surface | Contract |
|---|---|
| Equipment catalog | An `equipment` Schema with title, description and an R2 media asset reference. Use the runtime's content use cases for authoring. |
| Operational state | Application-owned D1 loan, unit-availability, reservation-claim and notification tables with reviewed migrations. Do not write Mantle-owned Schema tables directly. |
| Staff reports | Staff-only SQL Views over the application tables. SQL Views are specific to SQLite/D1, not a portable storage guarantee. |
| Business operations | Typed Procedures with `handler: { kind: ref, ref: ... }` for request, approval, rejection, pickup, return, cancellation and notification retry. |
| Staff controls | Explicit staff MCP Triggers expose appropriate Procedures to Admin operations/WebMCP; `requires.auth` checks owner/editor roles on every invocation. This does not mount remote staff OAuth MCP. |
| Member pages | Application routes show only the current member's requests and call the same runtime Procedure pipeline for mutations. |
| External integration | Application handler code calls a configured Slack incoming webhook with server-side credentials. Core needs no Slack-specific port or manifest kind. |

Keep approval, custody and delivery status separate. For example, a loan may
be `requested`, `approved`, `checked_out`, `returned`, `rejected` or `cancelled`,
while its notification is `pending`, `sent`, `failed`, `unknown` or
`not_configured`. A Slack failure must not turn an approved loan into a rejected
one. Do not expose generic CRUD for operational state transitions.

If you choose Mantle operational Schemas for query mirrors instead, declare
root `schema.readOnly: true`, maintain them through runtime use cases, and
define reconciliation with the authoritative reservation state. Do not add a
second writable authority just to obtain a sidebar entry; staff Views are
enough for the first implementation.

## Connect the custom handlers

Follow the existing [Procedure contract](../reference/procedure.md) and
[low-level host composition](../cloudflare/low-level-composition.md):

1. Author each Procedure's strict input/output schema and authorization
   requirements. For example, `approve-loan` accepts a request ID and operation
   ID, requires an owner/editor, and names `approveLoan` as its handler ref.
   Resolve the kit, borrower, slot and current state from stored data.
2. Run `mantle generate`. Implement the resulting `MantleHandlers<Env>` map and
   pass it as `handlers` to `bootMantleRuntime` alongside the sealed plan,
   existing storage adapter and media port. A ref is a registration key, not a
   file path or automatic route.
3. Mount member routes in the application. Bound and validate request bodies,
   require the existing Sites session, check exact same-origin on browser
   writes, and construct the runtime context from verified identity. Never
   accept caller-supplied `staff`, role or borrower identity.
4. Invoke `bindMantle(runtime).procedures.<generatedName>(input, ctx)` and handle
   its success/diagnostic result. Do not call the handler function directly.
   A host-mounted route is an explicit entry point; the Procedure alone does
   not install it. A manifest HTTP Trigger likewise needs the host's matching
   transport mounting.
5. Expose only staff-appropriate operations through staff Triggers. Keep member
   ownership checks inside handlers too: a role check alone does not prove
   that the current member owns the request being cancelled or read.

See [Procedures and Triggers](../concepts/procedures-and-triggers.md) for
declarative transport binding. The Sites host still owns its router, auth and
external service configuration; Mantle owns validation, authorization and
dispatch through the sealed plan.

## Make reservations safe under retries and concurrency

Application storage must make approval and the claim for `(unitId, slotId)`
atomic. Use a database uniqueness constraint for the claim, not a browser
availability check followed by an unconditional write. When approval involves
several application-table statements, use a supported atomic D1 batch and
verify rollback on a conflicting claim. A conflict must not leave an approved
loan without its claim or a claim without its loan.

Bind every operation ID to its actor and complete business input. Replaying the
same input returns the prior result; reusing the ID for different input fails.
Guard transitions against the current state: repeated approval does not claim
twice, cancellation cannot silently undo checked-out equipment, and repeated
return cannot increase availability twice. Releasing a claim and changing loan
state must also commit atomically. Persist the audit record rather than deleting
the loan to make inventory appear available.

Re-check unit serviceability at approval and pickup. A catalog entry is
descriptive content, not the authoritative physical stock counter. Staff may
edit descriptions through Mantle without bypassing the reservation rules.

Do not infer this correctness from the catalog's CRUD tests. Include concurrent
approval, rollback and late-return scenarios in the application's own tests.
The earlier single-SKU stock experiment does not validate future time-slot
reservations.

## Call an external API without coupling it to approval

Start with a single administrator-configured Slack incoming webhook. An owner
chooses the destination channel and stores `SLACK_WEBHOOK_URL` as a Sites runtime
secret. It is not a manifest field, browser variable, member-supplied URL or
committed setting. Keep the URL and provider response details out of logs and
public diagnostics. Validate the configured HTTPS destination and do not follow
redirects to arbitrary hosts.

Slack accepts a server-side JSON POST. See its
[incoming webhook guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
for setup, response semantics and errors. The first integration sends a short
notification, not interactive Slack approval buttons. Those buttons would need
a separate authenticated callback design and a mapping to Mantle staff identity.

Commit a durable notification record in the **same application-owned D1
transaction** as approval, then attempt delivery with a bounded timeout. Claim
the record before sending so concurrent retries do not both send it. Record a
successful acknowledgement separately from the business result; an accepted
message does not prove a human read it.

Missing configuration is `not_configured`, not success. Definite provider
rejection is `failed`; a timeout or crash after sending may mean delivery is
`unknown`. Show these states and a staff-only retry action in Admin, including
recovery for an abandoned delivery claim. Retrying an unknown attempt may post
a duplicate: include the same notification ID and do not promise exactly-once
delivery. Never roll back the reservation because Slack is unavailable.

The first version attempts delivery after commit in the current request and
uses **manual staff retry**, not an assumed background scheduler. Sites Queue,
Durable Object and Cron support remains unverified here; `waitUntil` is not
durable delivery. Automated reminders require a separately verified host
capability, not a timer left running in a Worker.

## Verification boundary

The earlier deployed integration experiment established these narrower facts:

- Mantle custom handlers performed server-priced, idempotent single-SKU stock
  operations on application-owned D1 tables, alongside the existing Admin/R2
  content flow. Local regression tests covered concurrent oversell and replay.
- A browser form reached an external provider's **sandbox**, and its signed
  server callback reached the published Site and updated a test record through
  the runtime Procedure pipeline. This was not a Worker-originated Slack call.
- A migration containing SQLite triggers passed local D1 but failed Sites
  deployment with `incomplete input: SQLITE_ERROR`. A trigger-free conditional
  SQL/ledger version deployed successfully. This is a deployment observation,
  not proof that all Sites deployments prohibit SQLite triggers.

The experiment is engineering evidence, **not a payment feature to adopt**.
[Sites' documented unsupported uses](https://learn.chatgpt.com/docs/sites#understand-limits-and-unsupported-uses)
include enabling financial transactions. Do not copy payment routes, merchant
credentials or payment terminology into this example, or infer permission for
live payments from successful sandbox transport.

Equipment reservations, Worker-to-Slack HTTPS delivery and its failure recovery
remain implementation and deployed acceptance work. They are not tested merely
because the underlying host composition or a different provider succeeded.

## Acceptance checklist for your application

- Preserve existing Site identity, audience, content and R2 objects. Follow the
  [host reference](./host-reference.md) and its supported SDK installation path.
- Review additive migrations and the Mantle storage fingerprint; leave applied
  migrations immutable. Test the actual Sites deploy, not only local D1.
- Verify member ownership, staff role revocation and cross-origin rejection.
  Keep borrower records out of public Views, public MCP and static artifacts.
- Race two approvals for one unit/slot: exactly one succeeds. Verify a failed
  batch leaves no partial approval, claim or notification record.
- Replay approve/cancel/return operations, including changed-input retries.
  Check damaged units, overdue handover, and slot/time-zone boundaries.
- With the secret absent, show `not_configured`. With the configured test
  channel, verify one actual deployed Worker-to-Slack notification and the
  matching delivery record. Test rejection, timeout, abandoned claim and manual
  retry without changing the loan's approved state.
- Walk through Admin's typed forms, staff Views and row operations with a real
  second account. Browser WebMCP success is not remote OAuth MCP success.

## Ask your agent to build it

```text
Extend my existing ChatGPT Site with Mantle equipment checkout. Read the matching
SDK's docs/handbook/sites/index.md, equipment-checkout.md and host-reference.md.
Preserve current content, audience and R2 media. This guide is a design, not an
installed app: implement and test the missing manifests, handlers and routes.
Start with one identified kit and one fixed half-day slot per request. Include
member-owned requests, staff approval/pickup/return, atomic reservation claims,
typed Admin operations, staff reports and an audit trail. Use a server-side
Slack webhook secret for minimal notifications, with durable delivery records
and manual retry. If no secret is configured, report that honestly. Do not
implement payments, remote staff OAuth, or assume DO/Queue/Cron availability.
Run the acceptance checklist and distinguish local, deployed and untested cases.
```

## Source

- [Sites integration](./index.md) and [host reference](./host-reference.md)
- [Runnable article host](../../examples/host-chatgpt-sites/README.md)
- [Procedure reference](../reference/procedure.md) and [authorization](../concepts/authorization.md)
- [Sealed runtime ownership](../../adr/0019-sealed-manifest-runtime-pipeline.md)
- [Schema storage and migrations](../../adr/0024-manifest-native-schema-tables.md)
- [Slack incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
- [OpenAI Sites](https://learn.chatgpt.com/docs/sites)
