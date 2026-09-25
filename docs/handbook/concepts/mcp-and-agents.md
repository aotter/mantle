---
description: Mantle serves /mcp and /mcp/staff from the same Manifest — tool naming, the OAuth model, connecting a client, llms.txt, WebMCP and skills.
---
# MCP and agents

Mantle is an MCP server out of the box. Nothing is registered, exported or annotated to make it one: the same compiled plan that produces REST and Admin also produces the tool catalog, so an agent and a browser reach identical behavior through different transports. `/mcp` and `/mcp/staff` are that live-app catalog — Manifest → RuntimePlan verbs — not a how-to-author-Mantle manual. The CLI and pinned package docs are the authoring SSOT; MCP does not mirror the CLI. This page covers the two surfaces, how tools are named, how a client authenticates, and the rest of the agent-facing surface area.

## Two surfaces

| Mount | Caller | Exposes |
|---|---|---|
| `/mcp` | Any caller the site's HTTP routes would accept: OAuth bearer, same-origin cookie session, or anonymous. Each tool's `requires` decides; a `tools/call` that needs identity answers `401` with the OAuth challenge | Views with `surface: public`, and Procedures reached by an MCP Trigger with `surface: public` |
| `/mcp/staff` | Authenticated caller holding a staff role | Views with `surface: staff`, the generic authoring tools (rank-gated at `tools/call`), Procedures reached by an MCP Trigger with `surface: staff` |

Both accept tokens for one canonical protected resource, `${PUBLIC_ORIGIN}/mcp`. `/mcp/staff` is a stricter server-side role projection, not a second OAuth audience.

## Tool naming

A tool name is derived from a manifest name by `mcpToolNameSegment`: lowercased, with `-` replaced by `_`.

| Tool | Produced by | Surface |
|---|---|---|
| `query_view_<segment>` | Public or staff View (never internal) | The View's own `surface` |
| `create_draft_<schema>`, `update_draft_<schema>` | A Schema with `lifecycle: publishing` | Staff |
| `create_record_<schema>`, `update_record_<schema>` | A Schema with `lifecycle: operational` | Staff |
| `request_publish`, `unpublish_entry`, `archive_entry`, `delete_entry` | Present when an applicable Schema exists | Staff |
| `create_media_upload`, `commit_media_upload` | Media storage bound and at least one purpose declared | Staff |
| `read_entry` | At least one interaction: a Procedure `target` or `x-mantle-ref` into a declared Schema | Staff |
| `<procedure segment>` | A Trigger with `source.kind: mcp` | The Trigger's `source.surface` |

A Schema whose root `schema` sets `readOnly: true` gets no authoring tools; its declared Procedures still work. Update tools add required `id` and `expected_version` arguments, and fields carrying `x-mantle-bind` are stripped from authoring tool schemas because the runtime stamps them. Those generic names (including `read_entry`) and the `create_draft_`, `update_draft_`, `create_record_`, `update_record_` and `query_view_` prefixes are reserved; a collision is rejected at validation with `MCP_TOOL_NAME_COLLISION`.

An *interaction* is a Procedure that acts on an entry of a Schema: through its operation `target` (declared as `spec.target`, or implied by a builtin `update`, `delete` or `archive` on `id`), or through an input that carries `x-mantle-ref`. Each one is compiled into the plan with its input bindings. A declarative View over that Schema, whose rows include every bound field (and `version` when the target locks it), lists the interaction in its tool description, for example `Row actions: review_requisition (id = row.id, expectedVersion = row.version).`, so an agent that has a row knows how to act on it. Only tools on the same surface are listed. `read_entry` reads one entry by `collection` and `id`, including its `version`, and is bounded to the Schemas some interaction is about: a model provider's context only receives records someone declared an operation for.

Procedures are never exposed on their own. A Procedure becomes a tool only through a Trigger of `kind: mcp`, exactly as it becomes a route only through a Trigger of `kind: http`. Writing a Procedure with no Trigger gives you typed logic that nothing can call from outside — which is what a guard Procedure or a cron-invoked Procedure wants. See [Writes: Procedures, Triggers and hooks](./procedures-and-triggers.md).

## Tool results

A successful `tools/call` returns the result serialized as JSON in one `text` content block. When the result is a JSON object — for example a View page, an entry returned by an authoring tool, or the output of a Procedure whose `output` is an object — the same value is also returned as `structuredContent`. Arrays and primitives have only the text block, because MCP requires `structuredContent` to be an object.

A Procedure tool advertises an `outputSchema` when its declared `output` can be stated so that a standard JSON Schema validator accepts every value the runtime accepts. The advertised schema can be looser than the declaration: `format` and `x-*` keywords are dropped, `nullable` becomes a `null` type, and `required` keeps only declared properties that have no `default`. An output that uses keywords the two validators disagree on, such as `oneOf`, `pattern`, `uniqueItems` or `contains`, advertises no `outputSchema`; the runtime still enforces the full declaration. Views advertise no `outputSchema`, because View rows have no declared row schema.

A business failure, such as a denied role, a version conflict or invalid arguments, is a tool result with `isError: true`, so the agent can read it and decide what to do. The text block carries `{ "diagnostics": [Diagnostic] }` in the [diagnostic shape](../reference/diagnostics.md). The same payload is also `structuredContent`, unless the tool advertises an `outputSchema`: structured results must conform to that schema. Protocol failures, such as a malformed request, an unknown tool or an unsupported protocol version, stay JSON-RPC errors. Two cases are answered over HTTP before any tool runs:

- An anonymous call to a tool that requires identity gets `401` with the OAuth challenge.
- An OAuth token that lacks a scope the tool declares with `ctx.auth.scope` gets `403 insufficient_scope`, which names the missing scopes so the client can step up — when the authorization server can issue them (`grantableScopes` on the Cloudflare MCP handler, which defaults to `mcp`). A scope it cannot issue gives the tool's `AUTH_DENIED` result instead, since re-authorizing would not help.

The MCP surface is served by the official MCP TypeScript SDK through `@aotter/mantle-mcp`. It answers both the 2026-07-28 protocol and 2025-era stateless clients. Clients built on an MCP SDK need nothing more. A hand-written client, such as a `curl` smoke test, must send `Accept: application/json, text/event-stream` (without it the request gets `406`) and must read an answer that may arrive as one server-sent event: the JSON-RPC message is on its `data:` line.

## Keeping an action human-only

A confirmation step in a chat UI, and a tool marked app-only, do not prove that a person made the decision: a host sends every call with the same credential the model uses. When an action must stay with people, keep it off MCP entirely:

1. Mark the Schema `readOnly: true`. Generic authoring tools then neither list nor write it.
2. Give the approval Procedure a `ctx.staff` requirement and **only an HTTP Trigger**. No MCP catalog lists it, and Admin still offers it as a staff operation.

REST accepts no OAuth bearer unless the host enables `jwtBearer`, and then only for its own audience. So a token issued for `/mcp` cannot call the HTTP Trigger either. Core has no separate approval mechanism (ADR-0029 D3).

## The OAuth model

The Cloudflare adapter runs one Better Auth 1.7 instance for staff identity, authorization, consent, client registration and MCP resource verification. Client identity is CIMD-first — the MCP 2026-07-28 Client ID Metadata Document profile, which is why the Worker needs the `global_fetch_strictly_public` flag to fetch client metadata across the public Internet boundary. Unauthenticated Dynamic Client Registration remains available as a bounded path with a 90-day default lifetime for clients that do not present CIMD. One non-colon scope, `mcp`, is advertised in `scopes_supported`, because clients such as claude.ai reject colon-shaped scopes; per-surface enforcement then happens server-side, not through scope strings. Authorization is session-bound: the JWT's originating Better Auth session must still exist and be unexpired, so signing out of Admin also ends that session's MCP access, and a refresh token is not an independent authorization. Invalid credentials on either mount, and anonymous requests to `/mcp/staff`, answer `401` with a `WWW-Authenticate` challenge pointing at the RFC 9728 protected-resource metadata document served under the auth mount; on `/mcp` an anonymous caller can list tools and call anonymous ones, and receives the same `401` challenge from the first `tools/call` whose target requires identity. Authorization endpoints live under `/api/auth/oauth2/*` and are discovered from the advertised metadata, never hard-coded.

## Connecting a local client

Start the dev server and use the exact origin it prints. Before touching client configuration, confirm the endpoint is reachable and protected:

```sh
curl -i http://localhost:8787/mcp
```

An OAuth-protected endpoint answers `401` with a `WWW-Authenticate` resource-metadata challenge before sign-in. A `503 setup_incomplete` instead means Auth configuration is missing; see [Authentication](../cloudflare/authentication.md).

Prefer the client's native remote HTTP and OAuth support. Use a standard HTTP-to-stdio bridge only when the client accepts stdio MCP servers and cannot connect to remote HTTP directly:

```sh
npx -y mcp-remote http://localhost:8787/mcp
```

Mantle owns no local proxy and no auth-bypass mode. After connecting, inspect `tools/list`, then make one read-only `query_view_*` call before invoking any mutation — it proves the credential, the surface and the data path in one step that cannot damage anything. Use project-scoped client configuration where the client offers it, and never commit OAuth tokens or the bridge's token cache.

> **Discovery is not enforcement**
> `tools/list` filtering is UX. Every `tools/call` re-evaluates the manifest predicates and the guard through the same evaluator REST uses, so a guessed tool name gains nothing. See [Authorization](./authorization.md).

## The agent-readable web surface

When a Worker mounts public pages, the same content is served in a form agents can read without parsing HTML:

- **Markdown mirrors.** Every entry page has a `.md` twin at the same path, and entry pages advertise it with `<link rel="alternate" type="text/markdown">`.
- **`llms.txt` indexes.** `GET /llms.txt` lists the site; `GET /:locale/llms.txt` lists one locale. Pages hold 50 entries, ordered `updatedAt DESC, id DESC`, with a forward `cursor`, a `Link: ...; rel="next"` header and a `## Continue` section.
- **Sitemap.** `GET /sitemap.xml` returns a urlset, or an index linking `/sitemap.xml?part=1&cursor=...` parts of up to 2,000 URLs each.

Only `status: published` entries appear anywhere in that set. Details are in [Public web, SEO and cache](../cloudflare/public-web.md).

## WebMCP in the browser

### Admin: tools for the signed-in staff member

Admin UI registers staff tools in browsers supporting `document.modelContext`.
The catalog comes from `GET /admin/api/webmcp`; calls use
`POST /admin/api/mcp` with the current staff session. Server-side role checks,
Procedure authorization, and optimistic concurrency remain in force.
`admin_get_context` and `admin_navigate` add page context and navigation.
The WebMCP control appears after registration succeeds; unsupported browsers
can continue using the regular Admin UI.

Owners can explore application API documentation in Developer UI:
`/admin/dev/docs/api` for HTTP, `/admin/dev/docs/mcp` for remote MCP, and
`/admin/dev/docs/webmcp` for the Admin catalog and public-page capabilities.
These pages show projected definitions. Remote clients connect to the host's
advertised MCP endpoints using the authentication described above.
See the [Admin API guide](../../../packages/mantle-admin/README.md#admin-webmcp).

### Public pages: opt-in registration

`@aotter/mantle-web/webmcp` exposes public capabilities as tools inside a page, for browsers implementing the draft imperative WebMCP API. Importing the subpath has no side effect; registration starts only when `bindWebMcp()` is called.

```ts
import { bindWebMcp } from "@aotter/mantle-web/webmcp";

const binding = await bindWebMcp();
// later, when the page or app scope ends
binding.dispose();
```

It feature-detects `document.modelContext` and returns `{ supported: false }` on browsers without it. This public-page binding registers only public capabilities. Staff tools use the separate authenticated Admin integration above. Existing host tool names are inspected and skipped, never replaced. A server-backed page discovers the safe descriptors published at `GET /api/views` and calls the same-origin `GET /api/views/<name>` routes; a browser-local SPA passes `projectCallableCapabilities(plan, { surface: "public" })` and its own invoker. Procedure tools must still originate from an explicit public MCP Trigger, and invocation enters the runtime through that Trigger, so browser tools cannot bypass validation or authorization. See [Runtime pipeline and adapters](./runtime-and-adapters.md).

## Skills for your coding agent

The installed SDK ships version-matched instructions for agents working on a Mantle project. Project them into the repository:

```sh
pnpm exec mantle skills
pnpm exec mantle skills --check
```

This copies every skill the installed package marks `projection: project` — the develop skill among them — into matching `.agents/skills/mantle-*` and `.claude/skills/mantle-*` paths. Both layouts receive identical bytes; `--check` detects drift without writing. Skills that act destructively or target one platform stay out of that set and are opt-in. Manifest generation never rewrites agent instructions.

The bootstrap `mantle` skill is also available from the plugin marketplace.
The ongoing workflows come from the installed SDK through `mantle skills`:

```sh
# Canonical
npx skills add aotter/mantle

# Claude Code — two separate prompts
/plugin marketplace add aotter/mantle
/plugin install mantle@mantle
```

Never point a versioned project at a mutable branch. See [Project layout and the CLI loop](../start/project-and-cli.md).

## Source
- [`docs/adapter-guide.md`](../../../docs/adapter-guide.md)
- [`docs/adr/0014-auth-better-auth-and-multi-tenant-mcp.md`](../../../docs/adr/0014-auth-better-auth-and-multi-tenant-mcp.md)
- [`packages/mantle-spec/src/domain/service/McpToolNaming.ts`](../../../packages/mantle-spec/src/domain/service/McpToolNaming.ts)
- [`packages/mantle-web/README.md`](../../../packages/mantle-web/README.md)
- [`packages/mantle/README.md`](../../../packages/mantle/README.md)
- [`packages/adapters/cloudflare/README.md`](../../../packages/adapters/cloudflare/README.md)
- [`docs/skills/develop/SKILL.md`](../../skills/develop/SKILL.md)
