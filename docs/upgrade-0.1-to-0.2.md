# Upgrading from 0.1.x to 0.2.0 (for AI agents)

0.2.0 breaks every consumer: the manifest grammar, the handler API, Worker
composition, the pagination wire and the package set. There is no codemod and
no in-place upgrade of a 0.1.x database. This guide is written for a coding
agent doing the move by hand, one project at a time. The decisions behind it
are ADR-0032, ADR-0033, ADR-0034 and ADR-0035 (`docs/adr/`); when this guide and
an ADR disagree, the ADR wins.

## Rules

- Work on a branch. Keep the 0.1.x project running until the 0.2.0 one passes
  its own checks; never edit both in one commit.
- Move meaning, not text. Every rewrite below has a reason; if a manifest does
  something no row of the tables covers, stop and ask instead of guessing.
- Never loosen access to make a check pass. A 0.1.x `requires.auth`, guard or
  `x-mantle-bind: ctx.user` must come out at least as strict.
- Data is not migrated by Mantle. A 0.1.x database is not opened by 0.2.0:
  export what you need (Admin, a View, or `wrangler d1 export`) and load it
  into the new service through `runtime.store.write` or a Procedure.
- `mantle generate --check` is the gate. Do not hand-edit anything under
  `.mantle/generated/`.

## 1. Packages

| 0.1.x | 0.2.0 |
|---|---|
| `@aotter/mantle-spec`, `-runtime`, `-cloudflare`, `-auth`, `-admin`, `-mcp`, `-web`, `-bun`, `-vercel`, `-indexeddb`, `-admin-ui`, `@aotter/mantle` | `@aotter/mantle` (subpaths `/spec`, `/d1`, `/cloudflare`, `/auth`, `/admin`, `/mcp`, `/web`, `/testing`) and `@aotter/mantle-ui` (Admin is `@aotter/mantle-ui/admin`) |
| `mantle-host` skill and CLI | the Mantle plugin's Cloud helper scripts |

Remove every old package, install `@aotter/mantle` at the exact target
version, and let `mantle generate` name the rest: it reports each missing
package with the install command and never installs anything itself.

## 2. `mantle.config.json`

```json
{ "version": 2, "identity": "mantle", "features": ["mcp", "admin", "web"] }
```

- `version: 1` and `host` are gone; there is no `--host`. Cloudflare is the one
  preset. A ChatGPT Sites project is an example, not a host.
- `identity` is `mantle` if the project used Mantle auth (Better Auth sign-in,
  Admin users, OAuth for MCP), `custom` if it resolved callers itself, `none`
  if it had no signed-in callers. `admin` needs an identity.
- `features` is a subset of `mcp`, `admin`, `web`, in that order. A feature no
  longer pulls in the others.
- `dialect` is optional; leave it out for Cloudflare D1.

## 3. Manifests

Set `apiVersion: cms.mantle.aotter.net/v2` on every document. A v1 document is
refused with a diagnostic, never lowered.

### Schema

Mostly unchanged. Check:

- `x-mantle-bind: ctx.user` on an owner field that callers must only see their
  own rows of → `spec.scope: { <field>: auth.uid() }`. The field must be a
  required string and the leftmost column of an index (`indexes: [[owner]]`),
  and every `uniqueIndexes` entry must start with it. Keep the bind if the
  field should still be stamped; drop it only if scope replaces it.
- `searchableFields` is matched with trigram full-text search, not `LIKE`;
  date and date-time fields are refused there.
- `checks` (boolean SQL over the row's own columns) is new and optional.

### View

A View is one SQL `SELECT` in `spec.sql`, with `input` for its parameters.

| 0.1.x | 0.2.0 |
|---|---|
| `from: posts` | `FROM posts` |
| `fields: [title, slug]` | `SELECT id, title, slug` |
| `filter: { status: { eq: published } }` | `WHERE status = 'published'` |
| `filter: { authorId: { "$ctx.user": id } }` | `WHERE authorId = auth.uid()`, or `scope` on the Schema |
| `params` and `{ "$param": q }` | `input: { type: object, properties: { q: … } }` and `input.q` |
| `orderBy: { createdAt: desc }` | `ORDER BY createdAt DESC` |
| `limit: 20` | `LIMIT 20` (a `LIMIT` needs an `ORDER BY`) |
| `page` / `show` on the wire | `limit` / `cursor`; `nextCursor` in the response |
| free-text search over `searchableFields` | `WHERE mantle.search(p, input.q) ORDER BY mantle.search_rank(p)`; places use `mantle.near` and `mantle.distance`. Mantle's functions are always written `mantle.`; an unqualified `search` is refused |

The SQL is PostgreSQL syntax. Name only declared Schemas (never
schema-qualified), `input.<name>` for declared inputs, `auth.uid()`,
`auth.role()`, `now()` and the `mantle.*` functions. `$1` is refused. Joins,
CTEs, `GROUP BY`, window functions and subqueries work; scope, TTL and
published-only are added to every Schema reference by the runtime, so do not
repeat them.

### Procedure

| 0.1.x | 0.2.0 |
|---|---|
| `handler: { kind: builtin, op: create, schema: s }` | `handler: { sql: "INSERT INTO s (a, b) VALUES (input.a, input.b) RETURNING id" }` |
| builtin `update` / `patch` with `match` | `handler: { sql: "UPDATE s SET … WHERE id = input.id" }` |
| builtin `upsert` | `INSERT … ON CONFLICT (…) DO UPDATE SET x = EXCLUDED.x` (the target must be a unique index; on a scoped Schema it includes the scope field) |
| builtin `delete` | `DELETE FROM s WHERE id = input.id` |
| an OCC write (`expectedVersion`) | `WHERE id = input.id AND version = input.expectedVersion`, plus `target: { schema, id, version }` naming those inputs |
| `handler: { ref: fn }` | unchanged; the function's signature changes (section 4) |
| `errorPolicy` | removed: before hooks fail closed, after hooks are best effort |

A write never names the scope field, `version`, `status`, `authorId` or the
timestamps; the runtime fills them. On a scoped Schema an `INSERT` names no
`id`. Several statements in one `sql` run as one transaction.

`requires.auth` predicates (`ctx.user`, `ctx.auth`, `ctx.staff`,
`ctx.auth.scope`) and `requires.guard` are unchanged.

### Trigger

- `schedule` cron is POSIX, UTC, weekday 0 = Sunday. Cloudflare counts
  Sunday as 1, so a 0.1.x `0 9 * * 1` meant Sunday: rewrite it as
  `0 9 * * 0`. Check every weekday field, including ranges and lists.
- `http`, `mcp` and `lifecycle` sources keep their shape.

## 4. Handler code

A `ref` handler is `(input, ctx) => output`, registered in the service's
`handlers` map. The generated types list exactly the plan's refs, so a missing
or extra handler fails typecheck.

| 0.1.x | 0.2.0 |
|---|---|
| `ctx.user`, `ctx.staff`, `ctx.auth` | `ctx.caller`: `{ kind: "anonymous" }`, `{ kind: "user", subject, role, scopes, … }` or `{ kind: "system", reason }` |
| `ctx.user.id` | `ctx.caller.kind === "user" ? ctx.caller.subject : …` |
| `ctx.event`, `ctx.schedule` | `ctx.cause` (`kind` is `http`, `mcp`, `internal`, `schedule` or `lifecycle`) |
| `ctx.event.entry` | **a loop** over `ctx.cause.rows`: one statement can touch many rows. Never rewrite it as `rows[0]` |
| `runtime.entries`, `runtime.executeView`, builtin calls, `ctx.writeAtomically`, `bindMantle` | `ctx.store.select({ from, where, orderBy, limit, cursor, search })`, `ctx.store.view(name, { input, limit, cursor })`, `ctx.store.write([...ops])` (all or nothing), `ctx.store.id()` |
| calling another Procedure through a `getRuntime` closure | `await ctx.invoke("procedure-name", input)` (keeps the caller, re-checks its auth) |
| `page` / `show` in reads | `limit` / `cursor`, and `nextCursor` back |

`ctx.store` is scoped to the caller. Host code outside a handler uses
`runtime.store`, which is not scoped; use it only for trusted work such as a
data import.

## 5. The Worker

`createMantleWorker`, `extend`, `createBunMantle` and `createVercelMantle` are
gone. `mantle generate` writes the Cloudflare preset once (`src/*.ts`,
`wrangler.jsonc`), and those files are yours afterwards. Move custom routes,
bindings and env from the old Worker into them by hand; do not regenerate over
them. With `identity: mantle`, the preset wires sign-in with a console email
sender for local use; replace it with a real `EmailSender` before deploying.
Schedule Triggers are registered from the plan (`schedules: true`); the
preset maps Cloudflare's cron strings back to the POSIX ones.

## 6. CLI

| 0.1.x | 0.2.0 |
|---|---|
| `mantle validate`, `introspect`, `emit-openapi`, `emit-types` | `mantle generate` (writes `.mantle/generated/`) and `mantle generate --check` (fails if anything is stale; with `--database <file>` it also prints the storage change SQL) |
| `mantle generate --host …` | `mantle generate` |

## 7. Verify

1. `mantle generate` and then `mantle generate --check` exit 0.
2. The project typechecks against the generated `mantle.ts`.
3. Each 0.1.x View and Procedure has a test or a scripted request that returns
   the same rows for the same caller, including one caller who must see
   nothing (scope) and one anonymous request.
4. Every schedule fires on the intended weekday.
5. `wrangler dev` starts, sign-in works if `identity` is `mantle`, and Admin,
   MCP and REST answer on their paths.

Report what changed per manifest, every place where access got stricter, and
anything you could not map.
