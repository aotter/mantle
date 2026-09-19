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
  <a href="#make-a-world-from-four-atoms">Quick start</a>
  &middot;
  <a href="#paste-ready-agent-prompts">Agent prompts</a>
  &middot;
  <a href="#a-custom-mcp-server-without-building-the-server">Features</a>
  &middot;
  <a href="#one-manifest-one-contract">Manifest</a>
  &middot;
  <a href="#packages">Packages</a>
  &middot;
  <a href="#develop-with-mantle">Develop</a>
  &middot;
  <a href="#cli-reference">CLI</a>
</p>

<p>
  <sub><strong>Prerelease:</strong> APIs and manifests may change between alpha releases. Treat the installed package's version-matched docs as the contract and review generated code before production use.</sub>
</p>

## Make a world from four atoms

Paste this into a terminal. It writes one complete Manifest, validates it, and
generates the typed runtime binding—no repository clone or global install.

```sh
mkdir -p mantle-hello/manifests && cd mantle-hello
cat > manifests/requests.yaml <<'YAML'
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: requests }
spec:
  title: Requests
  lifecycle: operational
  schema:
    type: object
    additionalProperties: false
    required: [name, message]
    properties:
      name: { type: string, minLength: 1 }
      message: { type: string, minLength: 1 }
      createdAt: { type: number, x-mantle-bind: now }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: recent-requests }
spec:
  surface: staff
  from: requests
  fields: [id, name, message, createdAt]
  orderBy: [{ field: createdAt, direction: desc }]
  limit: 50
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: submit-request }
spec:
  input:
    type: object
    additionalProperties: false
    required: [name, message]
    properties:
      name: { type: string, minLength: 1 }
      message: { type: string, minLength: 1 }
  output: { type: object }
  handler: { kind: builtin, op: create, schema: requests }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: submit-request-http }
spec:
  source: { kind: http, method: POST, path: /api/requests }
  target: { procedure: submit-request }
YAML

bunx --package @aotter/mantle@alpha mantle validate --no-source --format text
bunx --package @aotter/mantle@alpha mantle generate
```

Using npm? The runner is the only difference:

```sh
npx --yes --package=@aotter/mantle@alpha mantle validate --no-source --format text
```

# Agent-built. Agent-operated.

AI can build a convincing interface. The harder problem is the contract under
it—and the operating surface left after launch.

Describe Schema, View, Procedure, and Trigger once. Mantle links and validates
them into one RuntimePlan for typed TypeScript, REST, OpenAPI, MCP, Web, and
Admin. Coding agents build with it; operation agents run it through governed
tools. It stays inside your application, with your storage, auth, queues, and
lifecycle.

## Author your application

Mantle scales. Take only the surfaces you need — Admin is opt-in.

1. **Minimal — Spec + generate.** Write manifests, then `mantle generate` /
   `validate`. Embed the typed binding in an existing host. No Admin, no
   visitor UI.
2. **Runtime / adapter.** Bind Runtime through a Worker or another adapter.
   HTTP Views, MCP, and Auth run without a Dev UI. The
   [minimal Worker reference](docs/examples/host-minimal-worker/README.md) is
   this path.
3. **Opt-in — Admin / Dev UI.** When humans need a console, add
   `@aotter/mantle-admin` + `@aotter/mantle-admin-ui`, bind wrangler `ASSETS`,
   and sign in at `/admin/sign-in` with email OTP from wrangler logs. The
   [local Admin OTP reference](docs/examples/host-local-admin-otp/README.md) is
   that optional full path.

`bunx --package @aotter/mantle@alpha mantle --help` is the layered overview. Give the version-matched
install skill to a coding agent; it must interview for required surfaces
and not assume Admin.

Other hosts embed the same [manifest contract](#one-manifest-one-contract).

## Paste-ready agent prompts

Copy one block into a coding agent. Resolve handbook pages and official
examples from `docs/` in this checkout, or from
`node_modules/@aotter/mantle/docs/` after install. If neither tree exists,
pin `@aotter/mantle` first. `bunx mantle --help` is the layered
overview. There is no `mantle create`. Admin is opt-in.

### Spec / embed only

```text
Read handbook/start/project-and-cli.md and bunx mantle --help.
Pin @aotter/mantle at the exact version we agree, author manifests for
this existing host, then run mantle generate and mantle validate. Embed
the typed binding from .mantle/generated/mantle.ts into the current
system. Do not add Admin, mantle-admin-ui, a visitor frontend, or a
Cloudflare adapter unless I ask. Do not invent a default Schema.
```

### Minimal API service locally

```text
Read handbook/start/quickstart-worker.md and examples/host-minimal-worker/.
Author a Cloudflare Worker from that official example or from scratch:
one Schema, one public View (copy the contract, not the tree wholesale).
Pin every @aotter/mantle* package to the same exact version. Run
pnpm install && pnpm generate && pnpm dev (or wrangler dev --local).
Probe GET /api/views/<name> with curl. GET / may 404. Do not install
Admin or wrangler ASSETS unless I ask.
```

### Full local Dev UI (opt-in)

```text
I want the optional Admin / Dev UI. Read handbook/start/quickstart-admin.md
and examples/host-local-admin-otp/. Interview me for a bootstrap owner email.
Install @aotter/mantle-admin and @aotter/mantle-admin-ui, run
mantle generate (it syncs the prebuilt SPA — do not vite-build), and set
wrangler assets.directory=./public with binding ASSETS (required when
Admin is installed). Wire createAuth email-otp + ConsoleEmailSender.
Then pnpm install && pnpm generate && pnpm dev, open /admin/sign-in, and
read the OTP from wrangler logs. If /admin is a white screen, fetch
/_mantle/admin/assets/* — 404 means ASSETS is missing, not a missing
frontend build.
```

### Interview then build

```text
Interview me about the service: host, who uses it, whether humans need a
Dev UI, and whether we only embed Spec/Runtime. Read mantle --help, then
handbook/start/project-and-cli.md. Use docs/examples/README.md as the
examples index; copy builtin-* Manifests only (not cf-primitives-*).
Implement locally first. Take only the surfaces we chose.
If we skip Admin, follow examples/host-minimal-worker/. If we want Dev UI,
follow examples/host-local-admin-otp/. No mantle create. Pin all
@aotter/mantle* packages to one exact version.
```

### Later layer: MCP or public web (opt-in)

```text
Do not add Admin unless it is already in this project. Read
handbook/concepts/mcp-and-agents.md and/or
handbook/cloudflare/public-web.md. Add only the surface I name: MCP
Triggers at /mcp or /mcp/staff, or optional @aotter/mantle-web
composition. Keep Core adapter-neutral. Probe the new route; do not
claim Auth or Admin works from a public 200.
```

## A custom MCP server, without building the server

Views become read tools. Procedures backed by your own handlers become typed
action tools when exposed by MCP Triggers. At `/mcp/staff`, authorized teammates
can operate queues, Slack, email, ERP, CRM, or anything else your handler can
reach—without maintaining a second MCP server or schema.

## Agent-discoverable and i18n-ready, built in

Enable the optional Web surface and every public page gets a predictable path
and Markdown mirror in every locale:

```text
/en/posts/hello
/en/posts/hello.md
/zh-tw/posts/hello
```

Mantle also emits `llms.txt`, sitemap, canonical links, hreflang, JSON-LD, and
social metadata from the same published state.

## Application patterns

Compose the four atoms for your actual business flow. Start at the
[Examples hub](docs/examples/README.md). Durable Object, Queue and payment
coordination notes live in
[Commerce inventory](docs/examples/cf-primitives-commerce-inventory.md), without a second
launch product or a preset catalog.

## Publishing and operations in one Admin

Publishing content gets draft, publish, unpublish, and archive. Operational
records such as orders, inventory, and reservations stay live without a fake
publishing state machine. Add the optional Admin API and React SPA when humans
need the same controls; editorial review and approval are coming soon.

![Mantle Admin connects staff agents through MCP while keeping publishing content, live records, reports, and human operators in one console.](docs/assets/mantle-admin-operations.png)

## Open source, host-owned, ready to ship

Apache-2.0 Core runs inside your process, with the raw Runtime and handler
context available for transactions, queues, media, and platform capabilities.
Use Bun, Vercel, Cloudflare, or your own adapter. Small Cloudflare sites can fit
within its [Workers](https://developers.cloudflare.com/workers/platform/pricing/)
and [D1](https://developers.cloudflare.com/d1/platform/pricing/) free limits.

## One manifest, one contract

1. Describe your project in `manifests/reservations.yml`:

   ```yaml
   # excerpt — see the complete manifest reference below
   apiVersion: cms.mantle.aotter.net/v1
   kind: Schema
   metadata:
     name: slots
   spec:
     title: Slots
     lifecycle: operational
     schema:
       type: object
       properties:
         state: { type: string, enum: [available, reserved] }
         # ...
   ---
   apiVersion: cms.mantle.aotter.net/v1
   kind: View
   metadata:
     name: available-slots
   spec:
     surface: public
     from: slots
     filter:
       eq: { field: state, value: available }
     # ...
   ---
   apiVersion: cms.mantle.aotter.net/v1
   kind: Procedure
   metadata:
     name: request-reservation
   spec:
     input:
       type: object
       required: [slotId, email]
       properties:
         slotId: { type: string }
         email: { type: string, format: email }
       # ...
     output:
       type: object
       properties:
         queued: { type: boolean }
     handler: { kind: ref, ref: queue-reservation-request }
   ---
   apiVersion: cms.mantle.aotter.net/v1
   kind: Trigger
   metadata:
     name: request-reservation-mcp
   spec:
     source: { kind: mcp, surface: public }
     target: { procedure: request-reservation }
   ```

   See the [complete manifest reference](docs/handbook/reference/manifest.md) for the full syntax.

2. Install Mantle and generate the typed runtime binding:

   ```bash
   bun add @aotter/mantle@alpha
   bunx mantle generate
   ```

3. Give the generated binding your
   [storage adapter](docs/adapter-guide.md):

   ```ts
   import {
     createMantle,
     type MantleHandlers,
   } from "./.mantle/generated/mantle.js";

   interface Env {
     RESERVATION_QUEUE: {
       send(message: { slotId: string; email: string }): Promise<void>;
     };
   }

   const handlers = {
     "queue-reservation-request": async ({ slotId, email }, ctx) => {
       await ctx.env.RESERVATION_QUEUE.send({ slotId, email });
       return { queued: true };
     },
   } satisfies MantleHandlers<Env>;

   const mantle = await createMantle({ storage, handlers });

   // The `available-slots` View becomes a typed lower-camel property.
   const slots = await mantle.views.availableSlots();
   ```

4. That's it: the View is a typed query and the Procedure is your typed
   handler. The Trigger becomes an MCP tool when mounted by an MCP-capable
   adapter. Platform adapters own lifecycle policy, while `mantle.runtime`
   keeps lower-level capabilities within reach.

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

## Develop with Mantle

### Human engineers

Human engineers get the same direct path: ordinary YAML in, ordinary
TypeScript APIs out.

```bash
bun add @aotter/mantle@alpha
```

Author and review manifests directly, use Spec without Runtime, implement
semantic ports over existing storage, or compose generated bindings and
optional packages. The [umbrella package README](packages/mantle/README.md) is
the installed API guide; adapter authors start with the
[adapter guide](docs/adapter-guide.md).

Keeping an existing framework and CMS? Start with the
[Spec-only host adoption example](docs/spec-only-host-adoption.md): reuse
schemas and validation without installing Runtime or replacing your admin UI.

### Coding agents

This repository has a second entrance: it is an installable agent plugin bundle
for Claude Code, Codex, Cursor, and GitHub Copilot. The plugin carries
version-matched Mantle workflows; it is an authoring aid, not a Runtime
dependency.

Use an immutable tag matching the installed package version:

```bash
# Claude Code — run as two separate prompts
/plugin marketplace add aotter/mantle@v<installed-version>
/plugin install mantle@mantle

# Codex
codex plugin marketplace add aotter/mantle --ref v<installed-version>
codex plugin add mantle@mantle
```

Cursor and GitHub Copilot discover their plugin manifests when this repository
is cloned or opened. See [`skills/README.md`](skills/README.md) for host details.

- **Repository plugin:** teaches an agent to create and maintain Mantle
  projects.
- **`mantle skills`:** projects the installed package's exact project-scoped
  workflows into a consumer repository. Each skill declares its own scope, so
  destructive and platform-specific ones stay opt-in.

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

Run commands through the project's package manager, for example
`bunx mantle generate`.

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
