---
description: Generate a small native D1 service and mount an application-owned Worker.
---
# Quickstart: a service on Workers

Create an application outside the SDK checkout. Install an exact released `@aotter/mantle` version, TypeScript, Wrangler and Cloudflare Worker types. Read that installed version's handbook; this page describes the native 0.2.0 contract.

Save `manifests/tickets.yaml`:

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
    SELECT id, subject, ticketState FROM tickets
    WHERE ticketState = input.ticketState
    ORDER BY id ASC
```

```sh
pnpm exec mantle generate cloudflare-d1 generated manifests/tickets.yaml
pnpm exec mantle generate cloudflare-d1 generated manifests/tickets.yaml --check
```

Write `src/worker.ts`:

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

Set the database binding `DB`, Worker name and compatibility date in `wrangler.jsonc`. Generation adds the split build configuration. Apply `generated/schema.sql` explicitly to an empty local database, for example `pnpm exec wrangler d1 execute <database> --local --file generated/schema.sql`. The first request creates nothing.

Typecheck, then run `pnpm exec wrangler dev --local`. Query `/api/views/tickets-by-state?ticketState=open`; the response is `{ rows, nextCursor? }`. The empty database returns no rows. Use Store or a declared Procedure for writes.

Commit generated files and Wrangler edits; keep bundle `dist/` untracked. Follow [service composition](../cloudflare/service-entry.md) to add auth, Admin or MCP and [deploy and operate](../cloudflare/deploy-and-operate.md) before changing schema or deploying.
