# Recipe: an MCP App for members

The preset serves Mantle's App on `/mcp/staff` only. A member-facing App, on
`/mcp`, is the application's: the SDK attaches none, because what a member
should see in a chat (one order, a booking form, a status card) is a product
decision. Build it case by case from these pieces.

## Pieces

| Piece | From | What it gives |
|---|---|---|
| `apps: { resources: [...] }` | `createMcpSurface` (`@aotter/mantle/mcp`) | a `ui://` resource beside the tools; `renders` names the tools whose results it shows, `appOnly` the View tools only the App may call |
| `appCatalog(plan, "public")`, `withCatalog(html, catalog)` | `@aotter/mantle/mcp` | each public View tool's columns as the fields they read, and the row operations, embedded in your HTML as `#mantle-catalog` |
| `planApp(plan, { surface: "public", html: mantleAppHtml })` | `@aotter/mantle/mcp`, `@aotter/mantle-ui/mcp-app` | the staff App as is, for every public View: the quickest start when a list is what you want |
| `App` | `@modelcontextprotocol/ext-apps` | the host bridge: `ontoolresult`, `ontoolinput`, `callServerTool`, the host's locale and theme |
| `renderDataValue`, `propertyLabel`, `optionLabel` | `@aotter/mantle-ui` | a value as Admin shows it: money, dates, option titles, in the host's locale |
| `createInteractionController` | `@aotter/mantle-ui/controller` | one operation on one row: review, submit once, a refusal or `CONFLICT` kept, never retried |
| `OperationPanel`, `SchemaFields`, the kit | `@aotter/mantle-ui`, `@aotter/mantle-ui/kit` | Admin's panel and form controls |

`docs/handbook/concepts/mcp-and-agents.md` (MCP Apps) describes the catalog
and the staff App these share.

## Steps

1. Decide what the App shows and which tool's result opens it. It renders a
   tool the surface already serves: a public View, or a Procedure with an
   `mcp` Trigger on `public`. Add that Trigger or View first; an App never
   reaches data a tool does not.
2. Build one self-contained HTML file: Vite with `vite-plugin-singlefile` (and
   React, if you use the components). A host loads the App in a sandbox that
   fetches nothing else unless the resource's `csp` allows it.
3. Serve it. Import the built file as text: in `wrangler.jsonc`,
   `"rules": [{ "type": "Text", "globs": ["**/*.html"], "fallthrough": true }]`,
   declare `declare module "*.html" { const html: string; export default html; }`
   for TypeScript, then in `src/service.ts`:

   ```ts
   import memberHtml from "../app/dist/member.html";
   import { appCatalog, withCatalog } from "@aotter/mantle/mcp";

   const html = withCatalog(memberHtml, appCatalog(runtime.plan, "public"));
   const mcp = guard(createMcpSurface(runtime, { basePath: "/mcp", surface: "public", resourceMetadata,
     apps: { resources: [{ uri: "ui://shop/my-orders", name: "my-orders", html, renders: ["my_orders"] }] } }), { resourceMetadata });
   ```

4. In the App, read the result in `ontoolresult` (`structuredContent`, or the
   JSON text block when the tool has an output schema), and the tool's name
   from `_meta["net.aotter.mantle/tool"]`. Call tools with
   `app.callServerTool`; a failure's `{ diagnostics }` carries the code
   (`AUTH_DENIED`, `CONFLICT`, ...).

## Rules

- The HTML is a static asset: no caller data, no secrets, the same for every
  member. Caller data arrives only in tool results.
- Every read and write is a tool call under the member's own token; `requires`
  and `scope` apply exactly as they do to the model's calls.
- `appOnly` hides a read from the model; only a View can be app-only, never a
  write.
- A public View shows published rows only. A member's own rows come from a
  `scope`d Schema read with `auth.uid()`.

## Verify

`tools/list` from a client that declares the MCP Apps extension shows the
rendered tool with `_meta.ui.resourceUri`; `resources/read` of that URI returns
your HTML with `#mantle-catalog`; a call to the tool returns its result with
`_meta["net.aotter.mantle/tool"]`. Then open it in a host that renders MCP
Apps, signed in as a member.
