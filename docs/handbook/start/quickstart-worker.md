---
description: Scaffold an app with `mantle init`, run it on a local D1, sign in and add manifests; or mount generated REST in your own Worker.
---
# Quickstart: an app on Workers

Use Node.js 22.22 or newer and pnpm 9 or newer. In an empty directory:

```sh
npx @aotter/mantle@alpha init .
pnpm install
```

`@alpha` fetches the current prerelease ([Releases](../releases/index.md)); `init` pins every Mantle package in
`package.json` to that exact version, and `pnpm exec mantle help` prints that version's handbook.

`init` writes the app once, with `src/index.ts` as its entry: email-code sign-in with `admin` and `user` roles, Admin at
`/admin`, MCP at `/mcp` and `/mcp/admin`, generated REST, a member `/sign-in` page and the local acceptance kit. It writes
no visitor pages, so `/`, `/sitemap.xml`, `/robots.txt` and `/llms.txt` return 404 until you add them in `src/routes.ts`
([public pages](../guides/public-pages.md)).

## Add a manifest

`pnpm generate` compiles every `manifests/*.yaml` and stops when there is none. Save `manifests/tickets.yaml`: a Schema,
a public View, an admin Procedure that opens a ticket, and the Trigger that offers it on admin MCP.

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: tickets }
spec:
  title: Tickets
  lifecycle: operational
  indexes: [[ticketState]]
  schema:
    type: object
    additionalProperties: false
    required: [subject, ticketState]
    properties:
      subject: { type: string }
      ticketState: { type: string, enum: [open, closed] }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: tickets-by-state }
spec:
  surface: public
  input:
    type: object
    additionalProperties: false
    required: [ticketState]
    properties:
      ticketState: { type: string, enum: [open, closed] }
  sql: |
    SELECT id, subject, ticketState AS "ticketState" FROM tickets
    WHERE ticketState = input.ticketState
    ORDER BY id ASC
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: open-ticket }
spec:
  title: Open a ticket
  requires: { auth: { all: [ctx.admin] } }
  uiSchema: { collectionAction: tickets }
  input:
    type: object
    additionalProperties: false
    required: [subject]
    properties:
      subject: { type: string, minLength: 1 }
  output: { type: object }
  handler:
    sql: |
      INSERT INTO tickets (subject, ticketState) VALUES (input.subject, 'open')
      RETURNING id, subject, version
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: open-ticket-mcp }
spec:
  source: { kind: mcp, surface: admin }
  target: { procedure: open-ticket }
```

## Generate and check

```sh
pnpm generate   # writes generated/ and lists any handler: { ref } to implement in src/handlers.ts
pnpm types      # writes worker-configuration.d.ts from wrangler.jsonc
pnpm check      # generate --check, wrangler types --check and tsc
```

## Run it locally

```sh
cp .dev.vars.example .dev.vars
pnpm db:init    # applies generated/schema.sql to the empty local D1
pnpm dev        # http://127.0.0.1:8787; one-time sign-in codes print to this log
```

In `.dev.vars`, set `ADMIN_EMAIL` to your address and `BETTER_AUTH_SECRET` to a random value (for example
`openssl rand -hex 32`). The first verified sign-in with `ADMIN_EMAIL` becomes the admin. Never deploy these values.

## Sign in

Open `http://127.0.0.1:8787/admin`, enter `ADMIN_EMAIL`, and type the code from the `pnpm dev` log
(`you@example.com: one-time code is 123456`). Admin lists **Tickets**.

The same sign-in from a terminal, then a call to the admin Procedure and the public View:

```sh
O=http://127.0.0.1:8787
curl -c jar -H 'content-type: application/json' -H "origin: $O" \
  -d '{"email":"you@example.com","type":"sign-in"}' $O/api/auth/email-otp/send-verification-otp
CODE=123456   # from the pnpm dev log
curl -c jar -b jar -H 'content-type: application/json' -H "origin: $O" \
  -d "{\"email\":\"you@example.com\",\"otp\":\"$CODE\"}" $O/api/auth/sign-in/email-otp
curl -b jar -H "origin: $O" $O/admin/api/me
curl -b jar -H 'content-type: application/json' -H "origin: $O" \
  -d '{"subject":"Printer is jammed"}' $O/admin/api/operations/open-ticket
curl "$O/api/views/tickets-by-state?ticketState=open"
```

`/admin/api/me` reports `"admin": true`. The View is public, so the last request needs no session; it returns
`{ rows, nextCursor? }` with the new ticket.

## Next

Add Schemas, Views, Procedures and Triggers as more files in `manifests/` ([four atoms](../concepts/four-atoms.md);
patterns in `mantle help examples`), then `pnpm generate`. Visitor pages, webhooks and callbacks go in `src/routes.ts`.
The app's `README.md` covers handlers, seed data, `pnpm smoke` and `pnpm accept`. Before deploying, choose how users
sign in ([email code, GitHub, or email and password](../cloudflare/sign-in-methods.md)): the console code sender works
only locally. Then follow [before the first deploy](../cloudflare/deploy-and-operate.md#before-the-first-deploy).

## Without init: mount generated REST in your own Worker

An app that keeps its own entry skips `init` and runs only `generate`. Install one exact `@aotter/mantle` version,
TypeScript, Wrangler and `@cloudflare/workers-types`; `node_modules/@aotter/mantle/docs/examples/app-shell/package.json`
lists the versions that release is tested with. With the same `manifests/tickets.yaml`:

```sh
pnpm exec mantle generate cloudflare-d1 generated manifests/tickets.yaml
```

Without a Wrangler config, `generate` creates `wrangler.jsonc` with the split build (`mantle bundle src/worker.ts dist`);
set its `name` and add a D1 binding `DB`. Write `src/worker.ts` and typecheck it with `@cloudflare/workers-types` in
your `tsconfig.json`:

```ts
import { rest } from '../generated/rest.js';
interface Env { DB: D1Database }
const api = rest<Env>({
  db: env => env.DB,
  caller: () => ({ kind: 'anonymous' }),
});
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await api(request, env) ?? new Response('Not found', { status: 404 });
  },
};
```

```sh
pnpm exec mantle generate cloudflare-d1 generated manifests/tickets.yaml --check
pnpm exec wrangler d1 execute <database> --local --file generated/schema.sql
pnpm exec wrangler dev --local
```

Once `src/worker.ts` exists, `generate` warns that it never imports `generated/mcp.ts`; that is expected for a REST-only
Worker. `/api/views/tickets-by-state?ticketState=open` returns `{ rows: [] }` from the empty database. This Worker
mounts no auth, so the admin Procedure is not reachable. Commit generated files and Wrangler edits; keep `dist/`
untracked. Add auth, Admin or MCP with [service composition](../cloudflare/service-entry.md), or call generated queries
directly with [typed queries](../guides/typed-queries.md).
