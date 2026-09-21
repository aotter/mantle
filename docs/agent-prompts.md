# Task-specific agent prompts

Cold start from GitHub or a marketplace host is one pinned skill:

```sh
npx skills add aotter/mantle@v0.1.2 --skill install
```

Copy one block into a coding agent after that skill is present. Paths below
are relative to the Mantle docs root: `node_modules/@aotter/mantle/docs/`
after `@aotter/mantle` is installed, or `docs/` in the installed agent plugin.
`npx --no-install mantle --help` is the layered CLI overview; it mirrors the
authoring docs. A live `/mcp` catalog mirrors the Manifest → RuntimePlan, not
the CLI. Interview first. Worker is the default host unless the user names
ChatGPT Sites. There is no `mantle create`. Empty `generate` fails until
manifests exist. Admin is opt-in.

### Interview then build

```text
Interview me about the service: host, who uses it, whether humans need a
Dev UI, and whether we only embed Spec/Runtime. If the install skill is
missing, run npx skills add aotter/mantle@v0.1.2 --skill install. Read the
install skill and npx --no-install mantle --help, then
handbook/start/project-and-cli.md.
Use examples/README.md as the examples index; copy builtin-* Manifests only
(not cf-primitives-*). Implement locally first. Take only the surfaces we
chose. For Spec-only use, skip Runtime and code generation. For a Worker
without Admin, follow examples/host-minimal-worker/. For a Worker with
Dev UI, follow examples/host-local-admin-otp/README.md. ChatGPT Sites only
if I name that host. No mantle create. Pin all @aotter/mantle* packages
to one exact version.
```

### Embed Runtime with typed APIs

```text
Read handbook/start/project-and-cli.md and npx --no-install mantle --help.
Pin @aotter/mantle at the exact version we agree, author manifests for
this existing host, then run mantle generate. Embed
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
I want the optional Admin / Dev UI. Read examples/host-local-admin-otp/README.md
(the procedural SSOT) and the thin pointer at handbook/start/quickstart-admin.md.
Interview me for a bootstrap owner email, then follow that example locally.
Prefer 127.0.0.1 over localhost. After pnpm check / smoke, restore .dev.vars
from .dev.vars.example before pnpm dev.
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

### Mantle on ChatGPT Sites, including media

Use only when the user names ChatGPT Sites as the host.

```text
Build with ChatGPT Sites; use Mantle for content management and publishing.
Read handbook/sites/index.md and examples/host-chatgpt-sites/README.md.
Use that runnable host as a reference and install its pinned
dependencies from the registry. Derive Schema, View,
Procedure and Trigger from my requirements and check the Admin editor/picker and public
projections against them. Request both Sites D1 and R2 when my workflow
includes uploads. Bind the R2 media port, declare media.purposes, and keep
the same-origin PUT and committed-only public GET checks. Pin every
@aotter/mantle* dependency to one exact version. Run the local smoke,
show a draft-to-publish walkthrough, then save and deploy through Sites when
requested. Verify the deployed owner/member role, R2 upload, published page, and anonymous draft 404. Treat public read-only
MCP, Admin WebMCP, and staff OAuth MCP as separate acceptance gates; never
claim staff MCP from a working browser session or connector URL alone.
```


[Back to the Core README](../README.md#for-engineers-and-agents).
