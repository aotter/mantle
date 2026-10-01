---
description: Create a Mantle 0.2.0 service on Cloudflare Workers from an empty directory, run it locally, then add sign-in, Admin and MCP.
---
# Quickstart: a service on Cloudflare Workers

From an empty directory to a running service with a public View and a write.
You need Node 22 or later and a package manager (pnpm is used below).

## 1. Create the project

```sh
mkdir notes && cd notes
pnpm init
npm pkg set type=module
npm view @aotter/mantle dist-tags
```

Pick a `0.2.x` version from the output. While 0.2.0 is in prerelease it is
on the `alpha` tag, and `latest` still names 0.1.x. Install it with an exact
version:

```sh
pnpm add --save-exact @aotter/mantle@<0.2.x version>
pnpm add -D wrangler @cloudflare/workers-types @types/node typescript
```

## 2. Write a manifest

`manifests/notes.yaml`:

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: notes }
spec:
  title: Notes
  lifecycle: operational
  schema:
    type: object
    required: [text]
    properties:
      text: { type: string, minLength: 1, maxLength: 500 }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: latest-notes }
spec:
  surface: public
  sql: SELECT id, text, created_at FROM notes ORDER BY created_at DESC LIMIT 20
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: add-note }
spec:
  input:
    type: object
    required: [text]
    properties:
      text: { type: string, minLength: 1, maxLength: 500 }
  output: { type: object }
  handler:
    sql: INSERT INTO notes (text) VALUES (input.text) RETURNING id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: add-note-http }
spec:
  source: { kind: http, method: POST, path: /api/notes }
  target: { procedure: add-note }
```

## 3. Generate

Start with the smallest selection: no identity (every caller is anonymous)
and only the REST surface.

```sh
pnpm exec mantle generate --identity none --features web
```

It writes `.mantle/generated/plan.json` and `mantle.ts`, `mantle.config.json`,
and once, the preset: `src/service.ts`, `src/index.ts`, `src/handlers.ts`,
`wrangler.jsonc`, `tsconfig.json` and `.gitignore`. Commit all of them,
`.mantle/generated` included.

## 4. Run it

```sh
pnpm exec wrangler dev --local
```

On the first request the runtime creates the tables on the local D1 database.
Then:

```sh
curl -sS -X POST http://127.0.0.1:8787/api/notes -H 'content-type: application/json' -d '{"text":"hello"}'
curl -sS http://127.0.0.1:8787/api/views/latest-notes
```

The write answers `{ "results": [[{ "id": "…" }]] }` and the View
`{ "rows": [{ "id": "…", "text": "hello", "created_at": … }] }`.

## 5. Add sign-in, Admin and MCP

The full selection is identity `mantle` (Better Auth sign-in, staff roles,
OAuth for MCP) and the features `mcp`, `admin` and `web`. A rerun cannot
switch identity, and the preset is never rewritten, so start a project that
needs them with the full selection instead:

```sh
pnpm exec mantle generate
```

With no flags the selection is identity `mantle` and every feature. The first
run names the packages it needs, with the install command, and writes nothing
until they are installed:

```sh
pnpm add better-auth @better-auth/oauth-provider @better-auth/mcp @better-auth/cimd \
  @modelcontextprotocol/server @modelcontextprotocol/ext-apps @aotter/mantle-ui
pnpm exec mantle generate
cp .dev.vars.example .dev.vars   # set ADMIN_EMAIL and a random BETTER_AUTH_SECRET
pnpm exec wrangler dev --local
```

Request a code for `ADMIN_EMAIL` (`POST /api/auth/email-otp/send-verification-otp`
with `{ "email": …, "type": "sign-in" }`). The code is printed to the wrangler
log, and that email becomes the owner. Codes in the log are for local
development only; [Authentication](../cloudflare/authentication.md) covers
production sign-in.

Or open `/admin/sign-in` in a browser: the console is served at `/admin` from
`@aotter/mantle-ui/admin`, which the generated `wrangler.jsonc` binds as the
Worker's `ASSETS`. Admin's API answers at `/admin/api/*`, the public MCP
surface at `/mcp`, and the staff MCP surface at `/admin/api/mcp`. The
[reference service](../../examples/reference-service/README.md) is this
selection with a smoke test that signs in and drives every surface.

## Next

- [Project layout and CLI](./project-and-cli.md): what each generated file is,
  and `mantle generate --check`.
- [Writes: Procedures, Triggers and hooks](../concepts/procedures-and-triggers.md)
  and [Reads: Views, REST and MCP](../concepts/views.md).
- [Deploy and operate](../cloudflare/deploy-and-operate.md).
