# Examples

Start from the **app shell**, then copy the example closest to your app on top of it. Each example shows a few
capabilities the others do not; combine them for anything else.

| Example | Shows |
|---|---|
| [App shell](./app-shell/README.md) | Better Auth (email OTP, `admin` + `user`), one Worker fetch, Admin, MCP, REST, local acceptance kit. No business manifests. |
| [Recipes](./recipes/README.md) | Publishing (draft → publish), translations, visitor pages with SEO, JSON-LD, `llms.txt`, Markdown and hreflang alternates, R2 media. |
| [Club events](./club-events/README.md) | Members who see and change only their own rows, no duplicates, capacity that never oversells, a handler that checks before writing, a member MCP tool. |
| [Purchasing](./purchasing/README.md) | An internal workflow: guarded status transitions, admin-only approval (Admin and admin MCP), optimistic concurrency, several writes in one transaction, an external API with a signed callback, email and cron. |
| [Generated website](./generated-web/README.md) | The smallest public site: list and detail pages, REST, `llms.txt`, sitemap, Markdown alternates. |

## Combining

| You need | Take |
|---|---|
| Stock that never oversells (orders, tickets, bookings) | club-events' capacity: a Schema `checks` constraint plus the decrement in the same program |
| Employees or customers who see only their own records | club-events' `restrict: "author_id = auth.uid()"` |
| An approval step, or any state machine | purchasing's guarded `UPDATE ... WHERE status = ...` Procedures |
| A third-party API that answers later (webhooks, callbacks) | purchasing's `src/routes.ts`: verify the raw request, then call a Procedure |
| Public, multilingual, search- and AI-friendly pages | recipes' `src/routes.ts` |
| Notifications and reminders | purchasing's `EmailSender` call and `src/schedule.ts` |

Roles stay `admin` and `user`. For finer permissions, see Better Auth access control and
[authorization](../handbook/reference/authorization.md).

[Reference service](./reference-service/README.md) is the release smoke test for packed packages, not a starting point.
Projects on 0.1.x move with [the upgrade guide](../upgrade-0.1-to-0.2.md).
