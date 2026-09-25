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
| `read_entry` | A staff MCP Procedure with an operation target | Staff |
| `<procedure segment>` | A Trigger with `source.kind: mcp` | The Trigger's `source.surface` |

A Schema whose root `schema` sets `readOnly: true` gets no authoring tools; its declared Procedures still work. Update tools add required `id` and `expected_version` arguments, and fields carrying `x-mantle-bind` are stripped from authoring tool schemas because the runtime stamps them. Those generic names (including `read_entry`) and the `create_draft_`, `update_draft_`, `create_record_`, `update_record_` and `query_view_` prefixes are reserved; a collision is rejected at validation with `MCP_TOOL_NAME_COLLISION`.

An *interaction* is a Procedure that acts on an entry of a Schema: through its operation `target` (declared as `spec.target`, or implied by a builtin `update`, `delete`, `archive` or id-based `upsert` on `id`), or through an input that carries `x-mantle-ref`. Each one is compiled into the plan with its input bindings; the row's `version` is bound only where the operation compares it (a declared target's `version`, builtin `update` and `upsert`). A string-form `x-mantle-ref` that Admin still infers onto a field other than `id` gets no binding until the next minor release (ADR-0029 D8). A declarative View over that Schema, whose rows include every bound field (and `version` when the target locks it), lists the interaction in its tool description, for example `Row actions: review_requisition (id = row.id, expectedVersion = row.version).`, so an agent that has a row knows how to act on it. Only tools on the same surface are listed. `read_entry` reads one entry by `collection` and `id`, including its `version`, and is bounded to the operation targets of Procedures that are themselves staff MCP tools: a model provider's context only receives records an agent may already operate on. A target reachable only over HTTP or a schedule does not widen it; translation children are never included.

Procedures are never exposed on their own. A Procedure becomes a tool only through a Trigger of `kind: mcp`, exactly as it becomes a route only through a Trigger of `kind: http`. Writing a Procedure with no Trigger gives you typed logic that nothing can call from outside — which is what a guard Procedure or a cron-invoked Procedure wants. See [Writes: Procedures, Triggers and hooks](./procedures-and-triggers.md).

## Tool results

A successful `tools/call` returns the result serialized as JSON in one `text` content block. When the result is a JSON object — for example a View page, an entry returned by an authoring tool, or the output of a Procedure whose `output` is an object — the same value is also returned as `structuredContent`. Arrays and primitives have only the text block, because MCP requires `structuredContent` to be an object.

A Procedure tool advertises an `outputSchema` when its declared `output` can be stated so that a standard JSON Schema validator accepts every value the runtime accepts. The advertised schema can be looser than the declaration: `format` and `x-*` keywords are dropped, `nullable` becomes a `null` type, and `required` keeps only declared properties that have no `default`. An output that uses keywords the two validators disagree on, such as `oneOf`, `pattern`, `uniqueItems` or `contains`, advertises no `outputSchema`; the runtime still enforces the full declaration. Views advertise no `outputSchema`, because View rows have no declared row schema.

A business failure, such as a denied role, a version conflict or invalid arguments, is a tool result with `isError: true`, so the agent can read it and decide what to do. The text block carries `{ "diagnostics": [Diagnostic] }` in the [diagnostic shape](../reference/diagnostics.md). The same payload is also `structuredContent`, unless the tool advertises an `outputSchema`: structured results must conform to that schema. Protocol failures, such as a malformed request, an unknown tool or an unsupported protocol version, stay JSON-RPC errors. Two cases are answered over HTTP before any tool runs:

- An anonymous call to a tool that requires identity gets `401` with the OAuth challenge.
- An OAuth token that lacks a scope the tool declares with `ctx.auth.scope` gets `403 insufficient_scope`, which names the missing scopes so the client can step up — when the authorization server can issue them (`grantableScopes` on the Cloudflare MCP handler, which defaults to `mcp`). A scope it cannot issue gives the tool's `AUTH_DENIED` result instead, since re-authorizing would not help.

The MCP surface is served by the official MCP TypeScript SDK through `@aotter/mantle-mcp`. It answers both the 2026-07-28 protocol and 2025-era stateless clients. Clients built on an MCP SDK need nothing more. A hand-written client, such as a `curl` smoke test, must send `Accept: application/json, text/event-stream` (without it the request gets `406`) and must read an answer that may arrive as one server-sent event: the JSON-RPC message is on its `data:` line.

## MCP Apps

A host can render tool results as an interactive UI through [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps). Pass `apps` to `createMantleMcpHandler`, or to the Cloudflare `createMcpApiHandler`, for one surface. Each resource is a `ui://` HTML asset plus a rule for which tools render in it. Mantle registers it with the official `ext-apps` helpers, and the linked tools advertise `_meta.ui.resourceUri`.

- The HTML is reusable and never carries caller data or tokens. Per-call data travels only in each tool result's `structuredContent`, and every tool keeps its text content for hosts that render no UI.
- App-only helpers (`visibility: ["app"]`) must be declared read-only.
- Support is decided per request. A 2026-07-28 request that declares no MCP Apps support gets exactly the plain catalog.
- A stateless 2025-era request declares nothing. It gets the App metadata and the app-only tools. Hosts without MCP Apps ignore the metadata, but the model may see and call those read-only tools.
- Resources are per surface: a staff App is never readable on `/mcp`.

### The built-in interaction App

`@aotter/mantle-ui/mcp-app` ships one self-contained HTML App that shows a View's rows and runs the row actions those rows feed. Register it per surface:

```ts
import { interactionAppResource } from "@aotter/mantle-ui/mcp-app";

export default createMantleWorker({
  plan,
  handlers,
  mcpApps: {
    staff: { resources: [interactionAppResource()] },
    public: { resources: [interactionAppResource()] },
  },
});
```

`staff` Apps are served on `/mcp/staff`, which exists only while the Admin surface does: with `surfaces: { admin: false }`, `mcpApps.staff` is ignored.

Every App-linked View tool result carries `_meta["net.aotter.mantle/interaction"]`, whether or not the View has row actions. It names:

- the View tool, which the App calls again to refresh;
- the source collection;
- `read`, the tool that reads one entry, when the surface has one (`read_entry` on staff surfaces only);
- each row action: its tool name, title, input schema, the row fields it binds and the version input it locks.

Error results carry no such metadata. The App reads nothing else. Each read and write is a server tool call through the host (`callServerTool`), under the caller's own MCP authorization. The App holds no credentials, opening it has no side effect, and the Admin itself still refuses to be embedded. It submits from script rather than through a browser form, so it works in hosts that sandbox Apps without `allow-forms`, and it follows the host's theme and locale (English, Traditional or Simplified Chinese).

A staff session works like this:

1. The person asks what needs attention.
2. The agent calls the application's own staff View, for example `query_view_pending_approvals`.
3. The App lists the rows. The person picks one and opens its action.
4. The App reads the entry with the named reader, locks the version the person reviews, and runs the operation's own tool.
5. On a conflict the input is kept and the App asks for the latest version. A write whose outcome is unknown is never retried.

On a surface without a reader, such as the public one, an action that locks a version uses the `id` and `version` of the row as listed. A stale version then fails with `CONFLICT` at submit, and the App offers no fresh read; the person refreshes the list instead.

The same App serves public and member Views, because the contract never depends on staff Admin. It renders a View whether or not it has row actions, but it creates nothing on its own: a tool that starts a new entry, such as `submit_requisition`, stays a plain tool call. In [Procurement approvals](../../examples/builtin-procurement.md), members list `query_view_my_requisitions` in the App and submit through `submit_requisition`; reviewers work in `query_view_pending_approvals` and `review_requisition`.

Core defines no inbox, pending state, assignment or approval engine. "Pending" is whatever View the application declares.

A client without MCP Apps runs the same steps with the plain tools: the View tool lists the rows, and its description names each row action and the fields it binds.

### An application-owned renderer

An App does not need the built-in components. Only the contract matters: the result `_meta`, the tools, and the controller's review-and-submit rules. A minimal renderer with the official `App` and the framework-free controller, from [`packages/mantle-ui/examples/own-renderer.ts`](../../../packages/mantle-ui/examples/own-renderer.ts), which is type-checked with the package:

```ts
import { App } from "@modelcontextprotocol/ext-apps";
import {
  createInteractionController,
  type EntrySnapshot,
  type InteractionBinding,
  type InteractionDiagnostic,
  type InteractionState,
  type InvokeOutcome,
} from "@aotter/mantle-ui/controller";

interface Interaction {
  readonly view: string;
  readonly collection: string | null;
  readonly read?: string;
  readonly rowActions: readonly (InteractionBinding & { readonly capability: string; readonly title?: string })[];
}
type CallResult = Awaited<ReturnType<App["callServerTool"]>>;

declare function render(state: InteractionState): void; // your own markup

/** `structuredContent`, else the JSON text block: failures of a tool with an output schema travel as text. */
function output(result: CallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content.find((item) => item.type === "text");
  return text && "text" in text ? JSON.parse(text.text) as unknown : undefined;
}

const app = new App({ name: "my-review-app", version: "1.0.0" }, {});
app.ontoolresult = (result) => {
  const meta = result._meta?.["net.aotter.mantle/interaction"] as Interaction | undefined;
  const rows = ((result.structuredContent as { rows?: Record<string, unknown>[] } | undefined)?.rows) ?? [];
  const [row] = rows;
  const [action] = meta?.rowActions ?? [];
  if (!meta || !row || !action) return;
  const reader = meta.read;
  const controller = createInteractionController({
    interaction: action,
    row,
    // Only surfaces with an entry reader name one; otherwise the row is what the person reviews.
    ...(reader ? {
      read: async (signal: AbortSignal) => output(await app.callServerTool(
        { name: reader, arguments: { collection: meta.collection, id: row["id"] } }, { signal })) as EntrySnapshot,
    } : {}),
    invoke: async (input, signal): Promise<InvokeOutcome> => {
      const answer = await app.callServerTool({ name: action.capability, arguments: input }, { signal });
      if (!answer.isError) return { ok: true, data: output(answer) };
      const diagnostics = (output(answer) as { diagnostics?: InteractionDiagnostic[] } | undefined)?.diagnostics;
      // No diagnostics means the outcome is unknown: throw, and the controller never retries it.
      if (!diagnostics?.length) throw new Error("The tool failed without a diagnostic.");
      return { ok: false, diagnostics };
    },
  });
  controller.subscribe(() => render(controller.getSnapshot()));
  void controller.open();
};
await app.connect();
```

Two details matter. A tool that declares an output schema reports failures in its text block only, so read the diagnostics from there when `structuredContent` is absent. A failure without diagnostics has an unknown outcome: throw it, and the controller asks the person to check before anything is sent again.

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
