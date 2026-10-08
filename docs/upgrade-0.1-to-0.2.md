# Upgrading from 0.1.x to 0.2.0 (for AI agents)

No codemod, and no in-place upgrade of a 0.1.x database. A coding agent moves
one project by hand with this guide. When it and ADR-0032 to ADR-0035
(`docs/adr/`), ADR-0036 (host and dialect) or ADR-0038 (Bun) disagree, the
ADR wins.

## Rules

- Work on a branch. Keep the 0.1.x project running until the 0.2.0 one passes
  its checks.
- Move meaning, not text. If a manifest does something no row below covers,
  stop and ask. Vercel projects have no 0.2.0 preset: stop and ask. A Bun
  project moves to `host: bun` (section 2).
- Never loosen access. Every 0.1.x `requires`, guard, `scope` and
  `x-mantle-bind` must come out at least as strict. `x-mantle-bind` is
  refused in 0.2.0 and stamps nothing, so each one becomes `scope` or an
  explicit value in the write (section 3).
- Give the 0.2.0 service a new database; never boot it against the 0.1.x
  one. Move data by export and import (section 5).
- `mantle generate --check` is the gate. Never hand-edit `.mantle/generated/`.

## 1. Packages

| 0.1.x | 0.2.0 |
|---|---|
| `@aotter/mantle` and `@aotter/mantle-spec`, `-runtime`, `-cloudflare`, `-auth`, `-admin`, `-web`, `-bun`, `-vercel`, `-indexeddb` | `@aotter/mantle` (subpaths `/spec`, `/d1`, `/postgres`, `/cloudflare`, `/bun`, `/auth`, `/admin`, `/mcp`, `/web`, `/testing`) |
| `@aotter/mantle-admin-ui` | `@aotter/mantle-ui` at the same version as `@aotter/mantle`: the preset serves the console at `/admin` from its `dist/admin` files; nothing to import. Its `/kit` re-export is gone: import `@aotter/mantle-ui/kit` |

Remove every old package and install `@aotter/mantle` at the exact target
version. `mantle generate` names any other package it needs, with the install
command; it never installs anything.

## 2. `mantle.config.json`

0.1.4 had none; 0.1.5-alpha.1 wrote a `version: 1` one. Write version 2:

```json
{ "version": 2, "identity": "mantle", "features": ["mcp", "admin", "web"] }
```

- `version: 1` is refused.
- `host` is `cloudflare` (the default, left out), `bun` or `none`; `none`
  writes the plan and types only, for a platform with no preset. `host: bun`
  refuses an enabled schedule Trigger: Bun has no cron dispatcher in the
  preset.
- `identity`: `mantle` if the project used Mantle auth (Better Auth sign-in,
  Admin users, OAuth for MCP), `custom` if it resolved callers itself, `none`
  if it had no signed-in callers. `admin` needs an identity.
- `features` is a subset of `mcp`, `admin`, `web`, in that order. The 0.1.x
  features `spec`, `runtime` and `api` are dropped: REST is always mounted.
- `dialect` is `sqlite` (alias `d1`, the default, left out) or `postgres`
  (PostgreSQL through Hyperdrive on `cloudflare`; node-postgres on `bun`, where it
  is the default). A 0.1.x project was SQLite: keep `sqlite` (with
  `--host bun`, pass `--dialect sqlite`) unless the data also moves to
  PostgreSQL.
- `host` and `dialect` are chosen on the first `mantle generate` (`--host`,
  `--dialect`); a rerun that asks for another is refused.

## 3. Manifests

Set `apiVersion: cms.mantle.aotter.net/v2` on every document; a v1 document
is refused.

**Native columns are snake_case in SQL**: `id`, `status`, `version`,
`created_at`, `updated_at`, `author_id`. (`ctx.store` JSON keeps the
camelCase names.)

### Schema

| 0.1.x | 0.2.0 |
|---|---|
| `scope: { owner: $ctx.user.id }` | `scope: { owner: auth.uid() }`. The field is a required string, the leftmost column of an index (`indexes: [[owner]]`), and the first column of every `uniqueIndexes` entry. Store fills it; a write never sets it |
| `x-mantle-bind: ctx.user` on a field only its owner may see | remove the bind; add `scope` as above |
| any other `x-mantle-bind: ctx.user` | remove the bind; every write that sets the field sets it to `auth.uid()`, never to an input |
| `x-mantle-bind: ctx.staff` | remove the bind; set it to `auth.uid()` in writes whose Procedure `requires` `ctx.staff` |
| `x-mantle-bind: now` | remove the bind; set it to `now()` in every write that sets it |
| `searchableFields` | unchanged, now trigram full-text search; date and date-time fields are refused |

`checks` (boolean SQL over the row's own columns) is new and optional.

A JSON Schema `pattern` (in a Schema, a View input or a Procedure input/output)
is now refused with `INVALID_PATTERN` when it could backtrack without bound on
a caller's string:

- a repeated group whose body repeats or alternates, such as the 0.1.x slug
  `^[a-z0-9]+(-[a-z0-9]+)*$` or `(a|b)+`, and any backreference;
- a pattern whose backtracking, branches × maxLength^e, could exceed
  10,000,000 — e is its variable quantifiers (`*`, `+`, `?`, `{m,}`,
  `{m,n}`) plus 1 unless it starts with `^`, branches the product of its
  alternations' alternatives — or one with e > 0 whose string has no
  `maxLength`: `^[a-z0-9-]+$` (e = 1) allows any maxLength up to
  10,000,000, an email `^[^@]+@[^@]+$` (e = 2) up to 3162, the unanchored
  `[^@]+@` (e = 2) also 3162, `^a*a*a*…$` almost none.

Rewrite a slug as `{ type: string, maxLength: 120, pattern: "^[a-z0-9-]+$" }`,
which also accepts leading, trailing and doubled hyphens. On a Schema field
that must not have them, add a `checks` entry:
`"slug NOT LIKE '-%' AND slug NOT LIKE '%-' AND slug NOT LIKE '%--%'"`.

### View

A View is one SQL `SELECT` in `spec.sql`, with `input` for its parameters.
The SQL is PostgreSQL syntax: it names declared Schemas (never
schema-qualified), `input.<name>`, `auth.uid()`, `auth.role()`, `now()` and
`mantle.*` functions. The runtime adds scope, TTL and published-only to every
Schema reference; do not repeat them.

| 0.1.x | 0.2.0 |
|---|---|
| `from: posts`, `fields: [id, title]` | `SELECT id, title FROM posts` |
| `filter: { eq: { field: status, value: published } }`, with `and` / `or` | `WHERE status = 'published'`, with `AND` / `OR` |
| `value: { "$ctx.user": id }` | `auth.uid()`, or `scope` on the Schema |
| `params` and `{ "$param": q }` | `input: { type: object, properties: { q: … } }` and `input.q` |
| `orderBy: [{ field: createdAt, direction: desc }]` | `ORDER BY created_at DESC` |
| `limit: 20` | `LIMIT 20` (a `LIMIT` needs an `ORDER BY`) |
| `select:` (`columns`, `where`, `$input.x`, `$ctx.user.id`, `$now`) | the same query as SQL: `input.x`, `auth.uid()`, `now()` |
| `sql:` (SQLite, `:name` parameters) | the same `sql:`, `:name` → `input.name`, rewritten to PostgreSQL syntax where it differs |
| free-text search over `searchableFields` | `WHERE mantle.search(p, input.q) ORDER BY mantle.search_rank(p)`; an unqualified `search` is refused |
| `page` / `show` on the wire | `limit` / `cursor`, `nextCursor` in the response |

### Procedure

0.1.x builtin ops are `create`, `update`, `upsert`, `delete` and `archive`.

| 0.1.x | 0.2.0 |
|---|---|
| builtin `create` | `handler: { sql: "INSERT INTO s (a, b) VALUES (input.a, input.b) RETURNING id" }` (on a `publishing` Schema the row starts as a draft, as before) |
| builtin `update` (always version-checked, merges over the stored row) | `UPDATE s SET a = COALESCE(input.a, a), … WHERE id = input.id AND version = input.expectedVersion`. Keep both: without the version the lock is lost; without `COALESCE` an omitted optional field is cleared |
| builtin `upsert` with `match` | `INSERT … ON CONFLICT (<match columns>) DO UPDATE SET x = EXCLUDED.x`; the conflict columns are a unique index; on a scoped Schema the scope field may be named or left out, Store adds it |
| builtin `delete` | `DELETE FROM s WHERE id = input.id AND version = input.expectedVersion` |
| builtin `archive` | a `ref` handler: `ctx.store.write([{ update: "s", set: { status: "archived" }, where: { id }, lock: expectedVersion }])` (SQL cannot set `status`) |
| `handler: { kind: ref, ref: fn }` | `handler: { ref: fn }`; the function's signature changes (section 4) |
| `target: { schema, id, version }` | optional: inferred from `WHERE id = input.… AND version = input.…` |

A write never sets the scope field, `version`, `status`, `author_id` or the
timestamps. On a scoped Schema an `INSERT` names no `id`. Several statements
in one `sql` apply together or not at all. `requires.auth` and
`requires.guard` are unchanged.

### Trigger

- `schedule` cron is POSIX: weekday 0 = Sunday. 0.1.x used Cloudflare's
  numbering (1 = Sunday), so subtract 1 from every weekday number, in ranges
  and lists too (`1` → `0`, `2-6` → `1-5`, `7` → `6`); `*` and `*/n` stay.
  On host `cloudflare`, a cron that sets both a day of month and a weekday
  is refused.
- `lifecycle` `errorPolicy` is removed: a before hook fails closed (a 0.1.x
  `continue` now blocks the write), an after hook is best effort.
- `http`, `mcp` and other `lifecycle` fields keep their shape.

## 4. Handler code

A `ref` handler is `(input, ctx) => output` in the service's `handlers` map.
The generated types list exactly the plan's refs.

| 0.1.x | 0.2.0 |
|---|---|
| `ctx.user` present | `ctx.caller.kind === "user"`. Never test `!== "anonymous"`: a schedule runs as `system` |
| `ctx.user.id` | `ctx.caller.subject` (after that check) |
| `ctx.staff` | `ctx.caller.kind === "user" && ctx.caller.role !== null` |
| `ctx.event`, `ctx.schedule` | `ctx.cause` (`kind`: `http`, `mcp`, `internal`, `schedule`, `lifecycle`); `ctx.cause.cron` is POSIX, so shift any cron string the code compares |
| `ctx.event.entry` | **a loop** over `ctx.cause.rows` (one statement can touch many rows; never `rows[0]`). Rows are flat: `entry.data.x` → `row.x` |
| `ctx.store.view(name, { params, page, show, search, filters })` | `ctx.store.view(name, { input, limit, cursor, search, filters })`; `search` and `filters` match only the View's `uiSchema.list.searchFields` and `filterFields` |
| `runtime.entries`, `runtime.executeView`, `ctx.writeAtomically` | `ctx.store.select`, `ctx.store.view`, `ctx.store.write([...ops])` (all or nothing), `ctx.store.id()` |
| `runtime.store.as(ctx)` | `runtime.store.as(caller)` |
| calling another Procedure through a `getRuntime` closure | `await ctx.invoke("procedure-name", input)` (keeps the caller, re-checks its auth) |

`ctx.store` is scoped to the caller. `runtime.store` is not scoped; use it
only in trusted host code.

## 5. The Worker and the data

1. Move the old `src/`, `wrangler.jsonc` (or `.toml`) and `tsconfig.json`
   aside. `mantle generate` writes the preset (`src/*.ts`, `tsconfig.json`,
   and `wrangler.jsonc` on `cloudflare` or `.env.example` on `bun`) only
   where no such file exists, and only while `src/service.ts` is missing.
2. Run `mantle generate`, then move custom routes, bindings and env from the
   old Worker into the new files by hand.
3. With `identity: mantle`, sign-in uses a console email sender locally;
   replace it with a real `EmailSender` before deploying.
4. Staff MCP stays at `/mcp/staff`, behind an OAuth token with the `mcp`
   scope and a staff role; MCP clients keep their URL.
5. Import data into the new database through `runtime.store`. A scoped row
   goes through `runtime.store.as(<its owner's caller>)`, so the scope field is
   the owner. `status`, `created_at` and `author_id` cannot be imported:
   publish with a second update that sets `status`, and accept new
   timestamps and author.

## 6. CLI

| 0.1.x | 0.2.0 |
|---|---|
| `mantle validate`, `mantle emit-openapi` | `mantle generate --check` (fails if anything is stale; `--database <file>` also prints the storage SQL) |
| `mantle generate --host …` (0.1.5-alpha.1) | `mantle generate --host cloudflare\|bun\|none` on the first run only |
| `mantle generate --output`, `--namespace` | removed: output is always `.mantle/generated/` |
| `mantle skills`, the `mantle-harness` bin | removed |

## 7. Verify

1. `mantle generate` and `mantle generate --check` exit 0.
2. The project typechecks against the generated `mantle.ts`.
3. Each 0.1.x View and Procedure returns the same rows for the same caller,
   including a caller who must see nothing (scope) and an anonymous request.
4. A write cannot set an owner, author or timestamp field from its input.
5. Every schedule fires on the intended weekday.
6. `wrangler dev` (or `bun src/index.ts`) starts, sign-in works if
   `identity` is `mantle`, and Admin, MCP and REST answer on their paths.

Report what changed per manifest, every place where access got stricter, and
anything you could not map.
