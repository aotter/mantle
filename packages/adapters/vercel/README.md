# @aotter/mantle-vercel

Embed Mantle Core in a framework-free Vercel Node.js Function. The application
owns durable storage, its client/pool, authentication, CSRF policy, and route
composition.

```ts
import { createClient } from "@libsql/client";
import { SqliteMantleStorageAdapter } from "@aotter/mantle-runtime";
import { createVercelMantle } from "@aotter/mantle-vercel";
import { LibsqlDatabaseDriver } from "@aotter/mantle-vercel/libsql";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const mantle = createVercelMantle({
  plan,
  handlers,
  storage: new SqliteMantleStorageAdapter(new LibsqlDatabaseDriver(client)),
});

export default {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/health") return new Response("ok");
    return await mantle.handle(request) ?? new Response("not found", { status: 404 });
  },
};
```

`handle()` selects only public View and manifest HTTP Trigger routes. It maps
deferred post-response work through Vercel `waitUntil`; pass an override when a
framework owns an equivalent lifecycle. Never use the Function filesystem or
`/tmp` as canonical Mantle storage. The adapter never opens or closes a client.

`@libsql/client` is an optional peer required only by the `/libsql` subpath.
Any durable PostgreSQL, MongoDB, or application-table implementation can be
passed through `MantleStorageAdapter` without installing it.
