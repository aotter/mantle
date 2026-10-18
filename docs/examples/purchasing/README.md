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
  `change-amount`, `mark-ordered`, `confirm-order`). The column is `requestStatus` because `status` is reserved for
  publishing Schemas. `requests` and `ledger` set `readOnly: true`, so Admin's generic editor cannot bypass the state
  machine (for example by moving an ordered request back to `submitted` and approving it again).
- **A status chosen at submission**: `submit-request` uses `CASE WHEN input.amount <= 100 THEN 'approved' ELSE
  'submitted' END`. A small request also spends the budget and writes its ledger row in the same program, so
  `remaining >= 0` refuses all three when it would overspend. The ledger row is found with `NOT EXISTS`: the
  requester's approved requests that have no row yet. Larger requests wait for an admin. An auto-approved request is
  ordered from the supplier by the daily cron, which already retries every `approved` request.
- **Admin-only operations**: `approve-request` and `reject-request` declare `requires: ctx.admin` and a `target`, so
  Admin shows them as operations on a request. Their `kind: mcp, surface: admin` Triggers make them
  `approve_request` / `reject_request` tools on `/mcp/admin`. They are not listed on `/mcp`.
- **Optimistic concurrency**: clients send `expectedVersion`, and the SQL matches `version = input.expectedVersion`.
  If the requester changes the amount (`change-amount`, only their own request and only while it is `submitted`)
  after an admin reviewed it, that admin's approval is a 409. When two admins approve the same version, one succeeds
  and the other gets a 409.
- **Several writes in one transaction**: `approve-request-write` runs three statements as one program: the status
  change, `UPDATE budgets SET remaining = remaining - ...` and `INSERT INTO ledger`. If the request would overspend,
  `checks: ["remaining >= 0"]` on `budgets` rolls back all three. `src/handlers.ts` turns that failure into a 409.
- **External API + signed callback**: after the transaction commits, `src/supplier.ts` POSTs the order to
  `env.SUPPLIER_API_URL` (request id as the idempotency key, 10 s timeout) and then sets the request to `ordered`.
  If the supplier cannot be reached, the request stays `approved` and the daily cron retries it as a system caller
  (`mark-ordered` has no `requires` for that reason, and no Trigger).
  `src/routes.ts` serves `POST /callbacks/supplier`. It first checks an HMAC-SHA256 of the timestamp and the **raw**
  body with `env.SUPPLIER_WEBHOOK_SECRET`, and only then parses the JSON. It then calls the generated `confirm-order`
  Procedure as a `system` caller. No Trigger exposes that Procedure. The callback may arrive before `ordered` is
  written, so `approved` is confirmed too. A replay of an applied callback answers 204 again.
- **Email + cron as app code**: `src/notify.ts` sends through an `EmailSender` from `@aotter/mantle/email`
  (`ConsoleEmailSender` locally). `src/schedule.ts` uses `toCloudflareCron`, and its cron is listed in
  `wrangler.jsonc`. The cron retries failed orders (internal View `approved-requests`) and sends the reminder
  (internal View `stale-requests`) to admins who are not banned.
- Employees see only their own requests through `my-requests` (`restrict: { requests: "author_id = auth.uid()" }`).
- **Sidebar for the approver's day**: `src/admin.tsx` declares an Approvals group (`defineAdmin` `nav.groups`) above Admin's built-in
  groups; `pending-requests` and `requests` move into it with `uiSchema.nav: { group, order }`.
- **A page only signed-in employees reach**: `src/requests-page.ts` serves `GET /requests`. An anonymous visitor gets a
  303 to the shell's `/sign-in?return=/requests` (`src/sign-in.ts`, email code, then back). Signed in, the table reads
  `my-requests` as the visitor's own caller. The form keeps `action="/api/requests" method="post"`; a small script sends
  its fields as JSON to that REST Trigger, so the manifest's validation, `requires` and origin check apply and app code
  never hands request data to a Procedure. Unstyled on purpose. `src/signup.ts` lets only `@EMPLOYEE_DOMAIN` emails
  create an account (`vars` in `wrangler.jsonc`).

Search for `AGENT:` to find what a real app must still provide: an email sender, the supplier's real API and signature
scheme.

## Combine with

- Need members to own rows, prevent duplicates or cap capacity? Add club-events' `uniqueIndexes` and capacity `checks`.
- Need public pages, SEO or media for the approved items? Add recipes' publishing lifecycle and visitor pages.
- Need another approval flow? Copy the pattern: a ref Procedure (admin-only, side effects) that wraps a guarded SQL
  write Procedure (one transaction).

## Run it

This runs the example by itself, to read and try. For your own app, run `mantle init` and take only the patterns you need into its manifests and `src/` (`mantle help examples`).

```sh
npx mantle init my-app
cp -R node_modules/@aotter/mantle/docs/examples/purchasing/. my-app/   # run the example as is
cd my-app && pnpm install && pnpm generate && pnpm types && pnpm check
cp .dev.vars.example .dev.vars          # then set SUPPLIER_API_URL and SUPPLIER_WEBHOOK_SECRET
pnpm db:init && pnpm db:seed && pnpm dev
```

## What `pnpm smoke` proves

`smoke.mjs` starts a stand-in supplier API on a local port (which it can switch to 503) and passes its URL and the
webhook secret through `smoke(scenario, { vars })`. It then checks the following:

1. Employees submit requests and see only their own. A department without a budget creates nothing.
2. An employee gets 403 on the Admin operation. The approve and reject tools exist only on `/mcp/admin`, and the
   internal write Procedures are on neither MCP surface.
3. Rejecting through the admin MCP tool emails the requester. Approving that request afterwards, with its current
   version, is a 409 because the `requestStatus` guard matches no row.
4. Approving more than the department has left is a 409. The request stays `submitted`, and the budget and ledger are
   unchanged.
5. Admin's generic editor cannot change a request. Another employee cannot change its amount (409); the requester can,
   and then approving the version the admin reviewed is a 409 that changes nothing.
6. Two admins approve the same version at the same time: one gets 200 and the other 409. The budget is deducted and
   the ledger row written once.
7. Approval places exactly one supplier order, sets `ordered` and emails the requester.
8. The admin MCP tool approves too. With the supplier down, approvals still commit and stay `approved`.
9. A callback with a bad signature is a 401 and changes nothing. A correctly signed callback sets `confirmed`, also
   while the request is still `approved`; a replay is 204; a wrong order id or a `submitted` request is 409.
10. The daily cron places the failed order (`ordered`) and emails every admin about requests pending more than 3
    days, and only about those.
