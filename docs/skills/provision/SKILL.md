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

Read the installed SDK README, then follow the version-matched [project and CLI
workflow](../../handbook/start/project-and-cli.md) before editing.

Deploy/create resources only within the user's authorization; reuse configured
host resources. Apply reviewed and rehearsed migrations before routing traffic;
imports/first requests perform no DDL or schema checks. Keep auth dynamic, production
secrets in the host store, trusted HTTPS origin and verified bootstrap rule,
production email and selected media wiring. Configure Admin ASSETS worker-first
as in [Workers assets and secrets](../../handbook/cloudflare/service-entry.md#workers-assets-and-secrets). Hyperdrive caching stays off; PG settings are deployment-owned.
Keep the Workers [public-fetch flags](../../handbook/cloudflare/deploy-and-operate.md#public-fetch-routing),
including environment overrides; verify deployed MCP with a real OAuth bearer
(`initialize` and `tools/list`), not only a browser session cookie.
Bun uses native Database/SQL, an app server and scheduler. Verify admin sign-in
(role admin), denied access, public reads, a persisted write, MCP and selected UI.
Report artifact/resources/checks and keep rollback artifacts.

For ChatGPT Sites, follow [Mantle on ChatGPT Sites](../../handbook/cloudflare/chatgpt-sites.md).

The app builds Admin with `mantle bundle`; serve it as [Native
Admin](../../handbook/guides/native-admin.md) describes. Verify both member and
admin OTP/UI flows. Deployment of an authorized application does not authorize
SDK publication; a workspace preview remains a preview.
