# Purchasing

An internal purchase-request workflow. Any signed-in employee submits a request against a department budget. An admin
approves or rejects it, in Admin or through an AI agent on the admin MCP endpoint. Approval spends the budget and writes a
ledger row in one transaction. The app then orders from the supplier's API and waits for the supplier's signed callback
to mark the request confirmed. Requesters get an email on each decision, and a daily cron emails admins about requests
that have been waiting too long.

## Capabilities shown

- **Status workflow with guarded transitions**: the write Procedures use
  `UPDATE requests SET requestStatus = 'approved' ... WHERE id = input.id AND requestStatus = 'submitted'`. A match on
  0 rows is a `CONFLICT` (409). See `manifests/purchasing.yaml` (`approve-request-write`, `reject-request-write`,
  `mark-ordered`, `confirm-order`). The column is `requestStatus` because `status` is reserved for publishing Schemas.
- **Admin-only operations**: `approve-request` and `reject-request` declare `requires: ctx.admin` and a `target`, so
  Admin shows them as operations on a request. Their `kind: mcp, surface: admin` Triggers make them
  `approve_request` / `reject_request` tools on `/mcp/admin`. They are not listed on `/mcp`.
- **Optimistic concurrency**: clients send `expectedVersion`, and the SQL matches `version = input.expectedVersion`.
  When two admins approve the same version, one succeeds and the other gets a 409.
- **Several writes in one transaction**: `approve-request-write` runs three statements as one program: the status
  change, `UPDATE budgets SET remaining = remaining - ...` and `INSERT INTO ledger`. If the request would overspend,
  `checks: ["remaining >= 0"]` on `budgets` rolls back all three. `src/handlers.ts` turns that failure into a 409.
- **External API + signed callback**: after the transaction commits, `src/handlers.ts` POSTs the order to
  `env.SUPPLIER_API_URL` (sending the request id as the idempotency key) and then sets the request to `ordered`.
  `src/routes.ts` serves `POST /callbacks/supplier`. It first checks an HMAC-SHA256 of the timestamp and the **raw**
  body with `env.SUPPLIER_WEBHOOK_SECRET`, and only then parses the JSON. It then calls the generated `confirm-order`
  Procedure as a `system` caller. No Trigger exposes that Procedure.
- **Email + cron as app code**: `src/notify.ts` sends through an `EmailSender` from `@aotter/mantle/email`
  (`ConsoleEmailSender` locally). `src/schedule.ts` uses `toCloudflareCron`, and its cron is listed in
  `wrangler.jsonc`. The reminder reads the internal View `stale-requests`.
- Employees see only their own requests through `my-requests` (`restrict: { requests: "author_id = auth.uid()" }`).

Search for `AGENT:` to find what a real app must still provide: an email sender, the supplier's real API and signature
scheme, and a retry for orders that failed to place.

## Combine with

- Need members to own rows, prevent duplicates or cap capacity? Add club-events' `uniqueIndexes` and capacity `checks`.
- Need public pages, SEO or media for the approved items? Add recipes' publishing lifecycle and visitor pages.
- Need another approval flow? Copy the pattern: a ref Procedure (admin-only, side effects) that wraps a guarded SQL
  write Procedure (one transaction).

## Copy

```sh
cp -R node_modules/@aotter/mantle/docs/examples/app-shell/. my-app/
cp -R node_modules/@aotter/mantle/docs/examples/purchasing/. my-app/
cd my-app && pnpm install && pnpm generate && pnpm types && pnpm check
cp .dev.vars.example .dev.vars          # then set SUPPLIER_API_URL and SUPPLIER_WEBHOOK_SECRET
pnpm db:init && pnpm db:seed && pnpm dev
```

## What `pnpm smoke` proves

`smoke.mjs` starts a stand-in supplier API on a local port and points the Worker at it through `.dev.vars`, which it
restores afterwards. It then checks the following:

1. Employees submit requests and see only their own. A department without a budget creates nothing.
2. An employee gets 403 on the Admin operation. The approve and reject tools exist only on `/mcp/admin`, and the
   internal write Procedures are on neither MCP surface.
3. Rejecting through the admin MCP tool emails the requester. Approving that request afterwards, with its current
   version, is a 409 because the `requestStatus` guard matches no row.
4. Approving more than the department has left is a 409. The request stays `submitted`, and the budget and ledger are
   unchanged.
5. After another admin edits a request, approving the version first seen is a 409 that changes nothing.
6. Two admins approve the same version at the same time: one gets 200 and the other 409. The budget is deducted and
   the ledger row written once.
7. Approval places exactly one supplier order, sets `ordered` and emails the requester. The admin MCP tool can approve
   too.
8. A callback with a bad signature is a 401 and changes nothing. A correctly signed callback sets `confirmed`. A wrong
   order id, or a replay, is a 409.
9. The daily cron emails every admin about requests pending more than 3 days, and only about those.
