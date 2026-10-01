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
| `readCatalog`, `toolOf`, `outputOf`, `rowsOf`, `invokeTool`, `actionsFor` | `@aotter/mantle-ui` | the catalog, a result's tool, its output and rows, and a tool call as the controller reads it, so the App never parses the wire itself |
| `renderDataValue`, `propertyLabel`, `optionLabel`, `OperationPanel` | `@aotter/mantle-ui` | a value as Admin shows it (money, dates, option titles, in the host's locale), and Admin's review-and-submit panel |
| `createInteractionController` | `@aotter/mantle-ui/controller` | one operation on one row: review, submit once, a refusal or `CONFLICT` kept, never retried |
| `SchemaFields` and the primitives | `@aotter/mantle-ui/kit`, styled by `@aotter/mantle-ui/kit.css` | Admin's form controls |

The App's own build installs what it imports: `@modelcontextprotocol/ext-apps`
at the exact version `@aotter/mantle` depends on, React and the kit's peers
(`@aotter/mantle-ui`'s README lists them). `docs/handbook/concepts/mcp-and-agents.md`
(MCP Apps) describes the catalog and the staff App these share.

## Steps

1. Decide what the App shows and which tool's result opens it. It renders a
   tool the surface already serves: a public View, or a Procedure with an
   `mcp` Trigger on `public`. Add that Trigger or View first; an App never
   reaches data a tool does not.
2. Build one self-contained HTML file, for example `app/dist/member.html`:
   Vite with `vite-plugin-singlefile` (and React, if you use the components).
   A host loads the App in a sandbox that fetches nothing else unless the
   resource's `csp` allows it. The build runs before `wrangler dev` and
   deploy: add it to the project's scripts.
3. Serve it. Wrangler imports `.html` as text; declare it for TypeScript in
   `src/env.d.ts` (`declare module "*.html" { const html: string; export default html; }`),
   then in `src/service.ts` (identity `mantle`, whose preset defines
   `resourceMetadata`; with `custom`, pass the surface to your own `guard`):

   ```ts
   import memberHtml from "../app/dist/member.html";
   import { appCatalog, withCatalog } from "@aotter/mantle/mcp";

   const html = withCatalog(memberHtml, appCatalog(runtime.plan, "public"));
   const mcp = guard(createMcpSurface(runtime, { basePath: "/mcp", surface: "public", resourceMetadata,
     apps: { resources: [{ uri: "ui://shop/my-orders", name: "my-orders", html, renders: ["my_orders"] }] } }), { resourceMetadata });
   ```

4. In the App, `readCatalog()` once; in `ontoolresult`, `toolOf(result)` names
   the tool and `outputOf(result)` (or `rowsOf` for a View) is its data. A
   success is `structuredContent` when the output is an object and the JSON
   text otherwise; a failure of a tool with an output schema is the text
   alone, which `outputOf` reads either way. Call tools through
   `invokeTool(app.callServerTool…)`: a refusal is `{ ok: false, diagnostics }`
   (`AUTH_DENIED`, `CONFLICT`, ...), and a thrown call (a 401 or 403 from a
   missing scope or sign-in, a lost connection) is an unknown outcome to
   re-read, never to retry blindly.

## Rules

- The HTML is a static asset: no caller data, no secrets, the same for every
  member. Caller data arrives only in tool results.
- Every read and write is a tool call under the member's own token; `requires`
  and `scope` apply exactly as they do to the model's calls.
- `appOnly` hides a read from the model; only a View can be app-only, never a
  write.
- A public View over a `publishing` Schema shows published rows only; over a
  `scope`d Schema it shows the caller's own rows, without a `WHERE` of yours.

## Verify

Add the App's build to the develop loop, then: `tools/list` from a client that
declares the MCP Apps extension shows the rendered tool with
`_meta.ui.resourceUri`; `resources/read` of that URI returns your HTML with
`#mantle-catalog`; a call to the tool returns its result with
`_meta["net.aotter.mantle/tool"]`. Then open it in a host that renders MCP
Apps, signed in as a member.
