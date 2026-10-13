# MCP Apps

Generated `mcp()` accepts app-owned UI resources on either endpoint. Each
endpoint accepts one contributor or an array; Admin uses the same public hook:

```ts
import type { McpApps } from '@aotter/mantle/mcp';
import { adminMcpApps } from '@aotter/mantle-admin/mcp';
import { mcp } from './generated/mcp.js';

const app: McpApps = { resources: [{
  uri: 'ui://my-app/records', name: 'my-app-records',
  html: () => loadAppHtml(), renders: ['records'],
}] };
const handler = mcp({ db, caller, apps: {
  public: app, staff: [adminMcpApps(adminOptions), staffApp],
} });
```

Use your own `ui://<app>/…` prefix. `ui://mantle-admin/…` is reserved for Admin.
HTML is reusable static content; caller-specific data comes from tool results.
Build the front end with the official `@modelcontextprotocol/ext-apps` client.
`renders` links tools to `_meta.ui.resourceUri`; `appOnly` adds
`visibility: ["app"]`. Both name tools actually exposed on that endpoint.
Resources may supply CSP, permissions and `prefersBorder`.

The first matching request checks that endpoint's contributors once. Duplicate
resource URIs or names, conflicting tool ownership, and absent or foreign-endpoint
tools throw `ContractError` with code `MCP_APP_CONFLICT`. App checks and HTML
loaders never run during import or handler construction. Treat descriptors as
immutable after construction. HTML loads only on `resources/read`; failures
return a redacted internal error.

Clients advertise `io.modelcontextprotocol/ui` and MIME type
`text/html;profile=mcp-app` in initialization capabilities or, for stateless
requests, in `params._meta["io.modelcontextprotocol/clientCapabilities"]`.
Clients without this capability receive no UI resources, no UI tool metadata
and no App-only tools. Other tools retain their existing validation,
authorization, caller, origin and database behavior.

# MCP Apps

Generated `mcp()` accepts app-owned UI resources on either endpoint. Each
endpoint accepts one contributor or an array; Admin uses the same public hook:

```ts
import type { McpApps } from '@aotter/mantle/mcp';
import { adminMcpApps } from '@aotter/mantle-admin/mcp';
import { mcp } from './generated/mcp.js';

const app: McpApps = { resources: [{
  uri: 'ui://my-app/records', name: 'my-app-records',
  html: () => loadAppHtml(), renders: ['records'],
}] };
const handler = mcp({ db, caller, apps: {
  public: app, staff: [adminMcpApps(adminOptions), staffApp],
} });
```

Use your own `ui://<app>/…` prefix. `ui://mantle-admin/…` is reserved for Admin.
HTML is reusable static content; caller-specific data comes from tool results.
Build the front end with the official `@modelcontextprotocol/ext-apps` client.
`renders` links tools to `_meta.ui.resourceUri`; `appOnly` adds
`visibility: ["app"]`. Both name tools actually exposed on that endpoint.
Resources may supply CSP, permissions and `prefersBorder`.

The first matching request checks that endpoint's contributors once. Duplicate
resource URIs or names, conflicting tool ownership, and absent or foreign-endpoint
tools throw `ContractError` with code `MCP_APP_CONFLICT`. App checks and HTML
loaders never run during import or handler construction. Treat descriptors as
immutable after construction. HTML loads only on `resources/read`; failures
return a redacted internal error.

Generated media-enabled handlers keep the same cache while resolving their tool
table against each request's environment. Database handles, storage and Caller
are never retained in that cache. The low-level SDK also accepts an async
`(request, env) => tools` resolver; its names must match the endpoint's App
catalogue. If its tool names change, those links are checked again, and a call
always uses the current request's tool table.

Clients advertise `io.modelcontextprotocol/ui` and MIME type
`text/html;profile=mcp-app` in initialization capabilities or, for stateless
requests, in `params._meta["io.modelcontextprotocol/clientCapabilities"]`.
Clients without this capability receive no UI resources, no UI tool metadata
and no App-only tools. Other tools retain their existing validation,
authorization, caller, origin and database behavior.
