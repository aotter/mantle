---
description: The public and staff MCP surfaces, which tools a plan lists, how agents authenticate with OAuth, MCP Apps resources, and Admin's WebMCP catalog.
---
# MCP and agents

`createMcpSurface(runtime, { basePath, surface })` from `@aotter/mantle/mcp`
serves a plan's tools over MCP's Streamable HTTP transport. The generated
preset mounts two:

| Mount | Surface | Who | Authenticates with |
|---|---|---|---|
| `/mcp` | `public` | anyone; each tool's `requires` still applies | an OAuth bearer token (identity `mantle`), or whatever your resolver accepts |
| `/mcp/staff` | `staff` | staff only | the same OAuth bearer token as `/mcp` (with identity `mantle`; any identity but `none`) |

Both run behind `withCaller(resolver, …)`, so a tool sees the same
[Caller](./authorization.md) as a REST call.

## Which tools

A surface lists exactly:

- each Procedure bound by a Trigger `{ kind: mcp, surface: <this surface> }`,
  named after the Procedure in snake case (`place-order` is `place_order`);
- each View whose `surface` is this one, as a read-only tool with the View's
  `input` plus `limit` and `cursor`.

A Schema is never a tool: there are no generated create, update or publish
record tools. To let an agent change rows, declare a Procedure and an `mcp`
Trigger for it.

- **Description.** A Procedure's or View's `description` is the tool's
  description. Write it for an agent deciding what to call.
  `MCP_TOOL_DESCRIPTION_MISSING` warns when an exposed Procedure has none.
- **Annotations.** A View is `readOnlyHint: true`. A Procedure may declare
  `mcp: { readOnlyHint, destructiveHint, openWorldHint }`, which the tool
  carries as written.
- **Output.** An object `output` becomes the tool's `outputSchema`, and the
  result is returned as structured content.
- **Errors.** A refused call is a tool error result carrying the diagnostic
  code (`AUTH_DENIED`, `CONFLICT`, …). An anonymous call to a tool that
  `requires` a caller is HTTP 401 with a `WWW-Authenticate` challenge, so an
  MCP client starts OAuth.

Listing is not permission: every `tools/call` checks `requires` and the guard
again.

## OAuth for agents (identity `mantle`)

`createMantleAuth` runs Better Auth's OAuth provider with `mcpResource:
{PUBLIC_ORIGIN}/mcp`. An MCP client discovers it from the 401 challenge's
`resource_metadata` (`/.well-known/oauth-protected-resource/mcp`), registers,
sends the user through sign-in and consent (`/oauth/consent`), and calls `/mcp`
with the token. The resolver (`createCallerResolver(auth, { jwtBearer: { audience, scopes: ["mcp"] } })`)
verifies it on every request and reads the user's current role; nothing is
cached. Every MCP surface also keeps the scope floor (ADR-0014): a credential
other than a cookie session (an OAuth token, an API key, a personal token)
must carry `mcp` before any tool is listed or called, or the request is HTTP
403 `insufficient_scope`; `createMcpSurface`'s `requiredScopes` changes the
floor. When an OAuth token lacks a scope a tool's `requires` names, the call
is HTTP 403 with an `insufficient_scope` challenge naming the scopes to ask
for.

## Staff tools

The preset mounts the staff surface at `/mcp/staff` whenever it mounts `/mcp`
and has an identity. It shares the `/mcp` audience, so one token with the `mcp`
scope reaches both:

```ts
const staffMcp = withCaller(resolver,
  createMcpSurface(runtime, { basePath: "/mcp/staff", surface: "staff", resourceMetadata }),
  { resourceMetadata });
```

`resourceMetadata` is the `/mcp` metadata URL. The staff surface admits only
callers with a staff role, and the role is read on every request.

## WebMCP in Admin

`GET /admin/api/webmcp` returns `{ tools, calls, routes }`: the staff tool
catalog (the same list `/mcp/staff` returns from `tools/list`), what runs each
tool (`calls`: a Procedure through `POST /admin/api/operations/<name>`, a View
through `GET /admin/api/views/<name>`), and the Admin page each tool belongs to
(a Procedure with a `target` maps to its collection, a View to its report). A
browser agent in the console registers these tools and runs them on Admin's
own routes with the signed-in session; Admin itself answers no MCP.

## MCP Apps

`createMcpSurface(runtime, { …, apps: { resources: [...] } })` serves `ui://`
resources beside the tools. Each resource names the tools whose results it
`renders`, and may name `appOnly` View tools that only the App can call. A
client without MCP Apps support never sees app-only tools. The HTML is a static
asset; caller data travels only in tool results.

0.2.0 ships no built-in App for this option. The 0.1.x interaction App in
`@aotter/mantle-ui/mcp-app` was built for the 0.1.x tools and is not wired to
0.2.0 surfaces.

## Further reading

- [Reads: Views, REST and MCP](./views.md)
- [HTTP, MCP, CLI and packages](../reference/surface.md)
