---
description: One Durable Object per tenant or member on its own SQLite in Mantle 0.2.0 — the experimental durableObjectStorage, routing by idFromName(subject) with auth on the shared database, alarms and the schedule rules that follow from invokeSchedule, and what is not supported.
---
# Durable Object per tenant

> Experimental. `durableObjectStorage` and `durableObjectDriver` may change in a
> minor version, and the generated presets do not use them.

A SQLite-backed Durable Object has its own database, queried in-process. Give each
tenant or member one object and each gets isolation, no shared-database size cap
and a private alarm. Mantle runs inside the object through the same `createMantle`
as on D1; only the storage differs: `durableObjectStorage(ctx.storage)`.

Evidence: `test/cloudflare/durable-object.test.ts` runs the storage conformance
suite and the constraint-error classification against real Durable Object SQLite
in local workerd. It has not been run end to end on a deployed Worker, and
production error shapes are unconfirmed.

## `wrangler.jsonc`

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "MEMBER", "class_name": "MemberStore" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MemberStore"] }]
}
```

The Worker keeps its D1 `DB` for Auth and shared tables.

## The Durable Object

```ts
import { DurableObject } from "cloudflare:workers";
import { createMantle, withCaller, type CallerResolver, type MantleService } from "@aotter/mantle";
import { durableObjectStorage } from "@aotter/mantle/cloudflare";
import { createRestSurface } from "@aotter/mantle/web";

// the caller the Worker authenticated and forwarded; anything else is anonymous
const forwardedCaller: CallerResolver = async (request) => {
  try {
    const caller = JSON.parse(request.headers.get("x-mantle-caller") ?? "null");
    if (caller?.kind === "user" && typeof caller.subject === "string") return { caller };   // never a forwarded "system" caller
  } catch {}
  return { caller: { kind: "anonymous" } };
};

// one factory, so each object owns its routes (the same rule as `createService()` in the service entry)
function createMemberService() {
  let routes: ReturnType<typeof withCaller> | undefined;
  const service: MantleService<Env> = {
    handlers,
    fetch: (request, _env, { runtime }) => (routes ??= withCaller(forwardedCaller, createRestSurface(runtime, { basePath: "/api/member" })))(request, runtime),
  };
  return service;
}

export class MemberStore extends DurableObject<Env> {
  mantle = createMantle(createMemberService(), { plan, storage: () => durableObjectStorage(this.ctx.storage), schedules: true });
  fetch(request: Request) { return this.mantle.fetch(request, this.env, this.ctx); }
}
```

Several compositions share one isolate (the Worker on D1, and every live object), so
none may share `routes`: see [The service and its entry](service-entry.md).

## Routing in the Worker

In `src/service.ts`, before the `rest(...)` fallthrough:

```ts
const member = guard(async (request, caller) => {
  if (caller.kind !== "user") return new Response(null, { status: 401 });
  const headers = new Headers(request.headers);
  headers.set("x-mantle-caller", JSON.stringify(caller));   // always overwritten, never forwarded from the client
  return env.MEMBER.get(env.MEMBER.idFromName(caller.subject)).fetch(new Request(request, { headers }));
});
// ...
if (under("/api/member")) return member(request, runtime);
```

Auth, sessions and OAuth stay in the Worker's shared database. The trust boundary is
the forwarded header:

- The Worker overwrites `x-mantle-caller` on every request. Never forward a client-supplied one.
- The object's `forwardedCaller` validates the shape (`kind: "user"`, a string `subject`; never `system`) and falls back to anonymous.
- The class exposes no other `fetch`-reachable entry, and the namespace is not publicly addressable; only the Worker's binding reaches it.
- `idFromName(caller.subject)` assumes subjects are already namespaced per credential (for example `chatgpt:<sub>`), so two identity providers cannot collide.

## Alarms and schedules

`invokeSchedule(cron, scheduledTime, env, ctx)` runs every enabled Trigger of the plan
whose cron spelling equals `cron`. It does not know which composition owns a Trigger.
Both compositions read the same plan, the generated Worker lists every plan cron in
`wrangler.jsonc` `triggers.crons` (`mantle check` fails if one is missing) and its
`scheduled` handler invokes all of them. Left alone, a per-member Trigger would also run
in the Worker against D1, and a cron shared with a Worker Trigger fired from an alarm would
run the Worker's Procedures against the object's database. So:

1. Give per-member Triggers a cron spelling no Worker Trigger uses.
2. Keep that spelling in `wrangler.jsonc` (the check requires it), and make the Worker skip it in the generated `src/index.ts`:

```diff
+const MEMBER_CRONS = new Set(["0 3 * * *"]);
 ...
     for (const cron of posix) {
+      if (MEMBER_CRONS.has(cron)) continue;
       try {
         await mantle.invokeSchedule(cron, controller.scheduledTime, env, ctx);
```

3. The object's `alarm()` invokes only those spellings. Compute `at` from your own schedule (the boundary the alarm was set for, not `Date.now()`), so a retried alarm keeps the cause id `${trigger}:${scheduledTime}` and handlers can deduplicate:

```ts
async alarm() {
  const at = this.nextBoundary;   // yours: persisted when the alarm was set
  for (const cron of MEMBER_CRONS) await this.mantle.invokeSchedule(cron, at, this.env, this.ctx);
  await this.ctx.storage.setAlarm(nextBoundaryAfter(at));
}
```

4. The schedule-run ledger is per database. A Trigger that ran in both places would run twice.

Mantle computes no alarm times. Both compositions pass `schedules: true`: boot fails for an enabled schedule Trigger without it.

## Errors and limits

- Binds are native `?N`; booleans become 0 or 1, a missing value NULL. A statement takes at most 100 binds.
- Each batch is one `transactionSync`. Do not call Mantle from inside your own `transactionSync`.
- Constraint errors are refusals, as on D1. Local workerd throws a plain `Error` with no code field and the SQLite code in the message, for example `UNIQUE constraint failed: r.u: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)`, so the executor classifies them by text and the driver maps nothing.
- Platform errors (a reset, a timeout, overload) carry no SQLite code: a write reports `OUTCOME_UNKNOWN`, a read `RESOURCE_UNAVAILABLE`.
- The conformance suite passes in full, so FTS5, R*Tree and foreign keys are available in local workerd.

## Cold starts

Every new object converges the plan on its first call: system tables, the Schemas' tables
and, for a non-UTC `timeZone`, its transition rows. An existing object reads two rows
and skips. Locally, converging a new empty database took about 14 statements in three
batches (roughly 0.3 s from Node, transport included) and an existing one 2 reads
(under 20 ms); that is a proxy, since the adapter ran in Node there. Keep `timeZone` at
`UTC` unless you need another zone.

Because each object builds its own `createMantle`, every new object also pays Mantle's first-call
cost (validation, policy, printing, schema conversion), and the printed-SQL cache of the executor is per
object, not shared in the isolate. The deployed cost per object is not measured yet.

## Not supported

Admin or MCP across many objects (a new capability that needs its own ADR), a generated
preset, and transactions across objects.
