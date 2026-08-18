# @aotter/mantle-runtime

Runtime engine for mantle.

This package owns the adapter-neutral Core pipeline after semantic compilation.
Storage adapters prepare `RuntimePlan` into existing content repositories/readers
and a `ViewQueryExecutor`; SQL-shaped drivers remain SQLite/D1 implementation
details rather than a universal database contract.

```ts
const runtime = await bootMantleRuntime({
  plan,
  storage,
  handlers,
  ports,
  deployment: deploymentOptions,
});

await runtime.invokeProcedure({ procedure: "recompute", input, ctx });
await runtime.executeView({ view: "open-orders", options: { params }, ctx });
```

`bootMantleRuntime` makes one preparation attempt and derives handler readiness
from `handlers`; hosts still own lazy initialization, caching, retries, and
resource shutdown.

Advanced hosts may keep the stages explicit. `prepareDeployment()` returns the
exact plan together with its prepared semantic storage, so binding cannot
accidentally pair storage from one revision with another plan:

```ts
const prepared = await prepareDeployment(plan, storage, deploymentOptions);
const runtime = createMantleRuntime({ prepared, handlers, ports });
```

Pass `handlerNames` during explicit preparation when the embedding dispatches
Procedures. A projection-only embedding may omit it.

Binding is synchronous and performs no migrations, parsing, linking, or hidden
preparation. Request identity is supplied to each invocation.

Node-based tooling may import `@aotter/mantle-runtime/testing` for the real
SQLite access-path and HTTP sampling helpers. That subpath is intentionally
separate from the Worker-safe package entry.

For a fresh adapter implementation, start with
[`docs/adapter-guide.md`](../../docs/adapter-guide.md) and
[`docs/adr/0019-sealed-manifest-runtime-pipeline.md`](../../docs/adr/0019-sealed-manifest-runtime-pipeline.md).

Queue-backed `after_*` lifecycle delivery is optional and at-least-once. See
[`docs/deferred-lifecycle-queues.md`](../../docs/deferred-lifecycle-queues.md)
for the strict envelope, idempotency key, Cloudflare bindings, retry/DLQ
behavior, and upgrade procedure.

This package is prerelease software. Its `package.json` is the exact version
authority; the API surface may change until `v0.1.0`.
