---
description: The entry point `mantle help` prints first: choose a complete app or generation only, use examples as references, accept before done.
---
# Build with an agent

`mantle help` prints this page. `mantle help <topic>` prints one handbook page, its next page and the pages it links;
topics are the handbook paths below (for example `guides/native-admin`) or their last segment when unique (`native-admin`).
The installed package's `docs/` is the source of every topic, so the text always matches the installed version.

## Choose how much Mantle owns

| You want | Do |
| --- | --- |
| A complete application | `mantle init [directory]`, then follow its `README.md`. It writes the app shell once: Better Auth email OTP with `admin` and `user`, the Admin console, MCP for both roles, REST, and a member `/sign-in` page. Existing files stop it; `--dry-run` lists what it would write. |
| Only typed SQL and bindings inside an app you already have | Skip `init`. Write manifests and run `mantle generate <target> <output-directory> <manifest>...`; see `mantle help project-and-cli` and `mantle help typed-queries`. |

`init` writes the `cloudflare-d1` shell, the default target. `bun-sqlite`, `bun-postgres` and `cloudflare-postgres`
generate the same bindings; their app entry is yours (`mantle help service-entry`).

`init` writes app code you then own; it never runs again. `generate` writes only `generated/` and Wrangler build keys,
and overwrites them on every run. When `generate` sees a selected surface (REST, MCP, Admin) whose generated module
the app entry (`--entry`) never imports, it warns and names the topic that shows the wiring.

## Build from a product brief

1. `mantle init`, install, then read the app's `README.md` and search for `AGENT:`.
2. Map the brief to the [four atoms](../concepts/four-atoms.md): Schemas, Views, Procedures, Triggers.
   Decide what each role (`admin`, `user`) does on each surface: Admin, MCP, REST and any visitor pages.
3. For each need, find the pattern in `mantle help examples` (the **Combining** table) and read that example's
   manifest and source. Examples are references: take the pattern into your own manifests; do not copy an example
   directory into the app.
4. `pnpm generate`, implement every listed handler, `pnpm check`, then `pnpm smoke`.
5. Before reporting the app or a feature done, run [role-only acceptance](../guides/agent-workflow-acceptance.md)
   (`mantle help agent-workflow-acceptance`). Scripted smoke is not acceptance.
