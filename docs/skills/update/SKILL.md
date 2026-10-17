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

Read the installed SDK README, then follow the version-matched [project and CLI
workflow](../../handbook/start/project-and-cli.md) before editing.

For 0.1.x, follow [Upgrade 0.1 to 0.2](../../upgrade-0.1-to-0.2.md): give the
0.2 service a new database and move data by export and import; never boot 0.2
against a 0.1.x database. Between 0.2 versions, apply reviewed migrations
rehearsed on a copy.

Pin exact target SDK/peer versions and read its release notes and Admin build
instructions. Core-to-native replaces app imports/wiring; it is not
a package-only update. For 0.2-to-0.2 updates, preserve users, sessions, content
and application code; review emitted SQL/policy diffs and rehearse explicit
data-preserving schema/auth/role migrations on a copy. Initial schema.sql never
authorizes rebuilding production tables. Verify auth/Admin/MCP/REST, locks and
persistence before authorized cutover.

Follow [Customising Admin](../../handbook/guides/native-admin.md#customising-admin)
for the current application-built Admin; old UI subpaths have no compatibility
aliases. Pin only actually published versions, or explicitly use a matching
workspace preview. Recheck member and Admin OTP, all affected native routes,
private field visibility, OCC and unknown outcomes. Do not publish a package as
part of an application dependency update.
