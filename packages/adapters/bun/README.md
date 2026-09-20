# @aotter/mantle-bun

Embed Mantle Core in a Bun application while keeping the server and SQLite
handle application-owned.

```ts
import { Database } from "bun:sqlite";
import { createBunMantle } from "@aotter/mantle-bun";

const database = new Database("app.sqlite");
const mantle = createBunMantle({ plan, database, handlers });

const server = Bun.serve({
  async fetch(request) {
    if (new URL(request.url).pathname === "/health") return new Response("ok");
    return await mantle.handle(request) ?? new Response("not found", { status: 404 });
  },
});

// The application decides when to close both resources.
await server.stop();
database.close();
```

`handle()` mounts only manifest-declared public View and HTTP Trigger routes.
Pass a verified `HandlerContext` as its second argument when the host owns auth
and CSRF policy. Web, Admin, Auth, MCP, process startup, and database shutdown
are not selected.
