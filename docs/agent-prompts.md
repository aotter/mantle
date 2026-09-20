# Task-specific agent prompts

Copy one block into a coding agent. Resolve handbook pages and official
examples from `docs/` in this checkout, or from
`node_modules/@aotter/mantle/docs/` after install. If neither tree exists,
pin `@aotter/mantle` first. `npx --no-install mantle --help` is the layered
overview. There is no `mantle create`. Admin is opt-in.

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
For Spec-only use, skip Runtime and code generation. For a Worker without
Admin, follow examples/host-minimal-worker/. For a Worker with Dev UI,
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

### Mantle on ChatGPT Sites, including media

```text
Read the installed docs/handbook/cloudflare/chatgpt-sites.md and
docs/examples/host-chatgpt-sites/README.md. Use that runnable host as a
reference, not as the business manifest: derive Schema, View, Procedure and
Trigger from my requirements and check the Admin editor/picker and public
projections against them. Request both Sites D1 and R2 when my workflow
includes uploads. Bind the R2 media port, declare media.purposes, and keep
the same-origin PUT and committed-only public GET checks. Pin every
@aotter/mantle* dependency to one exact version. Run the local smoke,
save and deploy through Sites, then verify the deployed owner/member role,
R2 upload, published page, and anonymous draft 404. Treat public read-only
MCP, Admin WebMCP, and staff OAuth MCP as separate acceptance gates; never
claim staff MCP from a working browser session or connector URL alone.
```


[Back to the Core README](../README.md#for-engineers-and-agents).
