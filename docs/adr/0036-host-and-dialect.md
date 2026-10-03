# ADR-0036: Host and dialect are the two axes of a project

**Status:** Accepted for 0.2.0. Amends ADR-0035 decision 5 and replaces its rejected alternative "a `host` option in the open-source CLI".

**Date:** 2026-10-02

**Related:** ADR-0032 decision 6, ADR-0035, #1296

## Context

ADR-0035 made the SQL engine a dialect module, but left the CLI with one preset: Cloudflare over D1. A service that wants
PostgreSQL behind Hyperdrive wrote its composition by hand, and the CLI rejected a `host` key as a 0.1.x config. ADR-0035
rejected a `host` option because it "ties platform files to the generator". Two facts change that: the preset is already
written once and owned by the application (ADR-0032 decision 6), so the generator owns no platform file after the first
run; and a second built-in dialect exists, so "which engine on which platform" is a real choice.

## Decision

### 1. Two axes

- `host`: where the service runs. `cloudflare` (the default) or `none`. A Bun host (`bun`) is added by its own ADR amendment
  with `@aotter/mantle/bun`.
- `dialect`: the SQL engine. `sqlite` (alias `d1`, the default), `postgres`, or a dialect package (ADR-0035 decision 5).
- The driver follows from the pair (D1 binding, Hyperdrive and `pg`, ...); it is not a third option.
- The host never enters the plan or its fingerprint. The dialect does, as ADR-0035 decision 5 says. The SQLite dialect keeps
  recording `@aotter/mantle/d1`, so the rename changes no existing plan.

### 2. Chosen once

- `mantle generate --host <host> --dialect <name>` writes both into `mantle.config.json` on the first run, and the preset
  for the pair if one exists.
- A rerun that asks for another host or dialect is refused (exit 2), as another identity is: `src/service.ts` is the
  application's, and another engine is a data move. The config is changed deliberately.

### 3. Presets per pair

| | `cloudflare` | `none` |
|---|---|---|
| `sqlite` | the D1 preset | plan and types only |
| `postgres` | the Hyperdrive preset: `postgresStorage`, `pgPool` and `pgDatabaseDriver` over a client per operation; a `hyperdrive` binding with a placeholder id and a `localConnectionString` | plan and types only |
| a package | plan and types only | plan and types only |

- `host: none` is the escape hatch for any platform the presets do not cover (ChatGPT Sites keeps using the Cloudflare
  preset with `identity: custom`): the application calls `createMantle` with a storage adapter itself.
- The Cloudflare cron gate applies to host `cloudflare` only.
- A pair's packages are checked like a feature's (`pg` for `postgres` on `cloudflare`).
- Generate warns, never writes, when `wrangler.jsonc` lacks the pair's binding, or still holds the Hyperdrive placeholder.

## Consequences

- PostgreSQL on Cloudflare is one flag, and its preset is tested end to end (typecheck, and a Worker booted against
  PostgreSQL through Hyperdrive's local connection).
- The 0.1.x detection is `version: 1`, no longer any `host` key.
- `--check --database`'s storage dry run stays the SQLite dialect's.

## Alternatives

- **A third `driver` axis.** Every built-in pair has one sensible driver; a third choice is configuration without a use.
- **Host in the plan.** A plan runs the same on any host; recording it would make a host move a recompile for nothing.
- **Renaming the recorded dialect to `@aotter/mantle/sqlite`.** Every existing plan would stop booting for a name.

## Implementation status

Implemented in #1296: the axes, the aliases, the Hyperdrive preset, `host: none`. The Bun host (`host: bun`, both dialects)
is ADR-0038, which amends decisions 1 and 3.
