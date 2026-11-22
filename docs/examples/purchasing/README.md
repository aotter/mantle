# Purchasing

An internal purchase-request workflow. Any signed-in employee submits a request against a department budget. An admin
approves or rejects it, in Admin or through an AI agent on the admin MCP endpoint. Approval spends the budget and writes a
ledger row in one transaction. The app then orders from the supplier's API and waits for the supplier's signed callback
to mark the request confirmed. Requesters get an email on each decision, and a daily cron emails admins about requests
that have been waiting too long.

## Capabilities shown

- **Declared relationships**: each request stores a read-only `budgetId` reference to its budget. Each ledger row references
  both its budget and its request; `uniqueIndexes: [[requestId]]` permits at most one ledger row per request. The ER diagram
  shows budget-to-request and budget-to-ledger as one-to-many. Department names remain readable snapshots; spending joins
  stable budget IDs. These references are model metadata, not database foreign keys. Requests and ledger remain available
  as standalone Admin collections, with the ledger also grouped under its request.
- **Status workflow with guarded transitions**: the write Procedures use
  `UPDATE requests SET requestStatus = 'approved' ... WHERE id = input.id AND requestStatus = 'submitted'`. A match on
  0 rows is a `CONFLICT` (409). See `manifests/purchasing.yaml` (`approve-request-write`, `reject-request-write`,
  `change-amount`, `mark-ordered`, `confirm-order`). The column is `requestStatus` because `status` is reserved for
  publishing Schemas. `requests` and `ledger` set `readOnly: true`, so Admin's generic editor cannot bypass the state
  machine (for example by moving an ordered request back to `submitted` and approving it again).
- **A status chosen at submission**: `submit-request` uses `CASE WHEN input.amount <= 100 THEN 'approved' ELSE
  'submitted' END`. A small request also spends the budget and writes its ledger row in the same program, so
  `remaining >= 0` refuses all three when it would overspend. Those two statements find the request by
  `created_at = now()` (the instant of this program) and `NOT EXISTS` a ledger row, so the threshold is written only in
  the `CASE`. Larger requests wait for an admin. An auto-approved request sends no approval email, and the daily cron
  orders it from the supplier (it already retries every `approved` request); route small requests through a `ref`
  handler like `approve-request` if they must be ordered and announced at once.
- **Admin-only operations**: `approve-request` and `reject-request` declare `requires: ctx.admin` and a `target`, so
  Admin shows them as operations on a request. Their `kind: mcp, surface: admin` Triggers make them
  `approve_request` / `reject_request` tools on `/mcp/admin`. They are not listed on `/mcp`.
- **A rejection with a reason**: the rejection form requires a non-blank reason of at most 1,000 characters. The
  guarded transition stores it in `requests.rejectionReason`, exposes it read-only in Admin, and includes it in the
  requester's notification. It does not spend the budget or write a spending ledger row. Existing copies need a
  reviewed migration adding the nullable text column before adopting this manifest; clients of `reject_request`
  must supply `reason` as well as `id` and `expectedVersion`.
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
- **A custom Approval desk**: `src/admin.tsx` renders pending requests as cards with their title, department and amount,
  using generated `useView`, `AdminLink` and kit components. It handles loading, empty, unavailable and error states,
  with Load more for subsequent pages. Open a card to use the built-in record review and approve/reject operations;
  budgets and ledger reports also remain built-in. The `/admin/p/guide` route is retained.
- **The employees' app**: a React single-page app under `/app` (below). `src/signup.ts` lets only `@EMPLOYEE_DOMAIN`
  emails create an account (`vars` in `wrangler.jsonc`).

Search for `AGENT:` to find what a real app must still provide: an email sender, the supplier's real API and signature
scheme.

## The employees' app under `/app`

An area that is all live state and needs no search engine (a cart, a checkout, a dashboard, this request form) can be a
single-page app under its own path prefix; content pages stay server-rendered (the recipes example). This is a choice
shown here, not a requirement.

| File | Purpose |
|---|---|
| `src/client/app.tsx` | The app: React with kit components (`@aotter/mantle-ui/kit`), its three pages and their REST calls |
| `src/client/app.css` | Its one stylesheet: the kit's `kit.css` plus a few layout rules; `mantle bundle` writes `/assets/client/app.css` |
| `src/client/css.d.ts` | Lets TypeScript accept the stylesheet import |
| `public/app/index.html` | The shell document: `noindex`, a root element, the stylesheet and one module script, `/assets/client/app.js`. A static file cannot read the map of content-hashed names (`@aotter/mantle/client-assets`), so it links the stable names, which the browser revalidates on each load |
| `src/routes.ts` (`appShell`) | Answers every path under `/app` with that document |
| `manifests/purchasing.yaml` | The Views `my-requests`, `my-request` and `department-budgets`; the REST Triggers `POST /api/requests` and `POST /api/requests/{id}/amount` |

| Page | Shows | Calls |
|---|---|---|
| `/app` | My requests and their status, read again every 10 s while the tab is visible | `GET /api/views/my-requests` |
| `/app/new` | The form: each department with what its budget has left; errors beside their fields | `GET /api/views/department-budgets`, `POST /api/requests` |
| `/app/requests/{id}` | One request; while it is `submitted`, a change of its amount | `GET /api/views/my-request?id=`, `POST /api/requests/{id}/amount` |

The rules, and why:

- **No authority in the browser.** The app reads Views and writes only through the REST Triggers; the session cookie
  goes with every call and the server checks it, the input and `requires` each time. A 401 (the session ended) sends
  the employee to `/sign-in` and back.
- **Not indexed, not hidden.** The shell has `<meta name="robots" content="noindex">` and the response
  `X-Robots-Tag: noindex`. It is in no sitemap or `llms.txt`, and `robots.txt` does not disallow it: a crawler that may
  not fetch a page never reads its `noindex`.
- **Signed in first.** An anonymous visitor gets a 303 to `/sign-in?return=<path>` (`signInRedirect`); the sign-in page
  goes back only to a path on this origin. What a signed-out crawler can fetch is that sign-in page, and the shell
  itself holds no workflow data either.
- **`Cache-Control: no-store` on the shell.** Its bytes are the same for everyone, but the answer for an `/app` URL
  depends on the caller (the shell, or a redirect to sign in), and a cache in front of the Worker keys on the URL, not
  the cookie ([caching](../../handbook/guides/caching.md)): a stored redirect would bounce a signed-in employee, a
  stored shell would skip the sign-in. It costs one asset read per full page load; moving inside the app loads no
  document. The REST answers are `private, no-store`.
- **Real 404s.** Only `/app`, `/app/`, `/app/new` and `/app/requests/{id}` answer 200. Another path under `/app` gets
  the same document with status 404, and the app shows its own not-found page; a path outside `/app` is the Worker's
  plain 404. There is no single-page fallback that turns unknown URLs into soft 404s. (An unknown request id is a 200
  shell whose page says not found: telling would need a read before the shell.)
- **One bundle.** `mantle bundle` builds `src/client/app.tsx` into one self-contained browser file; the Worker serves
  only the shell, so the app adds nothing to the Worker's startup graph. The kit's components need its optional peers
  (`radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`, ...); `@aotter/mantle-admin` depends on them, so an
  app with Admin has them. Without Admin, install them (the kit's README).

`department-budgets` shows every employee what each department has left; the earlier server-rendered page read only
the department names. Drop the View and the column from the form if the amounts are for admins only.

## Combine with

- Need members to own rows, prevent duplicates or cap capacity? Add club-events' `uniqueIndexes` and capacity `checks`.
- Need public pages, SEO or media for the approved items? Add recipes' publishing lifecycle and visitor pages.
- Need another approval flow? Copy the pattern: a ref Procedure (admin-only, side effects) that wraps a guarded SQL
  write Procedure (one transaction).

## Run it

Existing copies need a native migration for the new `budgetId` fields on requests
and ledger: backfill them from the existing department budget and request,
then enforce NOT NULL. Regeneration alone does not migrate an occupied database.

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
11. `/app`: an anonymous visit is a 303 to `/sign-in?return=<path>`; signed in, every app page is the same shell
    (200, `noindex` in the document and the header, `no-store`, one module script, no inline script, no workflow
    data); unknown paths under `/app` are 404 with the shell, paths outside it the Worker's 404; `/robots.txt`,
    `/sitemap.xml` and `/llms.txt` do not name `/app`.
12. The app's REST calls end to end: an employee reads the budgets, submits, sees the request `submitted`, an admin
    approves, and the employee sees it `ordered` and the budget's new remainder; another employee cannot read it.
13. In Chrome, when `MANTLE_TEST_CHROMIUM` names a Chrome or Chromium binary (skipped otherwise): a signed-out visit to `/app/new` ends on sign-in; signed in, the form shows an error beside its field,
    submits through the UI, and the list shows the new request; an unknown path shows the app's not-found page.
