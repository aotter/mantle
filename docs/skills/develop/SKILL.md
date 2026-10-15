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

## Workflow

Read the installed SDK README and version-matched handbook before editing.

Follow the installed [native generation and service workflow](../../handbook/cloudflare/service-entry.md)
with its [native contract](../../handbook/guides/native-execution.md) and [supported declarations](../../handbook/reference/features.md). Commit
all generated output, run the same generation command with `--check`, and keep
bundle `dist/` untracked. The app owns its verified Caller, handlers and native
resources; Better Auth’s admin plugin `adminRoles` defines the admin layer (default `["admin"]`); `ctx.admin` takes no role list ([authorization](../../handbook/cloudflare/authentication.md)).

Use the native Store/query/surface entries and app-owned fetch from the service composition guide.
Keep optional modules out of unused entry imports and auth dynamically loaded.
Run actual public/member/admin HTTP, MCP and UI scenarios; verify stored state,
visibility, OCC and restart persistence, not just a 200 response.

For native Admin, read the [current guide](../../handbook/guides/native-admin.md).
Select `--admin` / `admin: true`; mount `entries(bindings.schemas, bindings.adapter)`
from the optional Admin package. Keep one Core SDK, the Admin product and shared
UI kit at matching versions. Generate → typecheck → implement listed handlers →
typecheck. Ref handlers retain caller-bound `ctx.store`; generic Admin reads
use shared generated View templates and writes use native Procedure fragments.
Check actual member/Admin OTP, private scope/TTL/translation visibility, paging,
statistics, safe/exact OCC and no automatic retry after unknown 503 outcomes.


Place admin MCP Procedures in Admin deliberately: `spec.uiSchema.collectionAction:
<schema-name>` adds a collection-header action; `spec.target: { schema, id,
version? }` selects row actions and binds the row id / reviewed OCC version to
the named inputs. Other admin operations appear under Operations in the sidebar.
Keep state conditions in the SQL WHERE: simple AND equality/IN literals become
row-menu hints, while the Procedure remains the authority. Required-ref child
collections fold under their parent's sidebar group; use Schema
`uiSchema.nav.standalone: true` for a top-level entry.

## MCP contract changes

Follow [MCP catalogue freshness](../../handbook/concepts/mcp-and-agents.md#catalogue-freshness).
For every metadata or schema edit, including description-only changes to an
unchanged tool name, compare actual authenticated `tools/list` locally and after
deployment: names, descriptions, input and output schemas, for the intended
Caller/surface/locale. Generated artifacts, package versions and successful tool
results do not replace wire discovery. Also exercise affected calls and authority
boundaries; record evidence without credentials.

Use standard MCP discovery, not an app-specific well-known catalogue. Modern
2026 private, zero-TTL hints are native defaults. Add the upstream SDK bus only
when live modern subscription invalidation is needed; the app owns its lifetime
and tenant boundary, and in-memory delivery does not cross Worker isolates or
deployments. Keep the optional SDK lazy-loaded. A stale host needs rediscovery,
not revoked grants, rotated secrets or forced logout.

## Database changes

The runtime never creates, alters or checks tables. Boot and requests run no DDL, introspection or schema checks.

For the first install, apply generated `schema.sql`, including selected auth/site DDL, to an empty database. Apply selected seed SQL explicitly.

For every later schema change, the application's coding agent diffs the regenerated `schema.sql`, writes a migration with the host's native tool (`wrangler d1 migrations` or the app's PostgreSQL migration tool), rehearses it on a copy, and applies it before deploying the new code. Cloud executes migrations at deploy time.

Destructive changes and type changes need explicit data migration. Mantle drops nothing. Initial `schema.sql` is not an upgrade script.

## Data paths

Writes use Store `insert` / `update` / `delete`, `batch`, `transaction`, or declared Procedures. Never use raw SQL writes: they bypass scope, TTL, publishing and system-column rules. For reads beyond an id lookup or simple AND filter (joins, aggregates, OR, reuse), declare an internal View so the SQL is reviewable and typed. Store `findById`, `find` and `first` remain suitable for handler lookups and embedding in an existing app. Ref handlers receive `ctx.store` bound to the same Caller and transaction.
