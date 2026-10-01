---
name: integrate
description: Add Mantle 0.2 to an existing application, or rebuild one on Mantle and migrate its data. Use when the application already has its own code, routes, users, storage or deployment.
metadata:
  source: "@aotter/mantle"
  sourcePath: docs/skills/integrate/SKILL.md
  applies_to: mantle 0.2
  projection: package
---

# Integrate Mantle into an existing application

Mantle is added to a running service; it does not replace it. The service
keeps its entry, users, auth, tables, routes and frontend. Mantle adds its own
`_mantle_*` tables, the Schemas it declares, and the surfaces the service
chooses to mount. Read the installed package's
`docs/handbook/start/overview.md` and
`docs/handbook/concepts/authorization.md` first.

## Inspect and decide

Map the application before installing anything: its entry and router, frontend,
users and sign-in, database and data volume, deployment, background jobs and
tests. Ask which behavior the owner wants Mantle to own. Then choose:

1. **Embed.** Keep the application's entry. Compose Mantle into its existing
   `fetch` (`createMantle(service, { plan, storage })`, the surfaces you want,
   behind a `CallerResolver` over the application's own sessions). Best when
   the application already runs on Workers with D1.
2. **Move one capability at a time.** Give one bounded set of data (a form, a
   catalog) a Schema, then its Views and Procedures; the rest stays. At every
   step, each table has exactly one writer.
3. **Rebuild and migrate.** Generate a new Mantle service in a separate
   directory, port the frontend and business rules, and import the data. Best
   when adapting the old structure costs more than rebuilding.

Explain the choice and its tradeoffs to the owner before changing code.

## Identity

The application keeps its users. Pick `identity`:

- `custom`: write `src/identity.ts` as a `CallerResolver` over the existing
  sessions or tokens. `subject` is the application's stable user id,
  namespaced when there are several issuers, never an email. Map existing
  admin roles to `owner` / `editor` / `contributor`, or leave `role` null.
- `mantle`: only when the application has no sign-in and wants Better Auth's.
- `none`: a public service with no signed-in callers.

Switching identity later is refused; choose deliberately.

## Embedding into an existing entry

`mantle generate` writes the preset only where `src/service.ts` does not
exist. For an application with its own entry, generate in a scratch
directory with the same manifests and config, then copy the composition you
need from the generated `src/service.ts` into the application's own entry:

- the `createMantle(service, { plan, storage: (env) => d1Storage(env.DB), schedules: true })` call;
- `withCaller(resolver, createRestSurface(runtime, { basePath: "/api" }))`
  and any other surface, mounted on paths the application does not use;
- the `scheduled` mapping from `src/index.ts`, if the plan has schedules.

Put that composition in the application's `src/service.ts` before the first
`mantle generate` inside the application: while `src/service.ts` is missing,
generate writes every missing preset file (`src/service.ts`, `src/index.ts`,
`src/handlers.ts`, `tsconfig.json`, `.gitignore`, `.dev.vars.example`, and
`wrangler.jsonc` unless a `wrangler.*` exists) beside the application's own.
Commit `.mantle/generated/` and run `mantle generate --check` in CI.

## Moving data into a Schema

- Mantle never reads or writes a table it did not create. A table with a
  Schema's name that Mantle does not own stops boot
  (`STORAGE_TABLE_NOT_OWNED`); give the Schema a new name.
- Import through `runtime.store` in trusted code. A scoped row goes through
  `runtime.store.as(<its owner's caller>)`, so the owner field is right.
  `status`, timestamps and `author_id` cannot be imported: publish with a
  second update that sets `status`.
- Rehearse on a copy, compare row counts, and keep the old table until the
  owner confirms. Never touch live data before the cutover is agreed.

## Verify

Run the application's own build and tests, then `mantle generate --check`,
the typecheck, and real requests against the routes Mantle now serves, as the
right callers (owner, member, anonymous). `--check` proves the generated files;
it does not prove the integration.

## When you are done

Report which capabilities Mantle now owns, the identity mapping, what moved and
how it was verified, and what remains for cutover or deployment.
