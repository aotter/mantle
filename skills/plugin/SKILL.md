---
name: plugin
description: Add, update, or remove a declared Mantle capability with the smallest manifest and business-code diff.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/plugin/SKILL.md
  applies_to: mantle@v0.1.0
---

# Mantle Plugin

A plugin is a declared capability package, not a starter overlay or arbitrary
installer. There is no `mantle plugin add` command yet; do not invent one.

## First Read

1. `package.json`, `wrangler.jsonc`, and the installed Mantle version.
2. `manifests/` for atom and route collisions.
3. `src/handlers.ts` and `src/index.ts` for the current business and extension
   seams.
4. `.mantle/plugins.json` and `.mantle/plugins.lock.json` when present.

Require an install recipe that names its version, supported Mantle range,
files, atoms, handler refs, routes/tools, bindings, env/secrets, and checks.
Marketing copy is not an install recipe.

## Apply

Plan the exact files, atoms, public surfaces, provider resources, and checks.
Then make the smallest deterministic diff:

- add or edit manifest atoms;
- add only referenced handlers or business services;
- register a custom route through `createMantleWorker({ extend })` rather than
  creating a second router;
- add a binding or low-level adapter only when the declared capability needs
  it;
- record owned files/atoms in the plugin ledger.

Do not run arbitrary package install scripts or commit secrets. If the active
adapter lacks a required capability, stop and report that gap.

Regenerate and verify:

```bash
pnpm exec mantle generate
pnpm validate
pnpm check:generated
pnpm typecheck
pnpm check
```

Exercise every declared View, HTTP Trigger, and MCP tool. Test stored results,
not only successful envelopes.

## Update or Remove

Compare against the locked recipe version. Apply only its declared delta.
For removal, delete only files and atoms owned by that plugin; stop if local
code or another plugin depends on them. Never treat `.mantle/features.json` or
launch state as the plugin ownership ledger.
