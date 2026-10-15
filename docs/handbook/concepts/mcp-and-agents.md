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

## When a host shows old tools

A fresh `tools/list` always returns the deployed tools, but many hosts keep their own copy and do not ask again after a deploy. Mantle sends no list-changed notifications: tools change only at deploy, and the hosts that keep copies do not act on them. Instead each generated tool's description ends with its own version, and the results of a call that reaches the tool carry the deployed version, so a model holding an older definition can see it, correct its call or ask the user to refresh. Failures also state the input schema the tool is listed with now, except authorization refusals. A call naming a tool the catalogue no longer has gets the protocol's unknown-tool error, whose message gives `serverInfo.version`: unless the application sets it, a hash of every tool the endpoint serves, before per-caller filtering. Refusals before a call reaches its tool, such as authentication challenges, carry neither.

In Admin, WebMCP results from the tool route carry the version, and refusals add it with the input schema, except authorization refusals; a tool removed since the page loaded is refused as not found, without a catalogue version. Admin's two navigation tools, `admin_get_context` and `admin_navigate`, carry no version: the page defines and runs them without a server call, so it cannot list one definition and run another, and a reload after a deploy replaces both. The exact shapes are in [surface contracts](../reference/surface.md#tool-versions).

How each client refreshes its copy (as of 2026-10):

| Client | Refresh |
| --- | --- |
| claude.ai connectors | A server-side copy keyed by URL, kept about an hour (users report up to 24 hours). Only adding the connector again under a new URL, such as `?v=2`, forces a refresh, and that needs authorization again. |
| Claude Code | `/mcp` reconnect, or a new session |
| ChatGPT developer mode | Refresh the connection, then start a new chat |
| Published ChatGPT apps | A daily scan, or Rescan, followed by review; keep tools compatible meanwhile |
| Cursor | Quit fully and reopen |
| VS Code | Run "MCP: Reset Cached Tools", or restart the server |
| Gemini CLI | `/mcp reload` |
| MCP Inspector | The refresh button |
