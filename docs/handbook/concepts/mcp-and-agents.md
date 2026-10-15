# MCP and agents

Mount generated `mcp()` with the app's native handle and verified Caller resolver. The official MCP SDK loads only on a matching request. Optional auth stays behind the application's dynamic auth import.

| Endpoint | Tools |
| --- | --- |
| `/mcp` | Public Views and Procedures exposed by public MCP Triggers |
| `/mcp/admin` | Admin Views, admin Trigger Procedures, generated publishing transitions and selected product tools |

Names are snake-case; a View named `my-orders` becomes `my_orders`. Each call retains declared authorization, scoped/TTL/publication SQL and input checks. Admin tools require admin authority. Tool visibility and UI hints grant no authority. Cookie-session mutations retain origin checks.

Views return structured `{ rows, nextCursor? }`. SQL Procedures retain native `{ results }`; application ref results remain app-owned. Selected boundaries redact native errors. Never retry an uncertain write automatically.

The app owns OAuth configuration, discovery and consent; follow [OAuth](../guides/oauth.md) and [authentication](../cloudflare/authentication.md). Public anonymous reads can avoid auth entirely; invalid supplied credentials cannot become anonymous. Authority-sensitive endpoints retain fresh primary checks.

[MCP Apps](../guides/mcp-apps.md) add static UI resources through the public contributor hook. Admin uses the same hook from its separate package. Credentials never go in App HTML. WebMCP catalogues are generated display/tool metadata for the mounted Admin product; server checks remain authoritative.

See [surface contracts](../reference/surface.md) for tool schemas, challenges and scalar conversion.

## Catalogue freshness

The served, authenticated `tools/list` for the intended Caller, surface and locale
is the runtime tool-contract authority: names, descriptions, `inputSchema` and
`outputSchema` all matter. Generated files, version numbers and successful
`tools/call` results do not establish what a host discovered. Use standard MCP
discovery; no app-specific well-known catalogue route is required. Standard OAuth
discovery remains separate.

For modern 2026 MCP, the upstream SDK supplies native cache hints `ttlMs: 0` and
`cacheScope: private` by default. Apps need no cache-hint wrapper. With no bus,
Mantle advertises `tools.listChanged: false`. An optional upstream
`ServerEventBus` passed to generated `mcp({ ...options, bus })` enables modern
subscriptions and advertises `listChanged: true`; legacy stateless connections
still advertise false. The upstream SDK owns subscription and notification
framing; do not implement a parallel SSE protocol.

```ts
// App-owned module, lazy-loaded only after matching the MCP route.
import { InMemoryServerEventBus } from '@modelcontextprotocol/server';
const bus = new InMemoryServerEventBus();
// Pass this same bus to generated mcp({ ...options, bus }) across requests.
// After an actual catalogue change, including a description-only change:
bus.publish({ kind: 'tools_list_changed' });
```

Keep that optional SDK import outside Worker startup. The event is a content-free,
app-wide invalidation, not a catalogue or a per-user payload: clients rediscover
under their own current authority and locale. The app owns bus lifetime and
tenant boundaries; separate buses where event timing must remain private. An
in-memory bus reaches connected listeners in one process/isolate only, not other
Workers, disconnected clients or replacement deployments. Cross-instance delivery
needs app-owned shared pub/sub when required; a per-request new bus cannot reach
other requests.

After any tool-contract change, compare actual authenticated `tools/list` locally
and after deployment, including unchanged names whose descriptions or schemas
changed. Retest relevant calls and verify member/admin/scope isolation. Keep
credentials out of evidence. If the served catalogue is correct but a host retains
old schemas, request that host's tool rediscovery/refresh; the server cannot force
an external host to replace its cache. Preserve existing sessions and OAuth
grants. Do not revoke consent, rotate secrets or force users to log in to refresh
tool metadata.
