---
description: Scripted local checks before acceptance - handlers over real HTTP, public pages without JavaScript, MCP discovery, Admin's MCP App, and how to account for every surface.
---
# Local HTTP checks

`pnpm check` proves that the manifests compile and the app typechecks; it runs no handler. Before you report an app
or a feature ready, run it on a fresh local D1 and drive it over HTTP. In an app written by `mantle init`, that is
`smoke.mjs` on the shell's `smoke-kit.mjs` (`pnpm smoke`): it applies `generated/schema.sql` and `seed.sql`, starts
`wrangler dev --local`, signs users in with the console email code and deletes everything afterwards.
These checks are the author's evidence: layers 1 and 2 of the
[layered handoff report](agent-workflow-acceptance.md#report-done-ness-in-layers). [Independent
acceptance](agent-workflow-acceptance.md) comes after them and does not replace them, nor they it.

## What smoke covers

- **Every Procedure and HTTP Trigger the app declares:** valid input with the expected status and body (a status
  below 500 is not success), invalid input, an anonymous call to a protected operation, the other role, and the
  stored result read back. Use only the generated routes, inputs and permissions.
- **Business rules at their edges:** the oversell, the stale `expectedVersion`, the second approval, a refusal that
  must leave nothing behind (check the rows with the kit's `sql`), and two concurrent calls where a race matters.
- **Each caller sees only its own rows:** a second member's records are absent from lists and refused by id.
- **Visitor pages:** the checks in [public pages](public-pages.md#check-before-you-report-done), requested without
  JavaScript.
- **MCP:** `assertMcpDiscovery(endpoint, { tools, headers })` from `smoke-kit.mjs` for `/mcp` and `/mcp/admin`, with
  the expected tools taken from generated code (the app-shell README shows it), plus a separate assertion that an
  anonymous call and a member calling `/mcp/admin` are refused. Discovery needs no business `tools/call`.
- **Admin:** `pnpm build`, then `pnpm test` (`generated/admin-mcp-app.check.mjs`) loads the Admin MCP App in an MCP
  host and fails on a network error, console error or exception. It needs `playwright-core` and Chrome
  (`npx playwright-core install chromium`, or `MANTLE_TEST_CHROMIUM=<executable>`). With no browser it fails: report
  that check as BLOCKED on layer 2, not skipped and not as a product failure.

Better Auth allows 3 one-time-code requests per minute per client IP; the kit gives each user its own
`cf-connecting-ip`. Credentials come only from the kit's sign-in: a check never scrapes another session or builds a
Caller by hand.

## Account for every surface

In the app's README or handoff, list each declared surface (Admin, each MCP endpoint, REST, each visitor page type)
as verified (command, identity and result), intentionally not exposed, or UNVERIFIED with a reason. Local cookie
sessions do not prove an external MCP host's OAuth connection or a production origin; those are layer 4. Record the
commands and their results for the exact commit in the layered report, fix failures and rerun the affected checks. A
check the environment prevented (no browser, no network, a refused approval) is BLOCKED with its reason, not failed.
