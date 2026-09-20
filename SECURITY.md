# Security policy

Do not report vulnerabilities in public issues or discussions.

## Reporting a vulnerability

Preferred path: open a private GitHub Security Advisory:

https://github.com/aotter/mantle/security/advisories/new

Fallback contact: `security@aotter.net`.

Include:

- affected package, starter, or deployed surface,
- reproduction steps,
- expected impact,
- whether credentials, tokens, user data, content data, or deployment resources are involved,
- any temporary mitigation you already applied.

## Response expectations

- Acknowledgement target: 3 business days.
- Initial triage target: 7 business days.
- Fix and disclosure timing depends on severity, exploitability, and release status.

These are targets, not contractual SLAs.

## Supported versions

Until v0.1.0, only the active `develop` line and latest alpha are considered supported for security fixes.

After v0.1.0, this file must be updated with the supported release window.

## Scope

Security-sensitive areas include:

- HTTP request handling,
- MCP endpoints,
- auth and session handling,
- staff role and permission enforcement,
- D1 / KV / asset storage boundaries,
- entry write chokepoints,
- render and content ingestion paths,
- deployment and provisioning scripts that handle credentials.

Manifest authoring is not itself a trust boundary. A consumer-provided manifest can still trigger security-relevant behavior when it affects auth predicates, public HTTP exposure, MCP tool exposure, render output, or persistence.

## Public handling

Once a fix is available, the maintainer may publish:

- a GitHub Security Advisory,
- release notes,
- a changelog entry,
- follow-up hardening issues without exploit detail.
