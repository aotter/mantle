---
name: update
description: Review and upgrade Mantle SDK dependencies and project-local skills while preserving application source, provider identities and plugin lockfiles.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/update/SKILL.md
  applies_to: mantle grammar v0.1
  projection: project, plugin
---

# Mantle Update

Upgrade SDK dependencies deliberately; never overwrite application-owned code.
There is no `mantle update` CLI. This skill is the version-matched upgrade
workflow.

1. Inspect git status, package.json, lockfile, actual project scripts and
   installed versions. Preserve unrelated local changes. Read plugin locks
   and leftover `.mantle` metadata if present; they are context, not required.
2. Select an explicit target release and read that release's installed docs.
   Do not compare the project to a baseline template or invent a homepage.
3. Update only selected `@aotter/mantle*` dependencies to the same exact target
   version, preserving dependency sections. Use the package manager to update
   the lockfile; inspect the dependency diff and required peer changes.
4. Keep all application manifests, handlers, routes, theme, Worker/D1/KV names,
   origins, provider bindings and secrets. Apply API edits individually; do
   not copy the reference consumer over a real application.
5. Use the upgraded package to regenerate machine-owned bindings and project
   its skills, then run the application's validation, types and tests:

```sh
pnpm exec mantle generate
pnpm exec mantle generate --check
pnpm exec mantle skills
pnpm exec mantle skills --check
pnpm exec mantle validate
```

Start the local application and test its actual routes, including configured
auth behavior. Review the final source/lockfile/generated diff; unexpected
provider or user-source changes block completion. Provider credentials must
never enter git or logs. Report exact old/new versions, checks, and remaining
migration work. A dependency update does not authorize a production deploy.
