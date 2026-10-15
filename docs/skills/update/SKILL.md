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
resources; Better Auth’s admin plugin `adminRoles` defines the admin layer (default `["admin"]`); `ctx.admin` takes no role list ([authorization](../../handbook/cloudflare/authentication.md)).

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

For MCP upgrades, follow [catalogue freshness](../../handbook/concepts/mcp-and-agents.md#catalogue-freshness).
Capture actual authenticated `tools/list` before and after the local upgrade and
again on the deployed service. Compare names, descriptions, `inputSchema` and
`outputSchema` under the same intended Caller/surface/locale; metadata-only
changes require this check too. Generated files, version strings and successful
invocations cannot prove discovery parity. Retest affected calls and scoped
visibility without including credentials in evidence.

Standard discovery needs no app-specific well-known catalogue. Modern 2026
private, zero-TTL cache hints are native; an optional app-owned upstream bus can
invalidate modern subscriptions, with tenant boundaries and lazy SDK loading.
Its in-memory delivery does not survive a deployment or cross Worker isolates;
legacy stateless clients still have no live list-change capability. If a host
keeps old schemas after correct deployed discovery, use host rediscovery/refresh.
Preserve sessions and OAuth grants; never revoke them, rotate secrets or force
logout merely to refresh tool metadata.
