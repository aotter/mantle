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
  public: app, admin: [adminMcpApps(adminOptions), adminApp],
} });
```

Use your own `ui://<app>/…` prefix. `ui://mantle-admin/…` is reserved for Admin.
HTML is reusable static content; caller-specific data comes from tool results.
Build the front end with the official `@modelcontextprotocol/ext-apps` client.
`renders` links tools to `_meta.ui.resourceUri`; `appOnly` adds
`visibility: ["app"]`. Both name tools actually exposed on that endpoint.
Resources may supply CSP, permissions, `prefersBorder` and `domain`; each is
passed through as the resource's `_meta.ui`. `domain` is the dedicated sandbox
origin for hosts that serve each App from its own origin; use the form that
host documents.

An HTML loader receives `{ tools }`, the same tool names this caller's
`tools/list` returns on the endpoint (with `authorize` configured, only those
it allows), so the HTML it renders names no tool the caller cannot see. Zero-argument loaders keep
working. `adminMcpApps` uses it: the catalogue it embeds holds only the Views
and row actions in `tools`. A host that caches the resource across callers
may hold an older catalogue; a View it does not describe still shows its rows,
with no action to open.

For static tool tables, construction checks contributors. Request-bound tool tables check on the first matching request and recheck changed tool names. Duplicate
resource URIs or names, conflicting tool ownership, and absent or foreign-endpoint
tools throw `ContractError` with code `MCP_APP_CONFLICT`. HTML loaders never run during import or handler construction. Treat descriptors as
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
An explicit capability declaration without UI support receives no UI resources, UI tool metadata or App-only tools. A stateless request with no capability declaration is treated as unknown and retains App support. Other tools retain their existing validation,
authorization, caller, origin and database behavior.

## The Admin App in a host

The Admin App speaks MCP Apps `2026-01-26` to the host and asks only for what
the host advertises in `hostCapabilities`:

- Without `serverTools` it is read-only: rows show, no row action opens and no
  list refresh is attempted.
- `format: "uri"` values with an `http(s)` URL open through `ui/open-link`
  when the host offers `openLinks`, and are plain text otherwise. The sandbox
  blocks navigation, so the App never uses `window.open` or `target="_blank"`.
- After a row action succeeds, `ui/update-model-context` tells the model the
  tool, the row id and the outcome, for its next turn. The App never sends
  `ui/message`, which would speak for the user.
- It declares `availableDisplayModes: ["inline", "fullscreen"]` and offers a
  full-screen toggle (`ui/request-display-mode`) when the host lists
  `fullscreen` in its context.
- `appInfo.version` is the `@aotter/mantle-admin` version.

Host context is validated before it is applied. `locale` and `timeZone` format
dates; `safeAreaInsets` become root padding; `containerDimensions` bound the
root (a bounded height scrolls, and the reported size stays within it);
`displayMode` is the root's `data-display-mode`. `theme: "dark"` sets both
`data-theme` and the `.dark` class. Only the spec's style variables are
applied. Neutral colors (background, text, border, ring, danger, info,
success, warning), `--font-sans`, `--font-mono`, font weights, text sizes and
radii follow the host; the primary color stays the App's own.

A View result carries its rows twice, as the JSON text block and as
`structuredContent`, and `limit` goes up to 500. Hosts may truncate long tool
results, and a truncated text block is no longer JSON, so keep the pages an
App renders small; the default is 50 rows.

Checks against real hosts need an account and a public HTTPS endpoint, so
they are manual: add the endpoint as a custom connector in each host, call a
View tool with an App, and check light and dark themes, a narrow window,
full screen, a row action, and a link. The automated interoperability test
uses the official `AppBridge` (`pnpm --filter @aotter/mantle-admin test:browser`).

