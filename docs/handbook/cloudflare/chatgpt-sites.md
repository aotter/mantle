# Mantle on ChatGPT Sites

> **Verification status:** this guide is experimental and has not yet been exercised end to end on a real ChatGPT Site.

Treat the Site as an existing TypeScript host. Import selected generated Views/Procedures, pass the host's native handle and verified Caller, and compose only the surfaces it supports. Use [partial integration](../../skills/integrate/SKILL.md); Mantle supplies no Sites-specific identity or deployment adapter.

Choose postgres or sqlite according to the host's actual SQL executor. Custom handles are app-owned; a structural match alone does not guarantee driver semantics. [Database boundaries](../concepts/runtime-and-adapters.md) defines the supported drivers.

The runtime never creates, alters or checks tables. Apply initial `schema.sql` and selected auth/site DDL only to an empty database. For later changes the agent diffs regenerated SQL, writes and rehearses a host-native migration on a copy, and applies it before publishing new code. Destructive/type changes require explicit data migration; Mantle drops nothing.

Use the Site's native publication workflow. Configure trusted origin and verified identity there; never construct a system/admin Caller from browser input. Serving Admin also requires its app-built assets and shell security contract. Scheduling and storage provisioning belong to the host.
