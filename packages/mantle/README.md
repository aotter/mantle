# Mantle

Mantle is an agent-native application SDK and backend compiler. Declare Schemas, Views, Procedures and Triggers in
YAML manifests; `mantle generate` compiles them at build time into native SQL and typed TypeScript for SQLite (Bun or
Cloudflare D1) and PostgreSQL (Bun or Cloudflare Workers). The compiler adds row policy to every query, and the closed v2
grammar reports actionable diagnostics. Your app keeps its own entry, routes and auth; Mantle adds only the surfaces
you select: REST, MCP, a web module, Better Auth sign-in and the native Admin.

**Start here:** `npx mantle help` prints the installed docs one topic at a time. `mantle init <directory>` writes a
complete app shell once (email OTP, `admin` + `user`, Admin, MCP, REST); [examples](./docs/examples/README.md) show
how to combine stock, own-records, approvals, callbacks, public pages and email into it.

Three packages: `@aotter/mantle` is the SDK with bin `mantle`; `@aotter/mantle-ui` is pure UI without an SDK dependency; `@aotter/mantle-admin` is the optional product with the SDK as a peer. Use matching installed versions and their own docs.

## Where things are

`mantle help topics` lists every page. The ones most work starts from:

| Task | Topic |
| --- | --- |
| Build or change an app with an agent | `mantle help` (entry page) |
| Commands, outputs and targets | `mantle help project-and-cli` |
| Query from TypeScript, Store and adoption in an existing app | `mantle help typed-queries` |
| Native inputs, results and failure handling | `mantle help native-execution` |
| Admin | `mantle help native-admin` |
| Deploy, schema changes and operations | `mantle help deploy-and-operate` |
| Upgrade | `mantle help releases/index` |

The same pages ship as Markdown under [`docs/handbook/`](./docs/handbook/start/agents.md). Contributor checks:
[CONTRIBUTING](https://github.com/aotter/mantle/blob/develop/CONTRIBUTING.md).
