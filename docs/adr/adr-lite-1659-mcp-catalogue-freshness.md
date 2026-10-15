# ADR-lite #1659: Native MCP catalogue freshness

Status: Proposed for maintainer review. Implements the optional transport seam under ADR-0014 and ADR-0045.

The standard discovery authority remains authenticated `tools/list`. No public
well-known catalogue mirror, manifest field or parallel tool registry is added.
Descriptions and both schemas are part of the contract even when names stay the
same. A deployment must verify the actual served discovery as well as invocation.

The upstream MCP SDK owns protocol negotiation, cache-hint encoding,
`subscriptions/listen`, acknowledgement, filtering, subscription identifiers and
notification framing. Its modern default remains `ttlMs: 0` and
`cacheScope: private`; legacy responses do not acquire modern fields.

Mantle defaults to `tools.listChanged: false`. Applications may supply the
upstream `ServerEventBus` as `mcp({ bus, ... })`. The existing per-request native
handler passes that bus to upstream `createMcpHandler`; modern instances then
advertise list-changed support. Legacy stateless instances continue to advertise
false because they have no persistent delivery path. No second server factory,
custom event bus, notifier wrapper or hand-written SSE protocol is introduced.
The app publishes the native `{ kind: "tools_list_changed" }` event through its
bus. The event is an app-wide, content-free invalidation, not a tool catalogue.
Clients refetch `tools/list` under their own current authorization and locale.

The application owns bus lifetime and tenant boundaries. A shared bus does not
cache callers or definitions; request-specific visibility and authorization stay
at the existing boundary. Do not share a bus across tenants whose event timing
must remain private. An in-memory bus only reaches listeners in its process.
Multi-isolate Workers and multi-process deployments need application-owned shared
pub/sub if they require cross-instance delivery. Disconnected clients, old hosts
and replaced deployments are not guaranteed to receive an event; no consent
revocation, secret rotation or forced login is an invalidation mechanism.

Default applications need no bus. They use standard discovery and conservative
modern TTL, with documented client rediscovery when a host retains stale tools.
The SDK cannot force an external host to replace a cached callable schema.

Acceptance covers modern private zero-TTL defaults, legacy wire compatibility,
truthful capability defaults, real subscription delivery through the native bus,
metadata-only updates, closed input/output schema changes, tool add/remove and
fresh discovery after invalidation. Scope, caller, surface and locale remain
request-bound. Consumer agent workflows verify local and deployed authenticated
wire discovery without exporting credentials or requiring a custom URL.
