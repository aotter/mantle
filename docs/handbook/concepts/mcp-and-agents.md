# MCP and agents

Mount generated `mcp()` with the app's native handle and verified Caller resolver. The official MCP SDK loads only on a matching request. Optional auth stays behind the application's dynamic auth import.

| Endpoint | Tools |
| --- | --- |
| `/mcp` | Public Views and Procedures exposed by public MCP Triggers |
| `/mcp/staff` | Staff Views, staff Trigger Procedures, generated publishing transitions and selected product tools |

Names are snake-case; a View named `my-orders` becomes `my_orders`. Each call retains declared authorization, scoped/TTL/publication SQL and input checks. Staff tools require staff authority. Tool visibility and UI hints grant no authority. Cookie-session mutations retain origin checks.

Views return structured `{ rows, nextCursor? }`. SQL Procedures retain native `{ results }`; application ref results remain app-owned. Selected boundaries redact native errors. Never retry an uncertain write automatically.

The app owns OAuth configuration, discovery and consent; follow [OAuth](../guides/oauth.md) and [authentication](../cloudflare/authentication.md). Public anonymous reads can avoid auth entirely; invalid supplied credentials cannot become anonymous. Authority-sensitive endpoints retain fresh primary checks.

[MCP Apps](../guides/mcp-apps.md) add static UI resources through the public contributor hook. Admin uses the same hook from its separate package. Credentials never go in App HTML. WebMCP catalogues are generated display/tool metadata for the mounted Admin product; server checks remain authoritative.

See [surface contracts](../reference/surface.md) for tool schemas, challenges and scalar conversion.
