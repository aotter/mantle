---
name: develop
description: Work on an existing Mantle 0.2 project — manifests, SQL Views and Procedures, ref handlers, the service entry, surfaces, identity and MCP — using the installed package's contract.
metadata:
  source: "@aotter/mantle"
  sourcePath: docs/skills/develop/SKILL.md
  applies_to: mantle 0.2
  projection: package
---

# Mantle Develop

The workflow for changing a Mantle 0.2 project. The installed package's docs
govern behavior: `node_modules/@aotter/mantle/docs/`.

## First read

1. `package.json` and the lockfile: the installed `@aotter/mantle` version.
   Every `@aotter/mantle*` package is at that same exact version. If
   `node_modules/` is missing, install with the lockfile first.
2. `mantle.config.json`: `identity` (`mantle`, `custom`, `none`) and
   `features`. A `version: 1` config or `cms.mantle.aotter.net/v1` manifests
   mean 0.1.x: switch to `docs/skills/update/SKILL.md`.
3. `manifests/*.yaml`, `src/service.ts`, `src/handlers.ts`, `src/index.ts`
   (and `src/identity.ts` for `custom`), `wrangler.jsonc`.
4. Installed docs: `docs/handbook/reference/features.md` to map the request to
   manifest features, then the field references it links to.
   `docs/examples/` holds whole services in the v2 grammar.

## The model

Four atoms, nothing else: **Schema** (rows), **View** (one SQL `SELECT`),
**Procedure** (SQL write statements, or a `ref` handler), **Trigger** (HTTP,
MCP, lifecycle, schedule). Do not invent kinds such as `Form` or `Workflow`.

Choose in this order, stopping at the first that works:

1. A Schema feature: `checks`, `uniqueIndexes`, `scope`, `ttl`,
   `searchableFields`, `lifecycle`.
2. SQL: a View for reads; a Procedure's `sql` for writes. Several statements in
   one `sql` apply together or not at all.
3. `requires` for who may call; a guard for a live check before one action.
4. A `ref` handler, only for what SQL cannot do: calling another service,
   reading before writing, setting `status`, branching on a read.

## SQL rules that trip agents

- PostgreSQL syntax over declared Schemas only. References: `input.<name>`,
  `auth.uid()`, `auth.role()`, `now()`; search is `mantle.search(t, q)`.
- Native columns are snake_case in SQL (`created_at`, `author_id`) and
  camelCase in `ctx.store` JSON and in `indexes`.
- A write never names the scope field, `id` (on update), `version`, `status`,
  `created_at`, `updated_at` or `author_id`. Set an owner with `auth.uid()` and
  a time with `now()`, never from input.
- Optimistic lock: `WHERE id = input.id AND version = input.expectedVersion`.
  Writing no row is `CONFLICT`. Keep omitted optional fields with
  `COALESCE(input.x, x)`.
- `LIMIT` needs `ORDER BY`. No `OFFSET`, `RIGHT JOIN`, `UNION`, recursive CTEs,
  `CURRENT_TIMESTAMP`. `CAST(x AS int)` only on an integer literal: use
  `round(x)`.
- Unquoted aliases fold to lower case: `AS "orderCount"` keeps the case.
- The runtime injects scope and TTL into every Schema reference, and
  published-only into public Views. Never repeat them.
- `scope` hides rows from staff too. When staff must see every row, store
  `auth.uid()` in a field and filter on it instead.

## Handlers

- `src/handlers.ts` exports `handlers: MantleHandlers<Env>`; the generated type
  lists exactly the plan's refs. Read and write only through `ctx.store`.
- After hooks: loop over `ctx.cause.rows`; never read only `rows[0]`.
- Before hooks and guards are read-only and reject by throwing
  `DiagnosticError` (from `@aotter/mantle/spec`); any other throw is a 500.
- `ctx.caller.kind === "user"` means signed in; a schedule runs as `system`.
  Never test `!== "anonymous"`.
- `ctx.invoke(name, input)` calls another Procedure with the same caller.

## The service

`src/service.ts`, `src/index.ts` and `wrangler.jsonc` belong to the
application after the first `mantle generate`; it never rewrites them. Add
routes, bindings and env there (`docs/handbook/cloudflare/service-entry.md`).
Reach data from service code through `runtime.store.as(caller)` or
`runtime.invokeProcedure`; `runtime.store` alone is unscoped. A signed webhook
is a route in the service's `fetch` that verifies the raw body, then invokes
a Procedure as `systemCaller(...)`.

## Loop

```bash
pnpm exec mantle generate
pnpm exec mantle generate --check
pnpm exec tsc --noEmit
pnpm exec wrangler dev --local
```

Then exercise what changed over HTTP: the REST View or Trigger, `/mcp`
`tools/list` and a call, and with identity `mantle` a console email-OTP
sign-in and the Admin route (`docs/handbook/cloudflare/authentication.md`).
Check the stored rows, not only a 200. Before deploying a Schema change, run
`mantle generate --check --database <file>` to see the storage SQL.

## Rules

- Never edit `.mantle/generated/`. Commit it.
- Never write a Schema's table with `env.DB`, KV or SQL from outside Store;
  never touch `_mantle_*` tables. The application's own tables are its own.
- A blocked storage change (`STORAGE_CHANGE_BLOCKED`) is the author's to make
  by hand, then rerun; Mantle never drops a column or index.
- Do not commit secrets (`.dev.vars`, provider keys).
- Every 0.1.x term is gone: builtin handlers, `from`/`filter`, `params`,
  `$ctx`, `x-mantle-bind`, `--host`, `mantle validate`, `mantle skills`,
  `createMantleWorker`, `/mcp/staff` as the default staff MCP.

## When you are done

Report the manifests and code you changed, the `generate --check` and
typecheck results, the HTTP calls you made and what they returned, and any
access you made stricter or could not express.
