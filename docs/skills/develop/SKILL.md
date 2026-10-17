---
name: develop
description: Work on an existing Mantle 0.2 project — manifests, SQL Views and Procedures, ref handlers, the service entry, surfaces, identity, MCP tool design and independent acceptance — using the installed package's contract.
metadata:
  source: "@aotter/mantle"
  sourcePath: docs/skills/develop/SKILL.md
  applies_to: mantle 0.2
  projection: package
---

# Mantle Develop

## Workflow

Read the installed SDK README, then follow the version-matched [project and CLI
workflow](../../handbook/start/project-and-cli.md) before editing.

Use the native Store/query/surface entries and app-owned fetch from the [service
composition guide](../../handbook/cloudflare/service-entry.md).
Keep optional modules out of unused entry imports and auth dynamically loaded.
Run actual public/member/admin HTTP, MCP and UI scenarios; verify stored state,
visibility, OCC and restart persistence, not just a 200 response.
Before reporting any user-facing work as done, follow the [independent
acceptance guide](../../handbook/guides/agent-workflow-acceptance.md): run it
with a fresh agent on the surface its user uses. This is not limited to MCP; if
it was not run, say so explicitly and report the work as UNVERIFIED rather than
done. For MCP workflows, also run the guide's design audit before implementing
tools.

For native Admin, read the [current guide](../../handbook/guides/native-admin.md):
the app builds Admin with `mantle bundle`. To customise pages, slots, hooks or
MCP-host-safe components, follow [Customising Admin](../../handbook/guides/native-admin.md#customising-admin).
Keep matching SDK, Admin and UI versions. Ref handlers retain caller-bound
`ctx.store`; generic Admin reads use shared generated View templates and writes
use native Procedure fragments.
Check actual member/Admin OTP, private scope/TTL/translation visibility, paging,
statistics, safe/exact OCC and no automatic retry after unknown 503 outcomes.

For application-owned MCP App entries and host checks, follow the [MCP Apps
guide](../../handbook/guides/mcp-apps.md).

Build a custom frontend with `App` from `@modelcontextprotocol/ext-apps`: register
`ontoolinput`/`ontoolresult` before `connect()`, and use `callServerTool` for
host-proxied calls. Keep protocol negotiation and message routing in the official
client; importing its types while writing a second `postMessage` bridge is
insufficient.

For Admin UI upgrades, follow the installed handbook's
[retained-page recipe](../../handbook/guides/mcp-apps.md#keep-old-conversations-working-after-an-upgrade).
Keep deployed snapshots in source/artifact storage and pass `previous` to
`adminMcpApps`; verify old conversations after a changed UI build without host
tool refresh, reconnection or cache clearing. Keep tool contracts compatible
through the declared retention window.


Place admin MCP Procedures in Admin deliberately: `spec.uiSchema.collectionAction:
<schema-name>` adds a collection-header action; `spec.target: { schema, id,
version? }` selects row actions and binds the row id / reviewed OCC version to
the named inputs. Other admin operations appear under Operations in the sidebar.
Keep state conditions in the SQL WHERE: simple AND equality/IN literals become
row-menu hints, while the Procedure remains the authority. Required-ref child
collections fold under their parent's sidebar group; with two or more required
`id` refs, set Schema `uiSchema.nav.parentField` to the parent's ref (generate
refuses otherwise); use `uiSchema.nav.standalone: true` for a top-level entry.

## Database changes

The runtime never creates, alters or checks tables. Boot and requests run no DDL, introspection or schema checks.

For the first install, apply generated `schema.sql`, including selected auth/site DDL, to an empty database. Apply selected seed SQL explicitly.

For every later schema change, the application's coding agent diffs the regenerated `schema.sql`, writes a migration with the host's native tool (`wrangler d1 migrations` or the app's PostgreSQL migration tool), rehearses it on a copy, and applies it before deploying the new code.

Destructive changes and type changes need explicit data migration. Mantle drops nothing. Initial `schema.sql` is not an upgrade script.

## Data paths

Writes use Store `insert` / `update` / `delete`, `batch`, `transaction`, or declared Procedures. Never use raw SQL writes: they bypass scope, TTL, publishing and system-column rules. For reads beyond an id lookup or simple AND filter (joins, aggregates, OR, reuse), declare an internal View so the SQL is reviewable and typed. Store `findById`, `find` and `first` remain suitable for handler lookups and embedding in an existing app. Ref handlers receive `ctx.store` bound to the same Caller and transaction.

For simple creates/partial updates, prefer Store-backed ref Procedures; keep
Procedure `requires`/generated input checks, use only allowed patch fields and
return safe business fields with the actual returned ID/version. Preserve
omitted fields and document null semantics. Retain SQL for atomic conditional
or related writes; D1 batches cannot consume an earlier result. Follow the
[Store write guidance](../../handbook/guides/typed-queries.md#prefer-store-backed-ref-procedures-for-simple-writes).
