# ADR-0026: Progressive application generation

**Status:** Accepted by owner for the 0.1.5 line (#1081–#1086). Supersedes the no-initialization clause of ADR-0021; direct authorship and optional package boundaries remain.

Mantle is progressive. A new application defaults to Spec, Runtime, API, MCP, Admin, and an editable blank Web home so an agent does not forget the optional Admin composition. `--features` is a positive replacement list over `spec,runtime,api,mcp,admin,web`; dependencies are closed automatically. `spec` alone is host-free. The first generated hosts are `cf` and `chatgpt-sites`. Only host-dependent selections require `--host`; a TTY may prompt, while headless use must pass it explicitly.

| Feature | Required features | Direct package additions |
| --- | --- | --- |
| `spec` | — | `@aotter/mantle`, `zod` peer |
| `runtime` | `spec` | Host adapter; current CF adapter also brings Admin/Auth/Web transitively |
| `api` | `runtime` | Host route composition and `hono` peer |
| `mcp` | `runtime` | Host MCP route composition |
| `admin` | `runtime,api,mcp` | `@aotter/mantle-admin`, `@aotter/mantle-admin-ui`; CF owner auth also uses `@aotter/mantle-auth` |
| `web` | `runtime` | `@aotter/mantle-web` and a user-owned blank home |

The host adapter's declared peers (`better-auth`, `hono`, `zod`, `aws4fetch`) are installed for host-dependent selections until its package dependency graph is split. A reduced selection still omits unselected routes and assets; it does not claim smaller transitive installation today.

An application with only Git, installed skills, package metadata, a lockfile, README, and installed dependencies is new. Existing manifests or application code remain in compile-only mode until `--adopt` is given. A saved `mantle.config.json` decides subsequent runs before that heuristic. V1 refuses host changes and feature-list changes after selection; application owners can make an explicit migration rather than have generation delete routes or data. An explicitly named missing manifest path is an error. A new default manifest directory may be absent or empty, yielding a valid empty plan without a fake business Schema.

Generation preflights selection, manifest validity, package/script conflicts, file ownership, and symlink escapes before writing. It saves the selection and adds only absent package declarations and scripts; it does not run a package manager. Selected Mantle packages use the running CLI's exact version. Missing selected packages produce an incomplete, nonzero result and an explicit install-and-rerun instruction. `--check` never writes, installs, prompts, or provisions. Generated code and assets remain CLI-owned; the editable frontend, host config, identity, secrets, handlers, and historical migrations are application-owned. A later SDK upgrade does not overwrite them. Clean builds remove only copied output.

Cloudflare currently has a facade with transitive Admin/Auth/Web dependencies and mounts OAuth/MCP unconditionally. Host generation must use a lower-level composition for reduced selections or change that facade; omitting dependencies from a manifest does not prove route omission. Cloudflare D1 remains runtime-managed. ChatGPT Sites uses reviewed, append-only managed migrations with applied-state checks (owned by #1086). Neither host generator provisions resources or deploys.

This decision restores a convenient default while keeping the sealed Manifest-to-RuntimePlan pipeline and user-owned application source. It does not reintroduce a remote Starter catalog or a `mantle create` command.
