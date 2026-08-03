# @aotter/mantle-runtime

Runtime engine for mantle.

This package owns the adapter-agnostic CMS core: dispatcher, content operations,
render pipeline, auth/session abstractions, MCP JSON-RPC dispatch, and the
runtime ports implemented by platform adapters.

Node-based tooling may import `@aotter/mantle-runtime/testing` for the real
SQLite access-path and HTTP sampling helpers. That subpath is intentionally
separate from the Worker-safe package entry.

For a fresh adapter implementation, start with
[`docs/adapter-guide.md`](../../docs/adapter-guide.md) and
[`docs/adr/0011-adapter-port-spec.md`](../../docs/adr/0011-adapter-port-spec.md).

Queue-backed `after_*` lifecycle delivery is optional and at-least-once. See
[`docs/deferred-lifecycle-queues.md`](../../docs/deferred-lifecycle-queues.md)
for the strict envelope, idempotency key, Cloudflare bindings, retry/DLQ
behavior, and upgrade procedure.

This package is prerelease software. Its `package.json` is the exact version
authority; the API surface may change until `v0.1.0`.
