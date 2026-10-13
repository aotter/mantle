---
description: The native 0.2.0 handbook and its three package boundaries.
---
# Mantle handbook

Mantle compiles a closed v2 manifest into native SQL and typed TypeScript. The app owns its database handle, verified Caller, routes, auth, migrations and deployment.

| Package | Responsibility |
| --- | --- |
| `@aotter/mantle` | SDK, private compiler, generator and `mantle` CLI |
| `@aotter/mantle-ui` | Pure UI kit and generic interaction controller; no SDK dependency |
| `@aotter/mantle-admin` | Admin server, SPA, extensions, preview and MCP App; SDK peer |

Start with [a Worker](quickstart-worker.md) or [CLI and targets](project-and-cli.md). Existing TypeScript/Node apps can import selected generated operations using their own handle and verified Caller; no router or identity replacement is required. See the packaged [integrate skill](../../skills/integrate/SKILL.md).

Choose [Store or internal Views](../guides/typed-queries.md), review [database and migration ownership](../concepts/runtime-and-adapters.md), and mount only selected [surfaces](../reference/surface.md). Optional [Admin](../guides/native-admin.md) lives in its own package. Installed SDK docs are the authority for that exact version. [Release notes](../releases/index.md) describe historical releases.
