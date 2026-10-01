# @aotter/mantle

Mantle is a manifest-driven service core. A service declares Schemas, Views,
Procedures and Triggers in YAML. Views and Procedures are SQL
(PostgreSQL syntax). `mantle generate` compiles them into a sealed plan and a
typed module. The runtime serves the plan through one Store, which adds each
caller's scope, TTL, publishing state and optimistic locks to every statement.

## Subpaths

Each folder of `src/` is one subpath. `check:boundaries` enforces what each may
import.

| Subpath | Contents |
|---|---|
| `@aotter/mantle` | `createMantle`, `createMantleRuntime`, Store, `Caller`, the handler contract, `withCaller` |
| `@aotter/mantle/spec` | The manifest grammar, validation and `compilePlan` (the CLI side) |
| `@aotter/mantle/d1`, `/d1/compile` | The built-in SQLite dialect: runtime and compile sides (ADR-0035) |
| `@aotter/mantle/cloudflare` | `d1Storage`, `d1Driver`, `r2MediaStorage`, `toCloudflareCron` |
| `@aotter/mantle/auth` | `createMantleAuth` (Better Auth), `createCallerResolver`, `createAuthRoutes` |
| `@aotter/mantle/admin` | `createAdminSurface` |
| `@aotter/mantle/mcp` | `createMcpSurface` |
| `@aotter/mantle/web` | `createRestSurface` |
| `@aotter/mantle/testing` | `runStorageConformance`, the dialect compliance suite |

## CLI

```sh
mantle generate           # manifests + mantle.config.json -> .mantle/generated/, and the preset once
mantle generate --check   # the gate: fails when anything generated is stale
```

On its first run, `mantle generate` writes the Cloudflare service preset:
`src/service.ts`, `src/index.ts`, `src/handlers.ts`, `wrangler.jsonc`,
`tsconfig.json`. It never writes those files again, and it never installs
packages. It names each missing package together with the install command.

## Start

Read [the reference service](docs/examples/reference-service/README.md).
It is a whole service with its smoke test. The installed docs are under
`node_modules/@aotter/mantle/docs/`: the handbook (`handbook/start/overview.md`),
the examples, the agent workflow skills (`skills/`), and
`upgrade-0.1-to-0.2.md` for projects on 0.1.x.

The decisions behind the design are ADR-0032 to ADR-0035 in `docs/adr/`.
