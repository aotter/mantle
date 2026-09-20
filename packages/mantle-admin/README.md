# @aotter/mantle-admin

Optional Admin composition for Mantle. It owns Admin routes, API projections,
staff gates, and the static asset contract while reusing the same Core runtime
operations and authorization policy as programmatic callers.

Platform adapters supply identity/session resolution, request context, and an
`AdminAssetServer`. Omitting this package mounts no Admin routes and requires
no static assets.

### Host-owned identity and MCP

`@aotter/mantle-admin` exports the host contracts instead of selecting an
identity provider or remote MCP route:

```ts
import {
  mountMantleAdmin,
  type AdminAuth,
  type AdminMcpEndpoints,
} from "@aotter/mantle-admin";

const auth: AdminAuth = createHostAuth();
const mcpEndpoints: AdminMcpEndpoints = {
  public: "/agent/read",
  staff: null,
};

mountMantleAdmin(app, { plan, auth, assets, get, mcpEndpoints });
```

Implement `AdminAuth` against the host's trusted identity and staff store.
Mantle uses it for current-session resolution, fresh role checks, staff lists,
invitations and role changes. An implementation may wrap Better Auth or use a
platform identity such as ChatGPT Sites; Mantle Admin does not require either.

`AdminMcpEndpoints` reports routes the host actually mounted. Relative paths
resolve against the site's configured public origin, absolute URLs remain
absolute, and `null` disables that surface in Admin. This option advertises
routes and filters the displayed catalog; it does not mount an MCP handler.
Omitting it retains the conventional `/mcp` and `/mcp/staff` defaults.

OAuth consent and connected-app surfaces live here too. Adapters implement the
platform-neutral `MantleOAuthAuth` contract and may call `handleMantleOAuth`
directly; `mountMantleOAuth` is the existing thin Hono bridge. Admin assets use
the shared React/shadcn UI, while no-assets deployments receive only a minimal
functional HTML fallback.

### Admin WebMCP

Admin exposes the canonical **staff** MCP catalog at `GET /admin/api/webmcp`
and accepts JSON-RPC calls at `POST /admin/api/mcp` using the current staff
session. Descriptions, schemas, media upload tools and diagnostics match MCP.
The Admin UI registers these tools when `document.modelContext` is available,
adds page context/navigation, and shows a green WebMCP help/prompt control.
See [ADR-lite #861](../../docs/adr/adr-lite-861-admin-webmcp.md) for the preview
bridge, authorization and binary upload boundaries.
