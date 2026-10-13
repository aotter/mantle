---
name: provision
description: Ship a Mantle 0.2 project to production — Cloudflare Workers with D1, production sign-in and secrets, or ChatGPT Sites through its guide — and verify the deployed service.
metadata:
  source: "@aotter/mantle"
  sourcePath: docs/skills/provision/SKILL.md
  applies_to: mantle 0.2
  projection: package
  projectionReason: Creates remote resources and handles production secrets; opt-in only.
---

# Provision a Mantle project

## Workflow

Read the installed SDK README and version-matched handbook before editing.

Follow the installed [native generation and service workflow](../../handbook/cloudflare/service-entry.md)
with its [native contract](../../handbook/guides/native-execution.md) and [supported declarations](../../handbook/reference/features.md). Commit
all generated output, run the same generation command with `--check`, and keep
bundle `dist/` untracked. The app owns its verified Caller, handlers and native
resources; OSS staff role is `staff`.

Deploy/create resources only within the user's authorization; reuse configured
host resources. Apply reviewed and rehearsed migrations before routing traffic;
imports/first requests perform no DDL or schema checks. Keep auth dynamic, production
secrets in the host store, trusted HTTPS origin and verified bootstrap rule,
production email and selected media wiring. Configure Admin ASSETS worker-first
as in [Workers assets and secrets](../../handbook/cloudflare/service-entry.md#workers-assets-and-secrets). Hyperdrive caching stays off; PG settings are deployment-owned.
Bun uses native Database/SQL, an app server and scheduler. Verify staff sign-in
(role staff), denied access, public reads, a persisted write, MCP and selected UI.
Report artifact/resources/checks and keep rollback artifacts.

Use the installed [Native Admin](../../handbook/guides/native-admin.md) asset
contract and `entries(bindings.schemas, bindings.adapter)`. Admin SPA assets
belong to `@aotter/mantle-admin`, while UI supplies the shared kit. Verify both
member and staff OTP/UI flows. Deployment of an authorized application does
not authorize SDK publication; a workspace preview remains a preview.
