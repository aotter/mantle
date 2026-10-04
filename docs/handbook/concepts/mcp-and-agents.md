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
  MCP client starts OAuth. When no tool on the surface may be called
  anonymously, every anonymous request is answered that way, `initialize`
  included, so a client asks for sign-in as soon as it connects.

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

`GET /admin/api/webmcp` returns `{ tools, routes }`: the staff tools (what
`/mcp/staff` lists, in its default locale) and, for each tool, the Admin page
it belongs to (a Procedure with a `target` maps to its collection, a View to its
report). A browser agent in the console registers these tools and calls one
with `POST /admin/api/webmcp/<tool>` and the input as the JSON body. Admin runs
it as `/mcp/staff` would, with the same input, an `mcp` cause and the signed-in
session, and answers `{ output }` or the refusal. Admin itself answers no MCP.
An MCP App's `appOnly` tools are hidden from MCP clients only; in Admin the
agent acts as the signed-in person, who can run every staff tool by hand.

## MCP Apps

`createMcpSurface(runtime, { …, apps: { resources: [...] } })` serves `ui://`
resources beside the tools. Each resource names the tools whose results it
`renders`, and may name `appOnly` View tools that only the App can call. A
client without MCP Apps support never sees app-only tools. The HTML is a static
asset; caller data travels only in tool results.

The preset serves Mantle's App on `/mcp/staff`:

```ts
import { planApp } from "@aotter/mantle/mcp";
import { mantleAppHtml } from "@aotter/mantle-ui/mcp-app";

createMcpSurface(runtime, { basePath: "/mcp/staff", surface: "staff", apps: { resources: [planApp(runtime.plan, { surface: "staff", html: mantleAppHtml })] }, resourceMetadata });
```

`planApp` renders every View tool of the surface and embeds the plan's catalog
in the HTML once: each View's columns as the Schema fields they read (so a
value is labelled and formatted as Admin shows it), and, for a View that reads
one table and outputs its `id`, the Procedure tools whose `target` is that
Schema. A host that renders MCP Apps shows a View's rows in the chat; a row
with an `id` (and a `version`, for an operation that locks one) offers those
operations through the same review-and-submit panel Admin uses. The row as
listed is what the person reviews: a version that moved since is the server's
`CONFLICT`. The catalog is the plan's, not the caller's, so an operation the
caller's role cannot run is offered and then refused. Every read and write is a
tool call under the caller's own token. A rendered result names its tool in
`_meta["net.aotter.mantle/tool"]`.

On the public surface, a member-facing App is the application's to build; the
SDK attaches none. The `develop` skill's
[MCP App recipe](../../skills/develop/mcp-app.md) lists the pieces.

## Further reading

- [Reads: Views, REST and MCP](./views.md)
- [HTTP, MCP, CLI and packages](../reference/surface.md)
