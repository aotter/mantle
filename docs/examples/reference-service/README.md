# Reference service

A directly authored shop using the single `@aotter/mantle` native SDK and the
`@aotter/mantle-admin` server/SPA and the pure `@aotter/mantle-ui` kit. The release gate runs this service from
exact packed tarballs (`scripts/check-worker-consumer.mjs`).

- `manifests/`: scoped orders, a stock CHECK, joins, grouping, native full-text
  search, atomic SQL Procedures, typed ref Procedures, REST and MCP exposure.
- `src/auth.ts`: app-owned Better Auth options and verified-email admin bootstrap;
  Better Auth loads dynamically, and local-only email OTPs print to the log.
- `src/handlers.ts`: scoped cancellation and stock restoration in one native
  batch. Order activity runs after commit with the actual caller, best effort,
  preserving the old after-hook semantics. Generated lifecycle Triggers are
  refused; this effect also covers the app's Admin entry writers.
- `src/pages.ts`: app-owned keysets for relevance and aggregate ordering outside
  the generator's automatic paging proofs. SQL applies cursors and LIMIT; the
  application does not read all rows and then paginate them.
- `src/service.ts` and `src/index.ts`: app-mounted auth, Admin, REST and both MCP
  surfaces, lazy MCP App HTML, and a bounded native weekly digest (20 pages).
  Scheduling belongs to the app, rather than a manifest schedule Trigger.
- `smoke.mjs`: explicitly applies deployment DDL to a fresh local D1, starts
  Wrangler, and exercises OTP, both user roles, REST, both MCP surfaces, Admin
  assets/editor save, search, scope, stock rollback, locks, activity and cron;
  real PKCE consent, offline refresh after sign-out, rotation retry and revocation.

The MCP provider permits `mcp` and `offline_access`; a renewable client must
explicitly request both and obtain the user's consent. A client requesting only
`mcp` receives no refresh token. Existing scope-limited connections need refreshed
client metadata and one reauthorization with the added scope; changing the
server's allowed scopes does not broaden stored consent. See the installed
OAuth guide for grant lifetimes and migration.

Outside the SDK workspace, use Node 22.22+ and pnpm 9+; pin all three packages to
one exact version. Then:

```sh
pnpm install
pnpm generate                   # lists required Handlers keys
pnpm types                      # regenerates Wrangler environment types
pnpm exec tsc --noEmit           # implement listed handlers, then typecheck again
pnpm check                      # generation/check, typecheck, real local D1 smoke
cp .dev.vars.example .dev.vars  # set ADMIN_EMAIL and a random BETTER_AUTH_SECRET
pnpm exec wrangler d1 execute mantle-reference --local --file generated/schema.sql
pnpm dev                        # /admin; local OTP codes appear in this log
```

Apply initial DDL only to an empty development database. Production migrations
are reviewed application-owned artifacts; imports and requests do no schema
convergence. Configure a real email sender before deployment. `ADMIN_EMAIL`
receives the OSS `admin` role only after email verification; ordinary members
receive 403 from Admin.

This reference is source-only: commit manifests, focused implementations,
configuration and executable checks. Keep `generated/`, `worker-configuration.d.ts` and `dist/` untracked;
regenerate them with the selected SDK rather than hand-editing outputs.
`pnpm check` regenerates SDK output and Wrangler types, checks them, then typechecks and
runs the real local service smoke. Run `pnpm generate` and `pnpm types` before direct typecheck,
build or browser-test commands in a fresh checkout. Initial database DDL also
comes from that generated output; reviewed production migrations remain authored
source. The release gate archives only committed source and installs exact
Core/Admin/UI tarballs, so it cannot reuse a checked-in generated baseline or
workspace links. Follow the installed SDK README and native contract, not historical
plan-based `createMantle` instructions. Bare integers retain their driver's native
contract; the selected surfaces own wire conversions.

## Design tools around a business outcome

An end-user agent should be able to complete “find tea, place an order, inspect
it, then cancel it” using only `tools/list` and tool results. In this example:

1. `search_items({ q, limit })` locates a backend item ID without scanning the
   entire catalog. Follow `nextCursor` only when more results are needed.
2. `place_order({ itemId, qty })` returns the created order in the first row of the
   first statement, `results[0][0]`, including its ID, item relation, state and observed version.
3. `get_order({ orderId })` reads one owned order, its related item and version.
   Empty `rows` means absent or inaccessible, including another buyer's order.
4. `cancel_order({ orderId, expectedVersion })` changes a placed order and
   restores stock in one database batch. Read the detail again to verify the
   final state. The version must be the snapshot the user reviewed.

A stale version is a conflict, not permission to silently refresh and retry.
Cancellation already performed is also a conflict. `place_order` has no
idempotency-key contract: two successful identical calls create two orders.
After a timeout or interrupted write, reconcile using `my_orders`/`get_order`
before deciding what to do. No multi-call transaction exists. Each order/stock
write is atomic; an invalid item produces `CONFLICT` without an order, and an
insufficient stock check rolls the complete order back. Optional activity is
post-commit and best effort; its failure never retries a committed purchase.

Descriptions explain these decisions to the model. They are guidance; server
validation, owner scope and OCC enforce them. Do not provide generic delete
permissions just to clean up tests. `smoke.mjs` creates a disposable local D1,
uses real MCP requests and removes the entire local fixture in `finally`.

## Independently accept the workflow

Follow the [independent acceptance rounds](../../handbook/guides/agent-workflow-acceptance.md).
Give each buyer agent this brief and the authorized transport, never the worked
sequence above: "a buyer shopping a small tea catalogue within a stated budget,
who may need to cancel an order". Keep this result separate from `smoke.mjs`,
host rendering and the author's stock/privacy regressions.

## Read data first; render an App deliberately

`sales_by_item` is a bounded data tool. It does not open an iframe, so an agent
can query pages and reason without producing a new App for each query.
`render_sales_report` is a separate, read-only final query for a user who wants
interactive inspection. It accepts the same paging arguments, invokes the same
reader, and alone owns the Admin App resource through explicit `renders`.
The renderer reads current authorized data; it is not a frozen snapshot or a
write confirmation. App interactions can keep using the ordinary data tools.

Both tools preserve structured data and text results for hosts without Apps.
Neither tool descriptions nor structured results force a particular ChatGPT
generative UI layout. An AppBridge replay passing does not prove that the iOS
ChatGPT app renders successfully. Run a real host acceptance test separately,
record client/version and observed behavior, and retain text results as fallback.

The smoke covers data/render metadata separation, resource loading, equivalent
bounded results and authorization, plus business flows with owner isolation,
invalid relations, stale versions, explicit repeat-call behavior and readback.
This is an application/reference design choice using the existing SDK hooks
(ADR-0029), not a new manifest grammar or runtime rendering guarantee.

After changing a server's tools or descriptions, an existing host connection
may still hold an older catalog snapshot. Use the host's normal metadata
refresh/review flow and confirm that it lists the new renderer before testing
it. A fresh protocol `tools/list` passing does not establish that an existing
ChatGPT/iOS connection adopted the updated catalog; record that separately in
manual host acceptance.


## Use Store for simple writes; retain atomic SQL for business conditions

Admin MCP `create_item` inserts one catalog item with stock fixed at zero;
`priceCents` is minor currency units and omitted/null means unknown.
`rename_item` only patches its required non-null name, preserving SKU, price
and stock. Both are declared admin-only ref Procedures backed by caller-bound
Store writes. They return an explicit safe snapshot with the backend ID and
actual returned version; generated validation and Procedure `requires` remain
in force. No row spread, version echo or generic receipt wrapper is involved.

The smoke verifies receipts against stored state, duplicate-SKU refusal,
nonzero-stock/price preservation, null/extra-field refusal, stale versions and
two concurrent renames using one reviewed version (one succeeds, one conflicts).
It also checks member/anonymous denial. Initial DDL is unchanged.

Order placement and stock decrement, cancellation, and additive restock retain
their existing native atomic boundaries. A TypeScript pre-read/write pair must
not replace the SQL stock CHECK/conditional write. D1 cannot run an interactive
transaction callback or feed a prior batch result into a later step. See the
[Store guide](../../handbook/guides/typed-queries.md#prefer-store-backed-ref-procedures-for-simple-writes).
