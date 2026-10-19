<h1 align="center">Mantle</h1>

<p align="center">
  <em>Be the dungeon master. Don’t code every corridor.</em>
</p>

<p align="center">
  <img src="docs/assets/mantle-hero.jpg" width="900" alt="Mantle hero: a dungeon master invokes four runes (Schema, View, Procedure, Trigger) while a living shell labyrinth assembles itself; an unused pickaxe lies nearby.">
</p>

<p align="center">
  <strong>Schema. View. Procedure. Trigger. Four atoms from which your world takes shape.</strong><br>
  Speak it in plain YAML, and the dungeon wakes—whole, lit from within, and yours to command.
</p>

<p align="center">
  <a href="https://github.com/aotter/mantle/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/aotter/mantle/ci.yml?branch=develop&style=flat-square&label=build"></a>
  <a href="https://github.com/aotter/mantle/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/aotter/mantle?style=flat-square&color=0b7285&label=stars"></a>
  <a href="https://www.npmjs.com/package/@aotter/mantle"><img alt="npm version" src="https://img.shields.io/npm/v/@aotter/mantle?style=flat-square&label=npm&color=0b7285"></a>
  <a href="https://github.com/aotter/mantle/releases"><img alt="GitHub prerelease" src="https://img.shields.io/github/v/release/aotter/mantle?include_prereleases&sort=semver&style=flat-square&label=release&color=0b7285"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 22.22 or newer" src="https://img.shields.io/badge/node-%3E%3D22.22-0b7285?style=flat-square&logo=nodedotjs&logoColor=white"></a>
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-0b7285?style=flat-square"></a>
</p>

<p align="center">
  <a href="#what-mantle-gives-you">Features</a> &middot;
  <a href="#admin-for-people-and-agents">Admin</a> &middot;
  <a href="#get-started">Get started</a> &middot;
  <a href="#faq">FAQ</a> &middot;
  <a href="#documentation">Documentation</a> &middot;
  <a href="docs/examples/README.md">Examples</a>
</p>

Mantle is an agent-native application SDK. You declare Schemas, Views,
Procedures and Triggers in YAML manifests, and the Mantle compiler turns them
into native SQL for SQLite, Cloudflare D1 and PostgreSQL, plus typed
TypeScript operations. It is for developers and AI coding agents building
publishing sites, internal operations apps and agent-facing APIs on Cloudflare
Workers or Bun.

Mantle is not a framework. Your application keeps its entry point, routes,
auth and database handles, and selects only the surfaces it needs: REST, an
MCP (Model Context Protocol) server, a web module for `llms.txt` and sitemaps,
Better Auth sign-in, and a native admin console.

## What Mantle gives you

- **One Manifest, connected interfaces.** Schema, View, Procedure, and Trigger
  describe your data and behavior. The compiled definitions power typed APIs,
  HTTP routes, MCP tools, and Admin. [Manifest features](docs/handbook/reference/features.md).
- **Typed queries and actions.** Generate TypeScript bindings for entries,
  declarative Views, and Procedures. Keep host-only reads private with internal
  Views. [Typed queries](docs/handbook/guides/typed-queries.md).
- **Admin that follows your model.** Manage live records, publish content, run
  reports, and invoke business actions. Configure columns, filters, and actions
  with Manifest `uiSchema`. [Admin customization](docs/handbook/guides/admin-ui.md).
- **Tools for browser and remote agents.** Admin supports WebMCP using the
  signed-in admin session. Remote MCP clients connect through authenticated
  endpoints, with authorization checked on each call.
  [MCP and WebMCP](docs/handbook/concepts/mcp-and-agents.md).
- **Publishing and public pages.** Draft/publish workflows, localized content
  and full-text search, managed in Admin and served over REST and MCP. The
  optional `web()` module serves `llms.txt`, a sitemap, Markdown alternates and
  canonical head tags from public Views.
  [Public pages](docs/handbook/guides/public-pages.md).
- **Embed in an existing application.** Mount the REST, MCP or Admin surface
  you need inside your own Worker or server entry.
  [Service composition](docs/handbook/cloudflare/service-entry.md).
- **Guarantees the compiler enforces.** Row policy is compiled into every
  generated query. A single-row write must affect exactly one row, which makes
  optimistic concurrency (OCC) explicit, and a SQL Procedure's statements
  commit atomically. The closed manifest grammar reports actionable
  diagnostics instead of guessing.
- **Built for coding agents.** `mantle help` prints the docs that match your
  installed version, `mantle init` writes an app shell, and `pnpm accept`
  runs role-based acceptance of the running app.
  [Build with an agent](docs/handbook/start/agents.md).

## Admin for people and agents

Give admins a workspace for content, operational records, reports, and actions.
In browsers supporting WebMCP, agents can discover and invoke admin tools from
Admin, inspect the current page, and navigate alongside the user. Calls use the
current admin session and retain server-side authorization and concurrency checks.

![Mantle Admin brings publishing content, live records, reports, and admin operations into one console.](docs/assets/mantle-admin-operations.png)

### Developer UI and application API docs

Explore your application's Schemas, Views, Procedures, Triggers, and their
relationships in the admin-only Developer UI. Its HTTP, MCP, and WebMCP docs
show the application's projected routes and tool schemas, with links back to
the owning definitions.

![Mantle Developer UI showing the compiled intake example and its connected Manifest atoms.](docs/assets/mantle-admin-developer.png)

*Developer UI rendered locally from the intake example. The graph describes
compiled declarations; it does not certify runtime or deployment health.*

The application serves the console at `/admin` from the Admin that `mantle bundle`
builds into `dist/client/admin`; this view draws from the admin-only
`GET /admin/api/developer-console`.

| Interface | Integration guide |
|---|---|
| HTTP | [Writes: Procedures and Triggers](docs/handbook/concepts/procedures-and-triggers.md) |
| Remote MCP | [Endpoints, tools, and authentication](docs/handbook/concepts/mcp-and-agents.md) |
| Browser WebMCP | [WebMCP in Admin](docs/handbook/concepts/mcp-and-agents.md) |

## Example: a YAML manifest

An intake application needs request records, a submission action, and an admin
inbox. Its admin View can be as small as:

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: recent-requests }
spec:
  title: Recent requests
  surface: admin
  sql: |
    SELECT id, name, email, message, created_at FROM requests
    ORDER BY created_at DESC LIMIT 50
```

Together with the `requests` Schema, this defines the read used by the admin
report and its MCP tool. A Procedure handles submissions, with Triggers choosing
HTTP and MCP exposure.

For a complete runnable application, see the
[reference service](docs/examples/reference-service/README.md).

## Get started

### With a coding agent

Install the Mantle skill to get guided setup for your application and the
features you need:

```sh
npx skills add https://github.com/aotter/mantle/tree/v0.2.0-alpha.10 --skill mantle
```

Ask your agent to follow the installed skill and describe what you want to build.
Use the release tag matching your application's SDK; an unqualified repository
install follows `main`, which can lag an alpha release on `develop`.
See the [agent setup guide](docs/handbook/guides/agent-setup.md) for supported
editors, plugins, and project instructions.

### Build it yourself

Use Node 22.22+ and install an exact 0.2.x version of `@aotter/mantle`, with
matching Admin/UI packages when selected. `npx mantle help` prints the
installed docs one topic at a time.

`mantle init <directory>` writes a Cloudflare D1 app shell once: email OTP
sign-in, `admin` and `user` roles, Admin, MCP and REST. The app owns that code
from then on; `mantle init` never overwrites it. To add Mantle to an app you
already have, skip `init` and write manifests.

After you edit manifests, run
`mantle generate <target> <output-directory> <manifest>...`, for example
`mantle generate cloudflare-d1 generated manifests/*.yaml`.
The generator writes native TypeScript/SQL and Workers split-build settings;
your application supplies its entry, routes, auth and database handles. In an
app written by `mantle init`, `pnpm accept` starts the app for role-based
acceptance.

Follow the
[quickstart](docs/handbook/start/quickstart-worker.md), then the
[project and CLI guide](docs/handbook/start/project-and-cli.md). The
[reference service](docs/examples/reference-service/README.md) is a whole
service with its smoke test.

Using ChatGPT Sites? Follow [Mantle on ChatGPT Sites](docs/handbook/cloudflare/chatgpt-sites.md).

## Targets, databases and packages

| Start with | Add when you need |
|---|---|
| [`@aotter/mantle`](packages/mantle/README.md) | Native generated queries, typed Store, compiler and the `mantle` CLI. |
| Target `cloudflare-d1` or `cloudflare-postgres` | App-owned Worker routing and D1 or postgres.js/Hyperdrive handles. |
| Target `bun-sqlite` or `bun-postgres` | App-owned Bun server using bun:sqlite or Bun.SQL. |
| `@aotter/mantle/auth` | Sign-in, admin roles, and OAuth for MCP. |
| [The reference service](docs/examples/reference-service/README.md) | A whole service to read and run. |

PostgreSQL and SQLite are the two built-in dialects. Manifest SQL uses the
compiler's PostgreSQL syntax and is rendered for the selected target.
PostgreSQL uses Bun.SQL on Bun and postgres.js on Workers; other native handles
need an application-owned adapter. Upgrading from 0.1.x:
[the upgrade guide](docs/upgrade-0.1-to-0.2.md); an existing PostgreSQL
service also reads [the release notes](docs/handbook/releases/index.md).

<details>
<summary>Package reference</summary>

| Package | Purpose |
|---|---|
| `@aotter/mantle` | Native SDK, private compiler, generator and CLI; selected driver, auth, REST, MCP, web and site/media primitives. |
| `@aotter/mantle-ui` | Pure UI: generic interaction controller, React components, visual kit and design tokens. No SDK dependency. |
| `@aotter/mantle-admin` | Admin app library and thin server, preview and Admin MCP App. Uses UI and public SDK contracts; the SDK remains a peer. |

</details>

## FAQ

### What is Mantle?

Mantle is an open-source (Apache-2.0) agent-native application SDK and backend
compiler. It compiles YAML manifests (Schemas, Views, Procedures
and Triggers) into native SQL for SQLite, Cloudflare D1 and PostgreSQL, plus
typed TypeScript operations, on Cloudflare Workers or Bun, with optional REST,
MCP, web, auth and admin surfaces.

### Is Mantle a framework?

No. Mantle does not own your entry point, router or auth, and it does not take
control of your app. Your application imports the generated operations, passes
its own database handle and verified caller, and mounts only the surfaces it
selects. `mantle generate` writes only `generated/` and Wrangler build keys.
`mantle init` writes a starting shell once; after that the code is yours.

### How is Mantle different from an ORM or a headless CMS?

Instead of building queries in application code, you declare SQL Views and
Procedures in manifests; the compiler checks them and emits native SQL with row
policy, single-row write checks and atomic Procedures. A headless CMS is usually
a separate product with its own content model. Mantle gives you publishing
workflows, an admin console and public pages inside your own application and
database, for content you model yourself.

### Which databases and hosts does Mantle support?

Mantle supports SQLite (Cloudflare D1 or bun:sqlite) and PostgreSQL, on
Cloudflare Workers or Bun, through four generator targets: `cloudflare-d1`
(Cloudflare D1 on Workers), `cloudflare-postgres` (PostgreSQL via postgres.js,
usually with Hyperdrive, on Workers), `bun-sqlite` (bun:sqlite) and
`bun-postgres` (Bun.SQL). Manifest SQL uses PostgreSQL syntax and is rendered
for the selected dialect.

### How do AI agents use Mantle?

Coding agents build Mantle apps with the version-matched skill, `mantle help`
and the compiler's diagnostics; at runtime, AI agents call the app's Model
Context Protocol server at `/mcp` and `/mcp/admin`. `/mcp` serves the tools your
public MCP Triggers expose, and `/mcp/admin` serves admin tools to admin roles.
Each call keeps its declared authorization, row policy and input checks. See
[MCP and agents](docs/handbook/concepts/mcp-and-agents.md).

### Can Mantle serve `llms.txt`, a sitemap and Markdown pages?

Yes. The generated `web()` module reads public Views and serves `/llms.txt`,
`/sitemap.xml`, `.md` Markdown alternates and canonical head tags. SQL controls
what is visible, so unpublished drafts stay out. Your app owns the HTML. For
page layouts, JSON-LD and languages, see
[Public pages: SEO, AEO and languages](docs/handbook/guides/public-pages.md).

### Does Mantle run migrations?

No. Apply the generated `schema.sql` to an empty database for the first
install. After that, migrations belong to the application and its native tool.

## Documentation

- [Handbook](docs/handbook/start/overview.md) — concepts, setup, and task guides.
- [Build with an agent](docs/handbook/start/agents.md) — `mantle init`, `mantle help` and role-only acceptance.
- [Public pages: SEO, AEO and languages](docs/handbook/guides/public-pages.md) — `llms.txt`, sitemap, Markdown alternates, JSON-LD and hreflang.
- [Manifest feature reference](docs/handbook/reference/features.md) — capabilities and their authoring fields.
- [SDK and package API](packages/mantle/README.md) — installation, typed bindings, and optional modules.
- [Examples](docs/examples/README.md) — whole services, and the runnable reference service.
- [Upgrading from 0.1.x](docs/upgrade-0.1-to-0.2.md) — for a coding agent doing the move.
- [Releases](https://github.com/aotter/mantle/releases) — changes and upgrade notes.

## Contributing

See [Contributing](CONTRIBUTING.md) for development and review,
[Support](SUPPORT.md) for questions and bugs, and [Security](SECURITY.md) for
private vulnerability reports. Contributors follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

Apache 2.0. See [LICENSE](LICENSE).
