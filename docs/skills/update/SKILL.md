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

Read the installed SDK README and version-matched handbook before editing.

Follow the installed [native generation and service workflow](../../handbook/cloudflare/service-entry.md)
with its [native contract](../../handbook/guides/native-execution.md) and [supported declarations](../../handbook/reference/features.md). Commit
all generated output, run the same generation command with `--check`, and keep
bundle `dist/` untracked. The app owns its verified Caller, handlers and native
resources; OSS staff role is `staff`.

Pin exact target SDK/peer versions and read its release notes and Admin asset
installation instructions. Core-to-native replaces app imports/wiring; it is not
a package-only update. Preserve users, sessions, content and application code.
Review emitted SQL/policy diffs and rehearse explicit data-preserving schema/auth/role
migrations on a copy. Initial schema.sql never authorizes rebuilding production
tables. Verify auth/Admin/MCP/REST, locks and persistence before authorized cutover.

Follow [Native Admin](../../handbook/guides/native-admin.md) for the three-package
SDK/Admin/shared-kit split and asset/extension/MCP App subpath moves; old UI
subpaths have no compatibility aliases. Pin only actually published versions,
or explicitly use a matching workspace preview. Recheck member and Admin OTP,
all affected native routes, private field visibility, OCC and unknown outcomes.
Do not publish a package as part of an application dependency update.
