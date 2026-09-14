# @aotter/mantle-runtime

Runtime engine for mantle.

Documentation paths beginning with `node_modules/` below are relative to the
application root. Shared guides ship in the same-version `@aotter/mantle`
package; in an SDK checkout, those guides live under the root `docs/`.

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

## Storage adapter conformance

Prefer an official adapter when its storage ownership fits your application.
Implement the existing `MantleStorageAdapter` ports when entries must participate
in application-owned storage or transactions. Test that implementation with
`runStorageConformance` from `@aotter/mantle-runtime/testing/storage` before
upgrading the SDK. This portable subpath works in browsers and server runtimes;
it imports neither a test framework nor the Node-only `/testing` helpers, and
the production entry does not import it.

The factory receives a sealed fixture `RuntimePlan` and must prepare a **fresh,
empty, disposable store for each check**. Return its `PreparedMantleStorage` and
a cleanup callback. If setup fails before returning, the factory owns cleanup.
For adapters with locale preparation, configure `en`, `zh-TW`, and `ja`.

For example, the official IndexedDB adapter can run the same contract as a
host-owned adapter:

```ts
import { IndexedDbMantleStorageAdapter } from "@aotter/mantle-indexeddb";
import { runStorageConformance } from "@aotter/mantle-runtime/testing/storage";

const report = await runStorageConformance({
  async create(plan) {
    const adapter = new IndexedDbMantleStorageAdapter({
      databaseName: `conformance-${crypto.randomUUID()}`,
    });
    try {
      return {
        storage: await adapter.prepare(plan),
        cleanup: () => adapter.deleteDatabase(),
      };
    } catch (error) {
      await adapter.deleteDatabase();
      throw error;
    }
  },
});
if (!report.ok) throw new Error(JSON.stringify(report.failures, null, 2));
```

Seven checks cover CRUD and replacement updates, concurrent/stale version
conflicts, guarded status transitions/deletes, nested JSON clone isolation,
all public read helpers and their field projection, locale/null handling,
forward/backward cursors with equal timestamps, and declarative View projection,
parameters, nested `and`/`or`, ordering, and pagination. Cases run sequentially,
always attempt cleanup, and collect failures as `{ check, phase, message }`;
`phase` distinguishes setup, assertion, and cleanup failures. A fixture grammar
or compilation defect rejects the runner before creating storage.

The contract calls prepared storage directly. It does not run Runtime's locale
validation or lifecycle hooks; null/missing locale fixtures exercise the read
port's documented behavior. It uses JSON-compatible data, not arbitrary browser
objects. Native SQL, unique indexes, search, specialized sorts, migrations,
media/auth, cross-process races, and application transaction/lifecycle semantics
still need adapter-specific tests. A passing report is a version-specific
baseline, not certification of every storage feature.

For a fresh adapter implementation, start with
`node_modules/@aotter/mantle/docs/adapter-guide.md` and
`node_modules/@aotter/mantle/docs/adr/0019-sealed-manifest-runtime-pipeline.md`.

Queue-backed `after_*` lifecycle delivery is optional and at-least-once. See
`node_modules/@aotter/mantle/docs/handbook/cloudflare/deferred-hooks-queues.md`
for the strict envelope, idempotency key, Cloudflare bindings, retry/DLQ
behavior, and upgrade procedure.

This package is prerelease software. Its `package.json` is the exact version
authority; the API surface may change until the first stable `0.1.2` release.
