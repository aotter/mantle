---
name: plugin
description: Discover, plan, apply, and verify Mantle marketplace plugins through the Core SDK contract. Use when the user wants to add an installable capability without hand-planning provisioning steps.
metadata:
  source: "@aotter/mantle"
  sourcePath: docs/skills/plugin/SKILL.md
  applies_to: mantle grammar v0.1
  projection: project
---

# Mantle Plugin

Mantle plugins are Core SDK capability packages. They are not application
scaffolds (retired in ADR-0021) and they are not provider provisioning scripts.

A plugin may contribute:

- manifests: `Schema`, `View`, `Procedure`, `Trigger`;
- handler source or handler registration notes;
- site defaults or media policy additions;
- expected HTTP, admin, and MCP surfaces;
- adapter capability requirements and provider setup notes.

## User Install Entry

The user-facing install path is:

```txt
Use repo-local mantle:plugin to install <plugin slug or recipe URL> in this repo.
Use repo-local mantle:plugin to update <plugin id> in this repo.
Use repo-local mantle:plugin to remove <plugin id> from this repo.
```

There is no `mantle plugin add` CLI yet. Do not invent one. Install from a
marketplace entry, plugin package, or recipe URL that declares enough data for
an agent to apply the capability deterministically.

A valid marketplace entry must include:

- plugin id, title, source, and version;
- supported Mantle version range;
- files, manifests, handlers, routes, MCP tools, and admin surfaces it adds;
- adapter capabilities and provider resources it requires;
- required env vars and secrets, without secret values;
- verification commands and expected surfaces.

If the marketplace page is only marketing copy or lacks an install recipe,
stop and ask for the recipe instead of guessing.

## First Read

1. `package.json` for Mantle version and adapter package.
2. The manifest directory selected by project scripts for current atom names
   and route/tool collisions.
3. The actual host entry and its handler, template and port registrations;
   `src/mantle/config.ts` and `src/mantle/handlers/` are conventions, not required paths.
4. `.mantle/plugins.json` and `.mantle/plugins.lock.json` if present.
5. `.mantle/launch-state.json` only as context, not as plugin authority.

Read version-matched contracts under `node_modules/@aotter/mantle/docs/`,
starting with `handbook/reference/features.md`. Plugin recipes cannot override
the installed grammar.

## Plan First

Before applying any plugin, produce a plan:

- files to add or change;
- atoms to add and their names;
- HTTP routes and MCP tools that will appear;
- required runtime ports;
- adapter-specific resources, env vars, and secrets;
- checks to run.

If the plugin needs a capability the current adapter does not expose, stop
with the missing capability instead of inventing provider steps.

## Apply

Apply the smallest deterministic diff. Do not run arbitrary install scripts
from a plugin package. Copy declared files, wire declared handlers, update the
plugin ledger, then validate.

Suggested ledger paths:

```txt
.mantle/plugins.json
.mantle/plugins.lock.json
```

Keep optional legacy launch files such as `.mantle/features.json` separate from
plugin state. They are not the Core plugin ledger.

## Update

Compare the installed lock entry against the marketplace entry or recipe URL.
Apply only the declared version diff, update `.mantle/plugins.lock.json`, then
run the same verification checks.

## Remove

Use the lock entry as the removal manifest. Delete only files and atoms owned
by that plugin, unwind handler registrations it added, remove its ledger entry,
then validate. If another plugin or local code depends on a removed atom, stop
and report the dependency instead of deleting through it.

## Verify

Use the project's validation and typecheck scripts when present. Regenerate
the plan after manifest changes before probing the running host:

```bash
pnpm exec mantle validate
pnpm exec mantle generate
pnpm exec mantle generate --check
# Run the project's TypeScript check and restart its local server.
```

Then verify the plugin's declared surfaces:

- public Views via `GET /api/views/<name>`, staff Views via authenticated
  Admin/staff MCP, and internal Views through the host binding;
- HTTP Trigger path for public writes;
- Staff/Public MCP `tools/list` for MCP Trigger or Schema-derived tools;
- adapter resource presence when the plugin requires optional ports.

## Don't

- Don't treat an application template as a plugin.
- Don't assume Cloudflare; inspect the active adapter and capability ports.
- Don't create a second skill namespace for host-specific plugins.
- Don't commit secrets. Provider secrets stay in the platform secret store.
