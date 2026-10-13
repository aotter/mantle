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
resources; OSS staff role is `staff`.

Use the native Store/query/surface entries and app-owned fetch from the service composition guide.
Keep optional modules out of unused entry imports and auth dynamically loaded.
Run actual public/member/staff HTTP, MCP and UI scenarios; verify stored state,
visibility, OCC and restart persistence, not just a 200 response.

For native Admin, read the [current guide](../../handbook/guides/native-admin.md).
Select `--admin` / `admin: true`; mount `entries(bindings.schemas, bindings.adapter)`
from the optional Admin package. Keep one Core SDK, the Admin product and shared
UI kit at matching versions. Generate → typecheck → implement listed handlers →
typecheck. Ref handlers retain caller-bound `ctx.store`; generic Admin reads
use shared generated View templates and writes use native Procedure fragments.
Check actual member/Admin OTP, private scope/TTL/translation visibility, paging,
statistics, safe/exact OCC and no automatic retry after unknown 503 outcomes.


Place staff MCP Procedures in Admin deliberately: `spec.uiSchema.collectionAction:
<schema-name>` adds a collection-header action; `spec.target: { schema, id,
version? }` selects row actions and binds the row id / reviewed OCC version to
the named inputs. Other staff operations appear under Operations in the sidebar.
Keep state conditions in the SQL WHERE: simple AND equality/IN literals become
row-menu hints, while the Procedure remains the authority. Required-ref child
collections fold under their parent's sidebar group; use Schema
`uiSchema.nav.standalone: true` for a top-level entry.

## Database changes

The runtime never creates, alters or checks tables. Boot and requests run no DDL, introspection or schema checks.

For the first install, apply generated `schema.sql`, including selected auth/site DDL, to an empty database. Apply selected seed SQL explicitly.

For every later schema change, the application's coding agent diffs the regenerated `schema.sql`, writes a migration with the host's native tool (`wrangler d1 migrations` or the app's PostgreSQL migration tool), rehearses it on a copy, and applies it before deploying the new code. Cloud executes migrations at deploy time.

Destructive changes and type changes need explicit data migration. Mantle drops nothing. Initial `schema.sql` is not an upgrade script.

## Data paths

Writes use Store `insert` / `update` / `delete`, `batch`, `transaction`, or declared Procedures. Never use raw SQL writes: they bypass scope, TTL, publishing and system-column rules. For reads beyond an id lookup or simple AND filter (joins, aggregates, OR, reuse), declare an internal View so the SQL is reviewable and typed. Store `findById`, `find` and `first` remain suitable for handler lookups and embedding in an existing app. Ref handlers receive `ctx.store` bound to the same Caller and transaction.
