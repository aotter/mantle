---
description: "The entry point `mantle help` prints first: choose a complete app or generation only, use examples as references, accept before done."
---
# Build with an agent

`mantle help` prints this page. `mantle help <topic>` prints one handbook page and ends with the commands for its next page and for every page it links; run those to read further.
Topics are the handbook paths below (for example `guides/native-admin`) or their last segment when unique (`native-admin`).
The installed package's `docs/` is the source of every topic, so the text always matches the installed version.

Node 22.22 or newer. Pin every `@aotter/mantle*` package to one exact version.

## Choose how much Mantle owns

| You want | Do |
| --- | --- |
| A complete application | `mantle init [directory]`, then follow its `README.md`. It writes the app shell once: Better Auth email OTP with `admin` and `user`, the Admin console, MCP for both roles, REST, and a member `/sign-in` page. Existing files stop it; `--dry-run` lists what it would write. |
| Only typed SQL and bindings inside an app you already have | Skip `init`. Write manifests and run `mantle generate <target> <output-directory> <manifest>...`; see `mantle help project-and-cli` and [adopting Mantle in an existing app](../guides/typed-queries.md#adopt-mantle-in-an-existing-application). |

`init` writes the `cloudflare-d1` shell, the default target. `bun-sqlite`, `bun-postgres` and `cloudflare-postgres`
generate the same bindings; their app entry is yours (`mantle help service-entry`).

`init` writes app code you then own; it never runs again. `generate` writes only `generated/` and Wrangler build keys,
and overwrites them on every run. When `generate` sees a selected surface (REST, MCP, Admin) whose generated module
the app entry (`--entry`) never imports, it warns and names the topic that shows the wiring.

## Build from a product brief

**Plan once, then run to the end.** Before writing anything, reply with one plan and wait for the user's go-ahead.
Write it in the user's language and in business terms: no Schema, SQL, route, tool or package names.

- **What the app does:** what each kind of user can do, and the business rules it enforces. For example: "a full event
  puts new sign-ups on a waiting list, and a cancellation moves the first person on it in".
- **How you will check it works:** who will try the app and what each of them tries to get done
  ([acceptance](../guides/agent-workflow-acceptance.md#plan-the-run)).
- **How you will check it is fast:** how much sample data, and what "fast enough" means for each page
  ([performance](../guides/performance.md#plan-the-pass)).
- **What you need from the user,** such as a browser or a deployment.
- **Questions:** every rule the brief leaves open, such as limits, deadlines, who may see or change what, and what
  happens on a cancellation. Give each one the answer you will assume if the user does not reply.

After the go-ahead, do every step below without stopping, and end with the report in the last step. Stop again only
for what the plan did not cover and needs the user: a credential, a deployment, a destructive action or a change of
scope.

1. `mantle init`, install, then read the app's `README.md` and search for `AGENT:`.
2. Map the brief to the [four atoms](../concepts/four-atoms.md): Schemas, Views, Procedures, Triggers.
   Decide what each role (`admin`, `user`) does on each surface: Admin, MCP, REST and any visitor pages.
3. For each need, find the pattern in `mantle help examples` (the **Combining** table) and read that example's
   manifest and source. Examples are references: take the pattern into your own manifests; do not copy an example
   directory into the app.
   - Business rules (status transitions, approval thresholds, stock, guards, several rows that commit together)
     belong in SQL Procedures, not in handler code around separate writes: `mantle help sql-patterns`, and
     `mantle help sql` for the SQL each dialect accepts.
   - Visitor pages (anything anonymous and indexable) follow `mantle help public-pages`: server-rendered HTML,
     canonical and Open Graph tags, JSON-LD and an answer block on detail pages, Markdown alternates, `/sitemap.xml`,
     `/robots.txt` and `/llms.txt`. A brief that names a site, shop or catalogue for visitors includes all of them.
4. `pnpm generate`, implement every handler it lists, `pnpm check`, then `pnpm smoke`.
5. **Show the user the wiring.** As soon as the manifests generate, run `pnpm accept --open`: it starts the app,
   signs the admin in without a one-time code and opens the Developer UI (`/admin/dev`) in the user's browser, showing
   the Schemas, Views, Procedures and Triggers and how they connect, with each surface's routes and tools. Tell the user
   what they are looking at. Keep building while they look; the app rebuilds on every change. Without a browser on the
   machine, give the user the admin URL it prints.
6. **Run [role-only acceptance](../guides/agent-workflow-acceptance.md)** (`mantle help agent-workflow-acceptance`) as
   planned. Scripted smoke is not acceptance. `pnpm accept` starts the app and hands each role to a fresh evaluator as
   a URL that carries that role's session. After a repair, the guide's
   [re-verification rule](../guides/agent-workflow-acceptance.md#re-verify-what-a-repair-touches) decides which roles
   and surfaces run again.
7. **Run the [performance pass](../guides/performance.md)** as planned, for every role and surface acceptance reports
   CONVERGED. BLOCKED or UNVERIFIED parts are reported as they are, never optimized. A step the user declined in the
   plan is reported as not run, never as done.
8. **Report what changed, not only that it passed:** the [acceptance summary](../guides/agent-workflow-acceptance.md#summarise-for-the-user)
   and the [performance summary](../guides/performance.md#summarise-for-the-user), then the layered status.

The first verified sign-in with `ADMIN_EMAIL` becomes the admin. Further administrators are added in Admin:
**More → Administrators** invites by email, and **More → Members** grants Admin to an existing member.
[Authentication](../cloudflare/authentication.md#identity-helpers) documents the same operations as an API.

## Other tasks

| Task | Read |
| --- | --- |
| Upgrade Mantle | [Upgrade an application](../releases/index.md#upgrade-an-application) |
| Deploy, only when the user asks | [Deploy and operate](../cloudflare/deploy-and-operate.md) |
| A slow page, first request or query | [Performance pass](../guides/performance.md) |
| Stale media uploads, only when the user asks | [Clean up stale uploads](../cloudflare/media-r2.md#clean-up-stale-uploads) |
