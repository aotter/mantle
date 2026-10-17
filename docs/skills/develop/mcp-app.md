# Recipe: an MCP App for members

## Native applications

Read the installed MCP App contract. The SDK's generic hook attaches only the resources the app selects;
only selected modules enter the service.

```ts
import type { McpApps } from '@aotter/mantle/mcp';
import { mcp } from '../generated/mcp.js';
const memberApp: McpApps = { resources: [{
  uri: 'ui://shop/my-orders',
  name: 'my-orders-app',
  renders: ['my_orders'], // the tool for the declared public View my-orders
  html: async () => (await import('./member-app.js')).memberHtml,
}] };
const tools = mcp({ db, caller, handlers, apps: { public: memberApp } });
```

Each endpoint accepts one contributor or an array. The separate
`@aotter/mantle-admin` package contributes its admin App through this same
`apps.admin` hook; it owns `ui://mantle-admin/…`. App resources use their own
`ui://<app>/…` namespace. Duplicate resource URI/name, conflicting `renders`,
or `renders`/`appOnly` naming an unavailable endpoint tool (or a Procedure for
`appOnly`) fail when `mcp(...)` is built; with a request-bound tool table, the
tool names are checked on the first matching request. Only clients that
declare no MCP Apps support see no UI resources; a request that advertises no
capabilities at all is treated as supported.

Use `renders` for a declared tool; `appOnly` optionally hides it from non-UI
clients. Import HTML lazily; it carries no secrets or caller data. Tool results
use the caller's SQL policy, and an App cannot authorize a hidden admin tool.
Build a custom frontend with `App` from `@modelcontextprotocol/ext-apps`: register
`ontoolinput`/`ontoolresult` before `connect()`, and use `callServerTool` for host-proxied
calls. Keep protocol negotiation and message routing in the official client;
importing its types while writing a second `postMessage` bridge is insufficient.
Generic interaction components and controllers remain in `@aotter/mantle-ui`;
Admin-specific controllers/catalogues belong to `@aotter/mantle-admin`.

Verify tools/list metadata, resources/read, actual tool calls and a host-rendered
member App. Test anonymous/member isolation and resource conflicts. Never retry
unknown writes blindly; retain OCC and re-read state after an uncertain outcome.
Commit generated output and run generation with `--check` before deployment.
