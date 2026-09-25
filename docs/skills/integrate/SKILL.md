---
name: integrate
description: Integrate Mantle into an existing application. Use when the application has its own code, routes, storage or deployment and the owner wants to add Mantle, replace part of it, or rebuild with Mantle while migrating frontend and data.
metadata:
  source: "@aotter/mantle"
  sourcePath: docs/skills/integrate/SKILL.md
  applies_to: mantle grammar v0.1
  projection: package
  projectionReason: Existing-project migration is opt-in; a fresh generated app does not need this brief.
---

# Integrate Mantle into an existing application

Work in the target application. Read its installed `@aotter/mantle` version,
CLI help and package-local docs before editing. If Mantle is absent, inspect
the application first, then install an exact SDK version only after choosing an
integration strategy. Use the installed version's contract; do not copy
`develop` branch examples into an older consumer.

## Inspect and decide

Map the actual entry points, router, frontend, auth, storage, data volume and
relationships, deployment pipeline, URLs, background jobs and existing tests.
Identify which behavior the owner wants Mantle to own and what must remain
stable. Compare three approaches using the application's evidence:

1. **Embed selectively:** keep the host and call Mantle's parser, Runtime or
   selected surfaces through its documented package APIs. The host owns wiring.
2. **Replace incrementally:** move one bounded capability at a time. Define
   where reads and writes go during coexistence and how each step is checked.
3. **Rebuild and migrate:** create a separate new Mantle application, port the
   frontend and business behavior, and transform/import existing data. Prefer
   this when adapting the old structure costs more than rebuilding. Preserve
   relevant IDs, relations, URLs and identity semantics; rehearse the data
   transfer before a production cutover.

Explain the chosen path and its concrete tradeoffs to the owner. A small
prototype or read-only inventory may resolve uncertainty. Do not run a generic
project converter or assume the current application's shape matches a
generated Cloudflare or ChatGPT Sites skeleton.

## Implement and verify

- For embedding, retain user-owned entry/config/build files. Use the installed
  direct-authoring docs and CLI to validate manifests and emit bindings; wire
  the selected Mantle capabilities into the existing host explicitly.
- For incremental replacement, establish a clear owner for each data write
  and request route at every stage. Verify old and new behavior together.
- For rebuilding, generate in a **separate directory** with the installed
  CLI, move frontend and handlers deliberately, and plan data mapping and
  import separately. Review database migrations before application or cutover.
- Run the application's build and representative behavior checks for the
  changed routes, auth and data. `mantle generate --check` checks generated
  output against its declared selection; it cannot certify host integration.
  For live data, record migration counts and a rollback or recovery path
  appropriate to the project.

Leave existing data and deployment untouched until the requested migration
and release steps are ready. Report which capabilities Mantle now owns,
what was verified, and what remains for application deployment or cutover.
