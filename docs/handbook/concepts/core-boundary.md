---
description: What Mantle Core does and what the application owns, the tests a request must pass to belong in Core, what Core has decided not to do and the pattern to use instead, and how to ask for a missing extension point.
---
# What Core does, and what it does not

Read this before proposing a change to Core, or when a manifest cannot say what you need. Most things that look like a
missing Core feature are the application's to do, with a documented pattern.

## Who owns what

**Core** compiles manifests (Schemas, Views, Procedures, Triggers) into native SQL and typed TypeScript for four
targets, enforces row policy where it compiles SQL (scope, `restrict`, publishing, TTL, locks, optimistic versions),
and keeps the manifest grammar closed: a key or value it does not know is an error, never ignored
([CONTRIBUTING](https://github.com/aotter/mantle/blob/v0.2.2/CONTRIBUTING.md#product-and-architecture-contract),
ADR-0045, ADR-0002).

**The application** owns its entry and routing, its auth configuration and how it resolves a Caller, its database
handles, **schema migrations**, scheduling, and side effects such as email, payments and calls to other services. The
runtime runs no DDL and no boot-time checks; generated modules do nothing on import (CONTRIBUTING, hard invariants;
ADR-lite #2108, ADR-lite #2111).

## Does it belong in Core?

A request belongs in Core only when it passes all four:

1. **It must be enforced where SQL is compiled, or it is a closed value the generator must know.** A rule application
   code can state once (in `authorize`, a `ref` handler, a route or a hook) stays there.
2. **It adds no Core-owned storage and no runtime DDL.** Core owns no tables of its own beyond what `schema.sql`
   declares from your manifests, and never changes a database at runtime.
3. **It does not couple Core to one auth plugin's tables, and it works for an application behind a gateway,** which
   has no auth tables and whose host verifies the caller
   (ADR-0046).
4. **There is evidence from real application code:** a workaround in an application, marked
   `drop when aotter/mantle#N`, ideally in more than one application. A hypothetical need is not evidence.

## What Core does not do, and what to do instead

Each of these was asked for and decided. Use the pattern; reopen only with the evidence the decision names.

| Asked for | Do instead | Decision |
| --- | --- | --- |
| Schema migrations: a diff command, an apply helper, a ledger | Diff `generated/schema.sql` and write the migration yourself: [schema migrations](../guides/migrations.md#write-a-migration); apply it with your own tooling ([applying migrations](../guides/migrations.md#applying-migrations)) | ADR-lite #2108 |
| Schedules in the manifest, `schedule` Trigger sources, a generated cron dispatcher | One checked map from cron to generated Procedures in your `scheduled()`: [scheduled work](../cloudflare/deploy-and-operate.md#scheduled-work) | ADR-lite #2111, ADR-0027 |
| Views over an auth plugin's tables (organization members, invitations) | Carry memberships as verified user fields; for a listing, keep your own declared Schema scoped by that field: [organization members and invitations](../reference/authorization.md#organization-members-and-invitations) | ADR-0046, #2106 |
| Caller conditions in `requires` (email verified, not impersonating, recent sign-in), `requires.guard` | `authorize(target, caller)`: [caller conditions](../reference/authorization.md#caller-conditions) | ADR-0002, ADR-lite #1937, #2107 |
| Idempotency keys and rate-limit or counter tables in Core | The row is the replay record: [retry safely](../guides/sql-patterns.md#retry-safely-the-row-is-the-replay-record); quotas in the Procedure, refused with 429 from a handler: [per-caller quotas](../guides/sql-patterns.md#per-caller-quotas-a-handler-answers-429); request rates at the platform, in the application's route: [limits and authorize](../reference/authorization.md#limits-and-authorize) | #2109 |
| A globally unique index on a scoped Schema | An unscoped registry Schema written by the same Procedure: [a value unique across all owners](../reference/schema.md#a-value-unique-across-all-owners) | ADR-0046, #2110 |
| A membership predicate that reads plugin tables (`auth.memberOf()`) | Carry memberships and roles as verified user fields and use them in `scope` or `restrict`, where `restrict` joins terms with `AND` and `OR` ("its creator or an owner of its organization"): [user fields](../reference/authorization.md#user-fields) | ADR-0046, #2105 |
| Mounting an application's own MCP server behind Mantle's gate | Hand-built tools and `ref` handlers return content blocks and `_meta` with `withResult`: [tool metadata and result `_meta`](../guides/mcp-apps.md#tool-metadata-and-result-_meta) | #1843 |
| Built-in content revisions | A publishing parent that points at operational revisions: [edit published content without downtime](../guides/revisions.md) | #1205 |
| Per-target role lists in `requires` (`{ ctx.admin: [editor] }`) | Decide per-target roles in `authorize` or a handler: [authorization](../reference/authorization.md) | ADR-0046 |
| A wrapper around Better Auth, or Core-owned sign-in | Write `auth.ts` and resolve the Caller yourself: [authentication](../cloudflare/authentication.md) | CONTRIBUTING, hard invariants |
| A generated website or service preset | Write the entry and routes; generated surfaces mount into them: [service entry](../cloudflare/service-entry.md) | CONTRIBUTING, ADR-0045 |

## When something really is missing

File an "Extension point request" (the issue template of that name) with:

- **The application code that works around it today**, reduced to what shows which Core behaviour it depends on, and
  marked in the application with `drop when aotter/mantle#N`.
- **Why the patterns above do not fit**: the row of the table you checked, and what it cannot express for you.
- **Which of the four tests it passes**, and where else the same need appeared.

What Core opens is the smallest seam that removes the workaround: an option, a hook, a closed value, a passed-through
field. Not a subsystem: no tables, no runtime DDL, no new lifecycle. Repeated requests for one need decide its design
([CONTRIBUTING](https://github.com/aotter/mantle/blob/v0.2.2/CONTRIBUTING.md#product-and-architecture-contract)).
