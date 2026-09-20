# `@aotter/mantle-indexeddb`

Optional IndexedDB storage for the unchanged Mantle Runtime in a browser SPA.
The adapter exclusively owns `databaseName`; use separate database names for
separate local worlds or for non-Mantle application data.

```ts
import { bootMantleRuntime } from "@aotter/mantle-runtime";
import { IndexedDbMantleStorageAdapter } from "@aotter/mantle-indexeddb";

const storage = new IndexedDbMantleStorageAdapter({ databaseName: "my-app" });
const runtime = await bootMantleRuntime({ plan, storage, handlers });

// Concrete adapter lifecycle; this is not a Runtime port.
await storage.deleteDatabase();
```

## Local-only and hybrid handlers

A local-only Procedure uses Mantle builtins or application handlers against the
same browser runtime; it needs no HTTP server:

```ts
await runtime.invokeTrigger({
  trigger: "rename-board-mcp",
  input: { title: "Trip ideas" },
  ctx,
});
```

A hybrid Mantle backend is still an ordinary HTTP Trigger call:

```ts
const handlers = {
  async syncOrder(input) {
    const response = await fetch("/api/orders/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`sync failed (${response.status})`);
    return response.json();
  },
};
```

For a non-Mantle backend, the same handler can call its REST, GraphQL, or other
application API directly. No remote Trigger grammar is required:

```ts
const handlers = {
  async quote(input) {
    const response = await fetch("https://api.example.com/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: quoteQuery, variables: input }),
    });
    return response.json();
  },
};
```

Remote services must repeat authentication, authorization, validation,
concurrency, and idempotency checks; browser state is authoritative only for
user-owned local data.

Persistence requests remain application-owned:

```ts
const persisted = await navigator.storage.persist();
const estimate = await navigator.storage.estimate();
```

The adapter never requests persistence automatically. A host may invalidate
TanStack Query (or another reactive cache) from its WebMCP `after` hook; this
package does not depend on a reactive engine.

```ts
after({ target }, result) {
  if (result.status === "fulfilled") {
    void queryClient.invalidateQueries({
      queryKey: ["mantle", target.kind, target.name],
    });
  }
}
```

Declarative Views use a correct O(n) scan in this first slice. The adapter does
not support native SQL Views, application-specific multi-entry transactions,
exact snapshot restore, cross-tab invalidation, or offline synchronization.
