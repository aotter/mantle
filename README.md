<h1 align="center">Mantle</h1>

<p align="center">
  <em>Be the dungeon master. Don’t code every corridor.</em>
</p>

<p align="center">
  <img src="docs/assets/mantle-hero.jpg" width="900" alt="A dungeon master invokes four runes while a living shell labyrinth assembles itself; an unused pickaxe lies nearby.">
</p>

<p align="center">
  <strong>Schema. View. Procedure. Trigger. Four atoms from which your world takes shape.</strong><br>
  Speak it in plain YAML, and the dungeon wakes—whole, lit from within, and yours to command.
</p>

<p align="center">
  <a href="https://github.com/aotter/mantle/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/aotter/mantle/ci.yml?branch=develop&style=flat-square&label=build"></a>
  <a href="https://github.com/aotter/mantle/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/aotter/mantle?style=flat-square&color=0b7285&label=stars"></a>
  <a href="https://www.npmjs.com/package/@aotter/mantle"><img alt="npm alpha" src="https://img.shields.io/npm/v/@aotter/mantle/alpha?style=flat-square&label=npm&color=0b7285"></a>
  <a href="https://github.com/aotter/mantle/releases"><img alt="GitHub prerelease" src="https://img.shields.io/github/v/release/aotter/mantle?include_prereleases&sort=semver&style=flat-square&label=release&color=0b7285"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/node-%3E%3D22-0b7285?style=flat-square&logo=nodedotjs&logoColor=white"></a>
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-0b7285?style=flat-square"></a>
</p>

<p align="center">
  <a href="#start-with-a-manifest">Quick start</a>
  &middot;
  <a href="#for-engineers-and-agents">Agent prompts</a>
  &middot;
  <a href="#what-you-can-build">Features</a>
  &middot;
  <a href="docs/examples/README.md">Examples</a>
  &middot;
  <a href="#packages">Packages</a>
  &middot;
  <a href="#choose-how-much-to-use">Adoption</a>
  &middot;
  <a href="#cli-reference">CLI</a>
</p>

<p>
  <sub><strong>Prerelease:</strong> APIs and manifests may change between alpha releases. Treat the installed package's version-matched docs as the contract and review generated code before production use.</sub>
</p>

Mantle is an embeddable manifest engine: describe data, queries, actions, and
triggers in YAML, then use the same contract in your application, APIs, and
tools for humans and agents.

## Start with a Manifest

Put your Manifest ([example](docs/examples/builtin-intake.md#manifest)) in
`manifests/`, then run from your project root:

```sh
bunx @aotter/mantle@alpha generate
# or
npx @aotter/mantle@alpha generate
```

Mantle validates your Manifest and generates `.mantle/generated/mantle.ts`:
a compiled execution plan, TypeScript types, and typed APIs. Use them to query
data and run actions inside your application, expose HTTP endpoints and MCP
tools through supported adapters, or power a publishing site and staff console
with optional Web and Admin packages. Start with what you need; each surface
uses the same contract.

The [intake example](docs/examples/builtin-intake.md) defines request records,
a submission action, and a staff inbox—then exposes submission through HTTP
and MCP when connected to a supporting host. See the
[minimal Worker](docs/examples/host-minimal-worker/README.md) for a runnable host.

Generation produces code, not a running service. To use the generated module,
install `@aotter/mantle` in your application and connect storage and any custom
handlers. Use an official storage adapter or implement the
[storage ports](docs/adapter-guide.md). For an ongoing project, pin Mantle
packages to the same exact version and use their installed documentation.

## Choose how much to use

These are independent adoption choices, not mandatory stages.

| Use what you need | What it gives you |
|---|---|
| **Spec only** | Parse, validate, and link definitions inside an existing system. No Runtime or code generation required. [Example](docs/spec-only-host-adoption.md). |
| **Runtime + typed APIs** | Execute queries and actions with your storage adapter and handlers. Generated `createMantle` and `bindMantle` expose typed entry, View, and Procedure calls. [API guide](packages/mantle/README.md). |
| **A host adapter** | Run on Bun, Vercel, or Cloudflare and expose the adapter's supported transports. Choose an adapter for the HTTP, MCP, and auth capabilities you need. [Adapter guide](docs/adapter-guide.md). |
| **Web** | Render public content as HTML and Markdown, with localization and discovery metadata. [Web](packages/mantle-web/README.md). |
| **Admin** | Give staff a console for content and operational records. Admin API and the prebuilt UI are optional. [Local example](docs/examples/host-local-admin-otp/README.md). |

The plan carries the compiled Schema, View, Procedure, and Trigger definitions.
Runtime executes them; adapters and optional packages connect them to the
surfaces you choose. Your application owns its host, storage, and deployment.

## What you can build

- **APIs and agent tools.** Views provide reads; Procedures provide actions,
  using builtin mutations or your own handlers. MCP-capable hosts expose
  Views and MCP Triggers as tools, with authorization for staff operations.
  [MCP and agents](docs/handbook/concepts/mcp-and-agents.md).
- **Publishing and public sites.** Draft, publish, unpublish, and archive
  content. Add Web for localized HTML and Markdown, `llms.txt`, sitemap,
  canonical links, hreflang, JSON-LD, and social metadata.
  [Publication example](docs/examples/builtin-publication.md).
- **Operational applications.** Keep orders, reservations, and requests live
  without a publishing workflow. Add Admin when staff need a console.
  [Commerce](docs/examples/builtin-commerce.md),
  [reservations](docs/examples/builtin-reservation.md), and
  [procurement](docs/examples/builtin-procurement.md).
- **Custom business workflows.** Connect handlers to queues, email, payments,
  or existing services; use guards and lifecycle hooks where the operation
  requires them. [Intake hooks](docs/examples/cf-primitives-intake-hooks.md)
  and [inventory coordination](docs/examples/cf-primitives-commerce-inventory.md).

![Mantle Admin connects staff agents through MCP while keeping publishing content, live records, reports, and human operators in one console.](docs/assets/mantle-admin-operations.png)

The [Examples hub](docs/examples/README.md) contains complete Manifests and
host references. The [Manifest reference](docs/handbook/reference/manifest.md)
defines the four atoms and their fields.

## For engineers and agents

Engineers can start with the [installed API guide](packages/mantle/README.md),
[adapter guide](docs/adapter-guide.md), or
[direct authoring guide](docs/handbook/start/project-and-cli.md).

Coding agents use the same APIs and version-matched
[skills](skills/README.md). A short starting prompt:

```text
Read the installed @aotter/mantle docs and install skill. Ask which host,
storage, and surfaces this application needs. Preserve the existing
application, choose an official example, and implement locally.
Pin all Mantle packages to the same exact version. Verify the selected
surfaces; add Web, Admin, or MCP only when needed.
```

See [task-specific agent prompts](docs/agent-prompts.md) for embedding,
Worker, Admin, and later surface additions. The
[plugin and skills guide](skills/README.md) covers agent integration;
`mantle skills` projects version-matched application skills after installation.
For ChatGPT Sites with D1, R2 media and Admin, start with the
[runnable Sites host reference](docs/examples/host-chatgpt-sites/README.md)
and adapt its example manifest to the user's business rules.

## Packages

Start with `@aotter/mantle`. Spec and Runtime form the portable Core;
everything else is opt-in.

| Package | Adds |
|---|---|
| `@aotter/mantle` | CLI, codegen, and default exports. |
| `@aotter/mantle-spec` | Standalone validation and introspection. |
| `@aotter/mantle-runtime` | Custom runtime and storage integration. |
| `@aotter/mantle-web` | HTML, Markdown, `llms.txt`, and sitemap. |
| `@aotter/mantle-admin` | Admin API. |
| `@aotter/mantle-admin-ui` | Prebuilt React Admin SPA. |
| `@aotter/mantle-bun` | Bun and `bun:sqlite`. |
| `@aotter/mantle-indexeddb` | Browser-local IndexedDB storage. |
| `@aotter/mantle-vercel` | Vercel Functions. |
| `@aotter/mantle-cloudflare` | Workers, D1, Auth, MCP, Web, and Admin. |

Mantle is named for the living tissue that grows a mollusk's shell: it adds
structure around the application you already own.

## CLI reference

The umbrella provides one `mantle` command set. Top-level `mantle --help`
is a layered overview of optional surfaces (Admin is opt-in); subcommand
help stays on that layer. There is no `create` / `update` happy path.

| Command | Purpose |
|---|---|
| `mantle generate` | Compile manifests into a sealed plan and typed runtime module. |
| `mantle generate --check` | Fail without writing when generated code or optional Admin assets are stale. |
| `mantle validate` | Validate manifests and handler-source references. |
| `mantle emit-openapi` | Emit OpenAPI 3.1 from HTTP Triggers and View routes. |
| `mantle skills` | Project version-matched Core skills into the consumer repository. |

Run the installed CLI through your project's package manager, for example
`npx --no-install mantle generate`. `validate` also scans `src/` for handler
references; use `--no-source` when checking only the Manifest.

Advanced manifest primitives remain in the direct `@aotter/mantle-spec`
package: `mantle-spec introspect` and `mantle-spec emit-types`.

`generate` writes one `.mantle/generated/mantle.ts` module containing the
sealed plan, generated types, `createMantle`, and `bindMantle`. When
`@aotter/mantle-admin-ui` is installed, it also syncs the Admin SPA to
`public/_mantle/admin/`. It does not change styling, project skills, provision
providers, or deploy the application.

## Contributing

- [`CONTRIBUTING.md`](CONTRIBUTING.md) is the contributor and architecture
  authority for humans and agents.
- [`docs/adr/`](docs/adr/) records accepted, path-dependent decisions.
- [`docs/release-process.md`](docs/release-process.md) governs releases.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) defines community behavior.
- [`SUPPORT.md`](SUPPORT.md) routes questions, bugs, and feature requests.
- [`SECURITY.md`](SECURITY.md) provides the private vulnerability-reporting path.
- [GitHub Releases](https://github.com/aotter/mantle/releases) is the canonical
  public change history.

Apache 2.0. See [`LICENSE`](LICENSE).
