# Upgrading from 0.1.x to 0.2.0 (for AI agents)

0.2.0 replaces 0.1.x's grammar, runtime and storage. There is no codemod, no
migration tool and no in-place upgrade of a 0.1.x database: a coding agent
rebuilds the project on 0.2.0 and plans a reviewed data move for it.

1. **Rebuild the project on 0.2.0** with the current handbook: the
   [0.2.0 release notes](index.md#upgrading-to-020) and the
   [native SDK migration](index.md#native-sdk-migration-alpha7),
   the [CLI and generated ownership](../start/project-and-cli.md), the
   [app shell](../../examples/app-shell/) and the [Schema](../reference/schema.md),
   [View](../reference/view.md) and [Procedure](../reference/procedure.md)
   references. The application owns routing, Auth, native handles and database
   migrations. Install the same exact version of `@aotter/mantle`,
   `@aotter/mantle-ui` and, when selecting Admin, `@aotter/mantle-admin`.
   Preserve every authorization, scope and OCC requirement.
2. **Move the data** into a new 0.2 database, as
   [Moving data from 0.1.x](#moving-data-from-01x) describes.

The [appendix](#appendix-earlier-02-alpha-contract-historical) maps 0.1.x
manifests to an earlier 0.2 alpha. Its runtime, CLI, handler and data
instructions are out of date; use it only to recognise what a 0.1.x construct
meant, never as instructions.

## Moving data from 0.1.x

These facts come from the 0.1.4 and 0.2.0 sources. Before relying on one,
check it against the application's own generated `schema.sql` and its 0.1.4
export; where they disagree, trust them and stop to ask. Write the plan down
for human review before it touches production data.

- **Rehearse on a copy.** Load a copy of the export into a scratch 0.2
  database, check the result through the app (Views, Admin, sign-in), and only
  then run the reviewed load once into the fresh production database, before
  it takes traffic.
- **Never boot 0.2 against a 0.1.x database.** Apply the generated `schema.sql`
  (it includes the site tables when the site module is selected) to an empty
  database, then load rows into it.
- **Keep data files out of the repository.** Exports, dumps and copies hold
  user emails and content: keep them outside the working tree or ignored, and
  never commit them.

### Writing entries: the Store or SQL

- **Through the SDK.** The generated `store(db, caller)`, or `ctx.store` in a
  `ref` handler, with a trusted caller such as `{ kind: "system", reason }`
  ([authorization](../concepts/authorization.md)). It accepts no value
  for `id`, `version`, `created_at`, `updated_at`, `author_id`, `status`,
  `published_at` or the scope column, for any caller: it sets them itself, so new IDs, versions,
  timestamps and authors replace the old ones. Publishing goes through the
  generated `<schema>.publish` Procedure, which sets `published_at` to now
  ([lifecycle](../concepts/lifecycle-and-locales.md)). With new IDs,
  remap every `x-mantle-ref`, every `translates.on` key and any ID embedded
  in JSON; `x-mantle-ref` is not a foreign key, so a missed one dangles
  quietly.
- **Through SQL**, to keep IDs, history and authors: `INSERT` the rows with
  every native column set, as
  [reserved entry columns](../reference/schema.md#reserved-entry-columns)
  lists. This bypasses row policy, so review it like a migration.

### Entry columns on D1

| 0.1.4 | 0.2.0 |
|---|---|
| `_mantle_id` (UUID text) | `id` (text, unique) |
| `_mantle_version` (an OCC counter) | `version` |
| `_mantle_created_at`, `_mantle_updated_at` (epoch **milliseconds**) | `created_at`, `updated_at` (epoch **microseconds**: multiply by 1000). Set `updated_at`: it defaults to `0`, which Admin shows as 1970 |
| `_mantle_author_id` | `author_id`, the Better Auth `user.id` |
| `_mantle_status` (on every table) | `status` (`draft`, `published`, `archived`) on publishing Schemas only |
| none | `published_at` (publishing Schemas): 0.1.4 has no source; choose a value for each published row, `NULL` otherwise |
| the `scope` field | the same column, text, not null |
| `date-time` field, ISO text | integer microseconds since the epoch |
| `date` field, text | integer days since 1970-01-01 |
| object field (JSON text) | 0.1.4 had no geo type; if you remodel a position as a `format: geo` field, it is two columns, `<field>_lat` and `<field>_lng` |

- 0.2 tables on D1 are `STRICT`: a value of the wrong type fails the insert
  instead of being stored.
- A `numeric(p,s)` field is an integer scaled by 10^s on D1: rescale a 0.1.4
  REAL value before loading it.
- Schema `checks` run as `BEFORE INSERT` and `BEFORE UPDATE` triggers, so
  loaded rows are checked.
- Full-text search and geo index tables are maintained by triggers: insert
  only into the Schema tables.

### Better Auth

0.1.4 used Better Auth 1.7.2 with hand-written DDL; 0.2.0 uses 1.7.7, with the
tables `mantle generate --auth src/auth.ts` adds to `schema.sql`
([auth](../cloudflare/authentication.md)).

- The 0.2 caller subject is the Better Auth `user.id`. Keep user IDs, so that
  `author_id` and owner scopes still name the right people.
- Copy `user` and `account` with explicit column lists on both sides; both
  versions store dates as ISO text and booleans as 0/1 on D1. 0.1.4's
  `account` has an `issuer` column and `UNIQUE(issuer, accountId)` that the
  0.2 table may not have; compare the two DDLs before copying.
- 0.1.4 roles `owner`, `editor` and `contributor` have no 0.2 meaning. The
  admin layer is Better Auth's admin plugin `adminRoles` (default
  `["admin"]`) and `adminUserIds`
  ([authorization](../reference/authorization.md)); decide each mapping
  deliberately.
- A 0.1.4 `githubLogin` column must be declared in `user.additionalFields`
  to keep it.
- Leave sessions, verification rows and OAuth tokens behind; users sign in
  again. Mantle re-creates its OAuth resource rows from configuration
  ([OAuth](../guides/oauth.md)). Check `jwks`, OAuth clients and
  consents against Better Auth 1.7.7 and your secrets and URLs before copying
  any.
- The admin MCP endpoint moved from `/mcp/staff` to `/mcp/admin`; update MCP
  client URLs.

### Media

- `media_assets` has the same columns in 0.2, and its `created_at` stays in
  epoch **milliseconds**. Copy the rows as they are.
- Each variant keeps its stored `storageKey` and `publicUrl`, so 0.1.x objects
  in the same bucket keep working while their prefixes stay served
  ([media](../cloudflare/media-r2.md)).
- Do not carry over `pending_media_uploads`; an upload expires after 15
  minutes.
- `site_config` keeps its `key`/`value` columns; compare its keys with the
  generated `site-seed.sql` before copying.

## Appendix: earlier 0.2 alpha contract (historical)

> **Historical, do not follow.** This appendix describes an earlier 0.2
> alpha: `createMantle`, `runtime.store`, host presets, boot-time convergence
> and CLI flags that 0.2.0 does not have. The current handbook and
> [Moving data from 0.1.x](#moving-data-from-01x) replace it. Where it and
> [ADR-0032](https://github.com/aotter/mantle/blob/v0.2.0-alpha.7/docs/adr/0032-store-centric-core-and-service-contract.md),
> [ADR-0033](https://github.com/aotter/mantle/blob/v0.2.0-alpha.7/docs/adr/0033-storage-converges-to-the-plan.md),
> [ADR-0034](https://github.com/aotter/mantle/blob/v0.2.0-alpha.7/docs/adr/0034-store-is-authored-as-sql.md),
> [ADR-0035](https://github.com/aotter/mantle/blob/v0.2.0-alpha.7/docs/adr/0035-sql-dialects.md),
> [ADR-0036](https://github.com/aotter/mantle/blob/v0.2.0-alpha.7/docs/adr/0036-host-and-dialect.md) or
> [ADR-0038](https://github.com/aotter/mantle/blob/v0.2.0-alpha.7/docs/adr/0038-bun-native-host.md)
> disagreed, the ADR won.

### Rules

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
  one. Move data as [Moving data from 0.1.x](#moving-data-from-01x) says.
- `mantle generate --check` is the gate. Never hand-edit `.mantle/generated/`.

### 1. Packages

| 0.1.x | 0.2.0 |
|---|---|
| `@aotter/mantle` and `@aotter/mantle-spec`, `-runtime`, `-cloudflare`, `-auth`, `-admin`, `-web`, `-bun`, `-vercel`, `-indexeddb` | `@aotter/mantle` (subpaths `/spec`, `/d1`, `/postgres`, `/cloudflare`, `/bun`, `/auth`, `/admin`, `/mcp`, `/web`, `/testing`) |
| `@aotter/mantle-admin-ui` | `@aotter/mantle-ui` at the same version as `@aotter/mantle`: the preset serves the console at `/admin` from its `dist/admin` files; nothing to import. Its `/kit` re-export is gone: import `@aotter/mantle-ui/kit` |

Remove every old package and install `@aotter/mantle` at the exact target
version. `mantle generate` names any other package it needs, with the install
command; it never installs anything.

### 2. `mantle.config.json`

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

### 3. Manifests

Set `apiVersion: cms.mantle.aotter.net/v2` on every document; a v1 document
is refused.

**Native columns are snake_case in SQL**: `id`, `status`, `version`,
`created_at`, `updated_at`, `author_id`. (`ctx.store` JSON keeps the
camelCase names.)

#### Schema

| 0.1.x | 0.2.0 |
|---|---|
| `scope: { owner: $ctx.user.id }` | `scope: "owner = auth.uid()"`. The field is a required string, the leftmost column of an index (`indexes: [[owner]]`), and the first column of every `uniqueIndexes` entry. Store fills it; a write never sets it |
| `x-mantle-bind: ctx.user` on a field only its owner may see | remove the bind; add `scope` as above |
| any other `x-mantle-bind: ctx.user` | remove the bind; every write that sets the field sets it to `auth.uid()`, never to an input |
| `x-mantle-bind: ctx.staff` | remove the bind; set it to `auth.uid()` in writes whose Procedure requires `ctx.admin` |
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

#### View

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

#### Procedure

0.1.x builtin ops are `create`, `update`, `upsert`, `delete` and `archive`.

| 0.1.x | 0.2.0 |
|---|---|
| builtin `create` | `handler: { sql: "INSERT INTO s (a, b) VALUES (input.a, input.b) RETURNING id" }` (on a `publishing` Schema the row starts as a draft, as before) |
| builtin `update` (always version-checked, merges over the stored row) | `UPDATE s SET a = COALESCE(input.a, a), … WHERE id = input.id AND version = input.expectedVersion`. Keep both: without the version the lock is lost; without `COALESCE` an omitted optional field is cleared. `COALESCE` also means `null` cannot clear a field; give clearing its own flag input ([clear flag](../guides/sql-patterns.md#change-only-the-fields-given-coalesce), [leave out, replace or clear](../guides/native-admin.md#leave-out-replace-or-clear)) |
| builtin `upsert` with `match` | `INSERT … ON CONFLICT (<match columns>) DO UPDATE SET x = EXCLUDED.x`; the conflict columns are a unique index; on a scoped Schema the scope field may be named or left out, Store adds it |
| builtin `delete` | `DELETE FROM s WHERE id = input.id AND version = input.expectedVersion` |
| builtin `archive` | a `ref` handler: `ctx.store.write([{ update: "s", set: { status: "archived" }, where: { id }, lock: expectedVersion }])` (SQL cannot set `status`) |
| `handler: { kind: ref, ref: fn }` | `handler: { ref: fn }`; the function's signature changes (section 4) |
| `target: { schema, id, version }` | optional: inferred from `WHERE id = input.… AND version = input.…` |

A write never sets the scope field, `version`, `status`, `author_id` or the
timestamps. On a scoped Schema an `INSERT` names no `id`. Several statements
in one `sql` apply together or not at all. `requires.auth` and
`requires.guard` are unchanged.

#### Trigger

- `schedule` cron is POSIX: weekday 0 = Sunday. 0.1.x used Cloudflare's
  numbering (1 = Sunday), so subtract 1 from every weekday number, in ranges
  and lists too (`1` → `0`, `2-6` → `1-5`, `7` → `6`); `*` and `*/n` stay.
  On host `cloudflare`, a cron that sets both a day of month and a weekday
  is refused.
- `lifecycle` `errorPolicy` is removed: a before hook fails closed (a 0.1.x
  `continue` now blocks the write), an after hook is best effort.
- `http`, `mcp` and other `lifecycle` fields keep their shape.

### 4. Handler code

A `ref` handler is `(input, ctx) => output` in the service's `handlers` map.
The generated types list exactly the plan's refs.

| 0.1.x | 0.2.0 |
|---|---|
| `ctx.user` present | `ctx.caller.kind === "user"`. Never test `!== "anonymous"`: a schedule runs as `system` |
| `ctx.user.id` | `ctx.caller.subject` (after that check) |
| `ctx.staff` | `isAdmin(ctx.caller)` from `@aotter/mantle/contracts` |
| `ctx.event`, `ctx.schedule` | `ctx.cause` (`kind`: `http`, `mcp`, `internal`, `schedule`, `lifecycle`); `ctx.cause.cron` is POSIX, so shift any cron string the code compares |
| `ctx.event.entry` | **a loop** over `ctx.cause.rows` (one statement can touch many rows; never `rows[0]`). Rows are flat: `entry.data.x` → `row.x` |
| `ctx.store.view(name, { params, page, show, search, filters })` | `ctx.store.view(name, { input, limit, cursor, search, filters })`; `search` and `filters` match only the View's `uiSchema.list.searchFields` and `filterFields` |
| `runtime.entries`, `runtime.executeView`, `ctx.writeAtomically` | `ctx.db.<schema>.get / first / find`, `ctx.store.view`, `ctx.store.write([...ops])` (all or nothing), `ctx.store.id()` |
| `runtime.store.as(ctx)` | `runtime.store.as(caller)` |
| calling another Procedure through a `getRuntime` closure | `await ctx.invoke("procedure-name", input)` (keeps the caller, re-checks its auth) |

`ctx.store` is scoped to the caller. `runtime.store` is not scoped; use it
only in trusted host code.

### 5. The Worker and the data

1. Move the old `src/`, `wrangler.jsonc` (or `.toml`) and `tsconfig.json`
   aside. `mantle generate` writes the preset (`src/*.ts`, `tsconfig.json`,
   and `wrangler.jsonc` on `cloudflare` or `.env.example` on `bun`) only
   where no such file exists, and only while `src/service.ts` is missing.
2. Run `mantle generate`, then move custom routes, bindings and env from the
   old Worker into the new files by hand.
3. With `identity: mantle`, sign-in uses a console email sender locally;
   replace it with a real `EmailSender` before deploying.
4. Admin MCP moves from `/mcp/staff` to `/mcp/admin`. Update MCP client URLs.
   It admits only the admin layer classified by Better Auth’s admin plugin
   `adminRoles` (default `["admin"]`), and requires the `mcp` scope for tokens.
5. Data: this step described an alpha API that 0.2.0 does not have. Follow
   [Moving data from 0.1.x](#moving-data-from-01x) instead.

### 6. CLI

| 0.1.x | 0.2.0 |
|---|---|
| `mantle validate`, `mantle emit-openapi` | `mantle generate --check` (fails if anything is stale; `--database <file>` also prints the storage SQL) |
| `mantle generate --host …` (0.1.5-alpha.1) | `mantle generate --host cloudflare\|bun\|none` on the first run only |
| `mantle generate --output`, `--namespace` | removed: output is always `.mantle/generated/` |
| `mantle skills`, the `mantle-harness` bin | removed |

### 7. Verify

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
