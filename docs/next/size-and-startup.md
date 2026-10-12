# Size and startup gates

## Executable bundle regression gate

`pnpm --filter @aotter/mantle-next check:size` generates the tracked purchase
fixture and builds two Worker fetch entries retaining every View/Procedure with
`mantle bundle`, the split build `mantle generate` configures for Wrangler. The
PostgreSQL entry includes postgres.js; the D1 entry uses the native binding. It
excludes the seed, oracle and timing harness, rejects old compiler/runtime and Zod
sources, and checks every uploaded chunk against `size-budgets.json`, reporting the
startup graph (the entry and its static imports) beside it. A direct View entry must
stay below 4 KiB. Operations stay in `generated.ts`: lazily importing each one saved
about 14 µs of startup per operation (420 operations: 9.9 → 3.6 ms in Node, ~1 ms on
Workers) at the cost of one uploaded module per operation, so it was not adopted.
The normal package test command runs this gate.

The same command builds one Worker per surface from the `surfaces.yaml` fixture —
REST only, MCP only, web only, and all three — and gates each startup graph against
`startup:<surface>` in `size-budgets.json`. These are the bytes a deployment loads
for each mounted surface; the MCP SDK stays a request-time chunk. Generated modules
run no kernel code at import: a paged View exports a function over a constant spec,
and REST routes carry their compiled path patterns.

`check:package` enforces the published file allowlist and three ceilings: the
runtime JavaScript a Worker can load (`dist/kernel` and `dist/auth`, `runtime` in
`size-budgets.json`), and the whole package as an install-size limit (100 KiB packed,
384 KiB unpacked in `scripts/check-package.ts`). The generator and CLI ship in the
same package; tree-shaking and `guardStartup` keep them out of every Worker.

## Startup

Cloudflare's official `startup_time_ms`, reported after deployment/version upload,
measures platform parsing and global execution. Offline dry runs do not supply it,
and cloud writes remain outside local-only authorization. See the official
[startup documentation](https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time).
Workers `performance.now()` freezes between I/O events and cannot time synchronous
initialization; gate global startup, first use and warm calls separately.
Startup CPU acceptance is open (see the [supported/planned scope](compatibility.md#supported)).

## Compiler assembly

Deployment generation uses the pure `@aotter/mantle/compiler` entry for the
existing manifest validator, SQL policy/lowering and static surface metadata.
It does not load Core's Admin/MCP surface factories; Better Auth's build-time
`infrastructure/authSchema.ts` introspection loads only when `generateFromSources` receives `auth` options.
Generated request modules still import only the selected runtime leaves.

This import boundary is preparation for #1479, not a standalone release: the
temporary Next package still depends on the compiler in the workspace during
development. The final SDK must include that compiler and its declarations in
the same tarball, pass clean-install generation, and meet both whole-package
ceilings. Runtime/startup measurements alone do not prove that package gate.
