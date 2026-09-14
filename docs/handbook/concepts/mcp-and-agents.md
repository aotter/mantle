---
description: Mantle serves /mcp and /mcp/staff from the same Manifest — tool naming, the OAuth model, connecting a client, llms.txt, WebMCP and skills.
---
# MCP and agents

Mantle is an MCP server out of the box. Nothing is registered, exported or annotated to make it one: the same compiled plan that produces REST and Admin also produces the tool catalog, so an agent and a browser reach identical behavior through different transports. This page covers the two surfaces, how tools are named, how a client authenticates, and the rest of the agent-facing surface area.

## Two surfaces

| Mount | Caller | Exposes |
|---|---|---|
| `/mcp` | Any authenticated OAuth caller; anonymous requests get `401` | Views with `surface: public`, and Procedures reached by an MCP Trigger with `surface: public` |
| `/mcp/staff` | Authenticated caller holding a staff role | Views with `surface: staff`, the generic authoring tools, Procedures reached by an MCP Trigger with `surface: staff` |

Both accept tokens for one canonical protected resource, `${PUBLIC_ORIGIN}/mcp`. `/mcp/staff` is a stricter server-side role projection, not a second OAuth audience.

## Tool naming

A tool name is derived from a manifest name by `mcpToolNameSegment`: lowercased, with `-` replaced by `_`.

| Tool | Produced by | Surface |
|---|---|---|
| `query_view_<segment>` | Any View | The View's own `surface` |
| `create_draft_<schema>`, `update_draft_<schema>` | A Schema with `lifecycle: publishing` | Staff |
| `create_record_<schema>`, `update_record_<schema>` | A Schema with `lifecycle: operational` | Staff |
| `list_entries`, `get_entry`, `request_publish`, `unpublish_entry`, `archive_entry`, `delete_entry` | Always present | Staff |
| `create_media_upload`, `commit_media_upload` | Media storage bound and at least one purpose declared | Staff |
| `<procedure segment>` | A Trigger with `source.kind: mcp` | The Trigger's `source.surface` |

A Schema whose root `schema` sets `readOnly: true` gets no authoring tools; its declared Procedures still work. Update tools add required `id` and `expected_version` arguments, and fields carrying `x-mantle-bind` are stripped from authoring tool schemas because the runtime stamps them. Those generic names and the `create_draft_`, `update_draft_`, `create_record_`, `update_record_` and `query_view_` prefixes are reserved; a collision is rejected at validation with `MCP_TOOL_NAME_COLLISION`.

Procedures are never exposed on their own. A Procedure becomes a tool only through a Trigger of `kind: mcp`, exactly as it becomes a route only through a Trigger of `kind: http`. Writing a Procedure with no Trigger gives you typed logic that nothing can call from outside — which is what a guard Procedure or a cron-invoked Procedure wants. See [Writes: Procedures, Triggers and hooks](./procedures-and-triggers.md).

## The OAuth model

The Cloudflare adapter runs one Better Auth 1.7 instance for staff identity, authorization, consent, client registration and MCP resource verification. Client identity is CIMD-first — the MCP 2026-07-28 Client ID Metadata Document profile, which is why the Worker needs the `global_fetch_strictly_public` flag to fetch client metadata across the public Internet boundary — with unauthenticated legacy DCR kept only as a bounded compatibility path for older clients, on the previous provider's 90-day default lifetime. One non-colon scope, `mcp`, is advertised in `scopes_supported`, because clients such as claude.ai reject colon-shaped scopes; per-surface enforcement then happens server-side, not through scope strings. Authorization is session-bound: the JWT's originating Better Auth session must still exist and be unexpired, so signing out of Admin also ends that session's MCP access, and a refresh token is not an independent authorization. Unauthenticated requests to either mount answer `401` with a `WWW-Authenticate` challenge pointing at the RFC 9728 protected-resource metadata document served under the auth mount. Authorization endpoints live under `/api/auth/oauth2/*` and are discovered from the advertised metadata, never hard-coded.

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

`@aotter/mantle-web/webmcp` exposes public capabilities as tools inside a page, for browsers implementing the draft imperative WebMCP API. Importing the subpath has no side effect; registration starts only when `bindWebMcp()` is called.

```ts
import { bindWebMcp } from "@aotter/mantle-web/webmcp";

const binding = await bindWebMcp();
// later, when the page or app scope ends
binding.dispose();
```

It feature-detects `document.modelContext` and returns `{ supported: false }` on browsers without it. Only public capabilities are registered — staff capabilities never leave the server. Existing host tool names are inspected and skipped, never replaced. A server-backed page discovers the safe descriptors published at `GET /api/views` and calls the same-origin `GET /api/views/<name>` routes; a browser-local SPA passes `projectCallableCapabilities(plan, { surface: "public" })` and its own invoker. Procedure tools must still originate from an explicit public MCP Trigger, and invocation enters the runtime through that Trigger, so browser tools cannot bypass validation or authorization. See [Runtime pipeline and adapters](./runtime-and-adapters.md).

## Skills for your coding agent

The installed SDK ships version-matched instructions for agents working on a Mantle project. Project them into the repository:

```sh
pnpm exec mantle skills
pnpm exec mantle skills --check
```

This copies every skill the installed package marks `projection: project` — the develop skill among them — into matching `.agents/skills/mantle-*` and `.claude/skills/mantle-*` paths. Both layouts receive identical bytes; `--check` detects drift without writing. Skills that act destructively or target one platform stay out of that set and are opt-in. Manifest generation never rewrites agent instructions.

For Claude Code, the same bundle is installable from the plugin marketplace at the exact installed version:

```sh
/plugin marketplace add aotter/mantle@v<installed-version>
```

Never point a versioned project at a mutable branch. See [Project layout and the CLI loop](../start/project-and-cli.md).

## Source
- [`docs/adapter-guide.md`](../../../docs/adapter-guide.md)
- [`docs/adr/0014-auth-better-auth-and-multi-tenant-mcp.md`](../../../docs/adr/0014-auth-better-auth-and-multi-tenant-mcp.md)
- [`docs/api-mcp-authorization.md`](../../../docs/api-mcp-authorization.md)
- [`packages/mantle-spec/src/domain/service/McpToolNaming.ts`](../../../packages/mantle-spec/src/domain/service/McpToolNaming.ts)
- [`packages/mantle-web/README.md`](../../../packages/mantle-web/README.md)
- [`packages/mantle/README.md`](../../../packages/mantle/README.md)
- [`packages/adapters/cloudflare/README.md`](../../../packages/adapters/cloudflare/README.md)
- [`skills/develop/SKILL.md`](../../../skills/develop/SKILL.md)
