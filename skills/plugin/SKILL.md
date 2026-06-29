---
name: mantle:plugin
description: Discover, plan, apply, and verify Mantle marketplace plugins through the Core SDK contract. Use when the user wants to add an installable capability without hand-planning provisioning steps.
source: "@aotter/mantle"
sourcePath: skills/plugin/SKILL.md
when_to_invoke: |
  The user asks for a marketplace/plugin/capability install, or wants a domain feature that should be repeatable across starters and adapters.
applies_to: mantle@v0.1.0
---

# Mantle Plugin

Mantle plugins are Core SDK capability packages. They are not starter overlays
and they are not provider provisioning scripts.

A plugin may contribute:

- manifests: `Schema`, `View`, `Procedure`, `Trigger`;
- handler source or handler registration notes;
- site defaults or media policy additions;
- expected HTTP, admin, and MCP surfaces;
- adapter capability requirements and provider setup notes.

## First Read

1. `package.json` for Mantle version and adapter package.
2. `manifests/` for current atom names and route/tool collisions.
3. `src/mantleConfig.ts` for registered handlers, templates, and optional ports.
4. `.mantle/plugins.json` and `.mantle/plugins.lock.json` if present.
5. `.mantle/launch-state.json` only as context, not as plugin authority.

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

Keep starter launch state separate from plugin state. `.mantle/features.json`
is launch/starter context, not the Core plugin ledger.

## Verify

```bash
pnpm validate
pnpm typecheck
```

Then verify the plugin's declared surfaces:

- `GET /api/views/<name>` for View reads;
- HTTP Trigger path for public writes;
- Staff/Public MCP `tools/list` for MCP Trigger or Schema-derived tools;
- adapter resource presence when the plugin requires optional ports.

## Don't

- Don't treat a starter archetype as a plugin.
- Don't assume Cloudflare; inspect the active adapter and capability ports.
- Don't create a second skill namespace for starter-specific plugins.
- Don't commit secrets. Provider secrets stay in the platform secret store.
