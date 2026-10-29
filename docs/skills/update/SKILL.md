---
name: update
description: Upgrade a Mantle project's @aotter/mantle packages to a new exact version, including the move from 0.1.x to 0.2, without overwriting application-owned code.
metadata:
  source: "@aotter/mantle"
  sourcePath: docs/skills/update/SKILL.md
  applies_to: mantle 0.2
  projection: package
---

# Mantle Update

## Workflow

Read the installed SDK README, then follow the version-matched project and CLI
workflow (`mantle help start/project-and-cli`) before editing.

For 0.1.x, follow the installed upgrade guide,
`node_modules/@aotter/mantle/docs/upgrade-0.1-to-0.2.md`. Mantle
ships no migration tool: plan the data move from
its "Moving data from 0.1.x" section,
verify each fact against the generated `schema.sql` and the 0.1.4 export, and
have the plan reviewed. Give the 0.2 service a new database, rehearse the load
on a copy, never boot 0.2 against a 0.1.x database, and keep exports out of the
repository. The guide's appendix is historical; do not follow it. Between 0.2
versions, apply reviewed migrations rehearsed on a copy.

For the stable 0.2 line, pin every selected Mantle package to `0.2.0`; to try the 0.2.1 prerelease, pin all of them to `0.2.1-alpha.2` and read its release notes. Do not upgrade an existing application by following a moving dist-tag.

Pin exact target SDK/peer versions and read its release notes and Admin build
instructions. Core-to-native replaces app imports/wiring; it is not
a package-only update. For 0.2-to-0.2 updates, preserve users, sessions, content
and application code; review emitted SQL/policy diffs and rehearse explicit
data-preserving schema/auth/role migrations on a copy. Initial schema.sql never
authorizes rebuilding production tables. Verify auth/Admin/MCP/REST, locks and
persistence before authorized cutover.

Follow Customising Admin (`mantle help guides/native-admin`)
for the current application-built Admin; old UI subpaths have no compatibility
aliases. Pin only actually published versions, or explicitly use a matching
workspace preview. Recheck member and Admin OTP, all affected native routes,
private field visibility, OCC and unknown outcomes. Do not publish a package as
part of an application dependency update.
