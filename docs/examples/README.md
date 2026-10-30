# Examples

Start an app with `mantle init`, which writes the **app shell** once. The examples are references: each shows a few
capabilities the others do not. Find each need in **Combining** below, read that example's manifest and source, and
take the pattern into your own manifests and `src/`. Do not copy an example directory over your app.

| Example | Shows |
|---|---|
| [App shell](./app-shell/README.md) | Better Auth (email OTP, `admin` + `user`), one Worker fetch, Admin, MCP, REST, local acceptance kit. No business manifests. |
| [Recipes](./recipes/README.md) | Publishing (draft → publish), translations, visitor pages with SEO, JSON-LD, `llms.txt`, Markdown and hreflang alternates, R2 media. |
| [Club events](./club-events/README.md) | Members who see and change only their own rows, no duplicates, capacity that never oversells, a handler that checks before writing, a member MCP tool, members-only sign-up. |
| [Purchasing](./purchasing/README.md) | An internal workflow: guarded status transitions, admin-only approval (Admin and admin MCP), optimistic concurrency, several writes in one transaction, an external API with a signed callback, email and cron. |
| [Generated website](./generated-web/README.md) | The smallest public site: list and detail pages, REST, `llms.txt`, sitemap, Markdown alternates. |

## Combining

| You need | Take |
|---|---|
| Stock that never oversells (orders, tickets, bookings) | club-events' capacity: a Schema `checks` constraint plus the decrement in the same program |
| An order, cart or import with several rows that must all commit or none | one SQL Procedure over `json_each(input.items)` with a counted check that refuses unknown lines (`mantle help typed-queries`, "Several rows that commit together") |
| Employees or customers who see only their own records | club-events' `restrict: { <schema>: "author_id = auth.uid()" }` |
| An approval step, or any state machine | purchasing's guarded `UPDATE ... WHERE requestStatus = ...` Procedures |
| Approve first, then reserve or spend | purchasing's `approve-request-write`: the guarded status change and the budget deduction in one program (`mantle help sql-patterns`, "Approve before reserving") |
| A status chosen while writing (auto-approve small requests) | purchasing's `submit-request`: `CASE` in the INSERT ("Choose a status while writing: CASE") |
| Edit only the fields given | `COALESCE(input.field, field)` ("Change only the fields given") |
| Create or add (restock, counters) | `INSERT ... ON CONFLICT (...) DO UPDATE` ("Create or add") |
| Refuse while something still refers to it | a `NOT EXISTS` guard in the UPDATE (purchasing's `submit-request` ledger row; "Refuse while something refers to it") |
| A record with its children in one read | club-events' `event-roster`: a JSON array per row ("A row with its children in one read") |
| The latest row per group, rankings | `row_number() OVER (PARTITION BY ...)` ("The latest row of each group") |
| A third-party API that answers later (webhooks, callbacks) | purchasing's `src/routes.ts`: verify the raw request, then call a Procedure |
| Public, multilingual, search- and AI-friendly pages | recipes' `src/routes.ts` |
| Invite-only or members-only sign-up | club-events' `members` allowlist + `src/signup.ts` |
| Notifications and reminders | purchasing's `EmailSender` call and `src/schedule.ts` |

If you do copy an example's files, delete what your app does not need. Copying club-events, for example, also brings its `members` allowlist and `src/signup.ts` (members-only sign-up); remove both, or restore the
shell's allow-all `src/signup.ts`, unless sign-up should be invite-only. Purchasing brings its supplier callback
(`src/routes.ts`, `src/supplier.ts`), email (`src/notify.ts`), cron (`src/schedule.ts` and `triggers.crons`) and its
`wrangler.jsonc` secrets. `pnpm generate` and `tsc` point at leftovers that reference removed Schemas.

Every example uses two roles: `admin` (the admin layer) and `user`.

[Reference service](https://github.com/aotter/mantle/tree/v0.2.1/docs/examples/reference-service) is the release smoke test for packed packages, not a starting point. Its source lives in the tagged repository; it is not included in the npm docs.
Projects on 0.1.x move with [the upgrade guide](../handbook/releases/upgrade-0.1-to-0.2.md).
