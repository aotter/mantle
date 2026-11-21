# ADR-0029: Official MCP SDK, interaction contracts and MCP Apps

**Status:** Accepted; amended by [ADR-lite 1376](adr-lite-1376-admin-extensions.md) revision 4

**Date:** 2026-09-25

**Related:** epic [#1110](https://github.com/aotter/mantle/issues/1110)
(supersedes #1109); tracked as [#1114](https://github.com/aotter/mantle/issues/1114).
Builds on [ADR-0012](0012-views-as-public-rest.md),
[ADR-0014](0014-auth-better-auth-and-multi-tenant-mcp.md),
[ADR-0019](0019-sealed-manifest-runtime-pipeline.md),
[ADR-0020](0020-builtin-handler-contracts-and-matched-upsert.md),
[ADR-0022](0022-caller-observed-version-occ.md),
[ADR-lite 845](adr-lite-845-frontend-client.md),
[ADR-lite 861](adr-lite-861-admin-webmcp.md).
Amends [ADR-lite 909](adr-lite-909-admin-ui-kit.md) (the kit moves to
`@aotter/mantle-ui`). External: MCP specification 2025-11-25 and 2026-07-28,
the MCP Apps extension, and the official TypeScript SDK
(`@modelcontextprotocol/server` 2.1.0, `client` 2.1.0, `ext-apps` 2.0.0).

## Context

Mantle projects callable capabilities from the sealed RuntimePlan
(`CallableCapabilityProjector`) and serves them over a hand-written JSON-RPC
dispatcher in `mantle-runtime/src/infrastructure/mcp`. The #1109 goal (agents
discover capabilities, find the right record, and open an interaction UI in
chat) exposed three gaps.

**Protocol.** The hand-written dispatcher accepts only protocol `2025-11-25`,
has no resource layer, and duplicates negotiation, batching and error framing
that the official SDK already owns. MCP Apps would add `resources/*`,
`ui://` resources and `_meta.ui` negotiation on top. The repository already
tests against the official client (#1023), and the official
`@modelcontextprotocol/ext-apps` 2.0 server helpers target SDK 2.x.

**Semantics in the wrong layer.** Tool semantics live in the transport:
generic-tool role floors, entry mutability checks, argument parsing, media
tool descriptions and `expected_version` annotation are in `McpToolCatalog`
and `McpJsonRpcDispatcher.dispatchToolByName`. They must survive a transport
swap unchanged.

**Interaction contracts.** Verified on `develop` @ `35d2c14`:

1. Row binding is inferred, and only in Admin. `discoverRowBindings`
   (`mantle-admin/src/mountMantleAdmin.ts`) picks a same-name property, then a
   lone single-field unique index, then `id`. The procurement example omits
   `x-mantle-ref` because the inference would bind `requestNumber` where
   builtin `update` needs the entry id.
2. Admin's View page has no row operations; bindings are keyed by collection.
3. SQL Views declare no output (ADR-lite 845).
4. `lockedCollection()` in `ManifestGraphValidator` infers the collection an
   OCC write locks. It is a diagnostic heuristic, not an execution contract.
5. Staff MCP has no single-entry read.
6. Admin binds the version read when the dialog opens
   (`row-operations.tsx`), not the version of the row the user saw.
7. Business errors are JSON-RPC `-32000` errors with `error.data`.
8. Website preview (`?preview=1`) is authorized by a staff session cookie,
   which is a third-party cookie inside a host's sandboxed iframe.
9. Canonical Admin refuses framing (`frame-ancestors 'none'`).
10. An MCP App's `tools/call` is proxied by the host with the model's client
    credential. The server cannot tell a UI call from a model call.

## Decision

### 1. Protocol belongs to the official SDK; semantics belong to Mantle

All MCP wire handling uses the official TypeScript SDK: JSON-RPC framing,
version negotiation, transports, `tools/*`, `resources/*` and MCP Apps
metadata. Mantle keeps authorization, guards, OCC, audit, validation and the
diagnostic vocabulary. Official packages are pinned to exact versions and
never forked. No hand-written JSON-RPC handling remains in the repository.

**Application-built Apps ownership (#1705).** Core accepts generic static or
request-time async resource contributors, validates endpoint and renderer ownership,
and serves them after its origin/identity gates. It does not import React, read UI
build files or compute UI digests. `mantle-ui` remains presentation/controller code
receiving data and callbacks, with no Core, Admin or MCP dependency. `mantle-admin`
owns the default Admin App and its existing typed hooks/surface transport, adapting
the pinned official client. Applications own frontend App entries and domain
components; they can use official ext-apps plus optional mantle-ui without Admin.
No fourth bridge package or parallel provider/slot/query-cache system is introduced.

Resource identity belongs to the UI contributor. Admin hashes its built HTML,
static catalogue and material resource metadata into its default URI; custom HTML
functions declare an explicit immutable build URI. A new build updates tool and
resource links together. Only raw immutable assets may be cached across callers;
the caller-filtered catalogue is embedded per resource read. Explicit `renders`
partitioning replaces registration-order overrides. Visibility metadata never
grants tool execution permission. The existing default caller-independent discovery
contract remains; `authorize` enables caller-filtered discovery and resource catalogues.

**Compatible upgrade retention (#1730).** Applications may retain previously deployed
Admin resource snapshots in their source/artifact storage and pass them as `previous`
to `adminMcpApps`. Each keeps its original URI, executable HTML, catalogue and CSP/domain;
only the embedded catalogue is filtered again against the current caller's tools.
Retained resources claim no current renderer or app-only tool. Current links still name
the new build. Retention is explicit and survives clean builds; it is not an isolate
cache, a redirect to current HTML, or authority to execute a removed tool. Applications
own the retention window and compatibility of existing tool names/inputs/results.
Breaking tool contracts need an application migration; Core cannot force a host to
rediscover its saved tool definitions or renew a revoked OAuth grant.

> **Amendment (#1934): stable default Admin App URI.** The MCP Apps specification
> (SEP-1865) lets a host "prefetch and cache UI resource content" and asks servers for
> nothing about versioning. A content-hash URI per build cost more than it saved: on
> claude.ai, after a deploy that changed it, App cards stopped rendering until the user
> refreshed the connector's tools. Admin's default therefore links tools to the fixed
> `ui://mantle-admin/admin`; the current build also answers at its content-hash URI
> (claiming no renderer) for conversations that hold one, and `previous` keeps older
> ones. A measured downstream run on claude.ai rendered, without a further refresh, a new
> chat after an HTML redeploy (with the new HTML) and a chat that held the old hash URI.
> An explicit `uri` changes identity on purpose, for an App that saved conversations
> must not load; there is no per-build tool link mode. A custom HTML function
> has no build identity and may use the fixed URI. Only raw assets are cached, and the
> caller-filtered catalogue is still embedded per read; an old hash is never answered
> with the latest HTML.

Both protocol eras are served: `2026-07-28` and `2025-*` in stateless mode
(`createMcpHandler(..., { legacy: "stateless" })`). *(Superseded by the #2100
amendment in section 4: 2026-07-28 only.)*

### 2. Runtime is transport-neutral

Runtime stops knowing about MCP. It provides:

- `CapabilityCatalog` (domain service): one transport-neutral description per
  callable capability on a surface: Views, Procedures, generic authoring and
  lifecycle operations, and media upload. Each carries name, surface, title,
  description, `inputSchema`, declared `outputSchema`, annotations,
  `requiresIdentity` and the argument that identifies the operation for audit.
- `InvokeCapabilityUseCase` (use case): the single execution entry and the
  single validation point. It returns
  `{ ok: true, data } | { ok: false, diagnostic }`. Missing or ill-typed
  arguments are `VALIDATION_FAILED` diagnostics.

Nothing under `domain/` or `usecase/` imports an MCP concept.

### 3. Validate once

The SDK receives each `inputSchema` through `fromJsonSchema(schema, validator)`
with a pass-through validator: the schema is advertised unchanged, and the
SDK does not validate. Runtime validates once, so MCP, HTTP and Admin report
the same Mantle diagnostic, and the Ajv instance the default validator would
pull in is not bundled.

`outputSchema` is the safe projection from #1127: an allowlist that only
loosens the declared schema, so a standard client validator accepts every
value Runtime accepts. Ineligible outputs advertise none. Views advertise none.

### 4. Results and errors (D1)

- **Success:** `content` is one JSON text block; `structuredContent` carries
  the value when it is a plain object (on 2026-07-28, any JSON value: see the
  SEP-2106 amendment below).
- **Business failure:** `isError: true` with `{ diagnostics: [Diagnostic] }`
  (the ADR-0008 shape) as a JSON text block, repeated as `structuredContent`
  unless the tool advertises an `outputSchema`. Structured results must
  conform to that schema, and 1.x clients validate them even on `isError`.
  This replaces the JSON-RPC `-32000` business error and is a breaking wire
  change, announced with the cutover.
- **Protocol failure** (malformed request, unknown method, unsupported
  version) stays a JSON-RPC error owned by the SDK.
- **Authentication:** an anonymous call to a tool whose capability
  `requiresIdentity` (including any member of a 2025-era batch, *superseded by
  the #2100 amendment below: no batch is served*) is answered
  before the SDK with HTTP 401 and a `WWW-Authenticate` challenge built by the
  SDK helper. The SDK's own
  `scopeChallenge` covers scopes only; identity stays outside it.

> **Amendment (#2084, #2096, 2026-11-20): native content blocks.** The JSON text
> block stays `content[0]`, followed by Core's tool version line and page notice;
> a tool's `withResult(data, { content, _meta })` appends standard MCP content
> blocks after them, which the installed SDK checks before the call is recorded
> (a refused block fails the call as `INTERNAL_ERROR`). `structuredContent`,
> `isError` and the error envelope stay Core's. Applications pass standard MCP
> values through in their native shapes without a per-feature Core change; Core
> keeps the decisions (authorization, validation, the data-to-`structuredContent`
> mapping, the error envelope, the per-caller tool list) and never hands an
> application the `McpServer`.

> **Amendment (#2100, 2026-11-20): ref handler results, progress and
> cancellation.**
>
> - A ref Procedure handler may return `withResult(output, { content, _meta })`;
>   its generated type is `Promise<Output | ResultWith<Output>>`, and
>   `ResultWith` carries a type-only brand that only `withResult` and
>   `withResultMeta` produce, so a plain `{ data }` object is not a wrapper.
>   The Procedure's generated MCP tool sends the blocks and `_meta`; Store
>   (`store(...).procedures`, `ctx.store.procedures`), REST and Admin callers get
>   `Output`. `callTool` returns what a tool returned, the wrapper included, for
>   hand-written and generated tools alike; `resultData` from
>   `@aotter/mantle/mcp` unwraps it.
> - `ToolCall.progress(progress, total?, message?)` exists when the request
>   carries a `progressToken` and sends `notifications/progress` on the call's
>   stream. `ToolCall.signal` is Core's own signal: it follows the SDK request
>   signal only while the tool runs, because the SDK also aborts its signal when
>   it tears the per-request server down after the result. It aborts only where
>   the runtime aborts the incoming `Request.signal` on a client disconnect
>   (Bun.serve; Workers from compatibility date 2026-11-17 or with
>   `enable_request_signal`). A 2025-era `notifications/cancelled` arrives as its
>   own request, which a stateless server cannot relate to the call. A call that
>   throws a non-`ContractError` after its signal aborted is recorded as
>   `REQUEST_CANCELLED` (status 499: observation `outcome: "failed"`, access event
>   `outcome: "error"`), not logged as an unhandled failure; the closed outcome
>   unions are unchanged. A started call records its own access event even when
>   the client goes away first. Ref handlers get neither: their handler is shared
>   with Store and REST callers.
> - ~~Not adopted: non-object `structuredContent` (SEP-2106).~~ Superseded by
>   the next amendment.

> **Amendment (#2100, 2026-11-20): protocol revision 2026-07-28 only;
> non-object `structuredContent`.** Supersedes "Both protocol eras are served"
> in section 1, the 2025-era statements of sections 4 and 10 and of the
> amendment above, and its "not adopted" item.
>
> - Decision. Core serves MCP protocol revision 2026-07-28 only:
>   `createMcpHandler(..., { legacy: "reject" })` (SDK 2.4.0). A 2025-era
>   request, an `initialize` or a message without the `_meta` envelope, is
>   answered by the SDK with HTTP 400 and JSON-RPC `-32022` ("Unsupported
>   protocol version", `data.supported: ["2026-07-28"]`); a notification gets
>   202; `GET` and `DELETE` get 405 with `Allow: POST`; a batch gets 400.
>   Core observes the `-32022` refusal as `request-refused` with status 400 and
>   reason `protocol-version`, and does not log it as a server failure.
> - Why. One wire shape removes the code and caveats that existed only for the
>   2025 era: the `initialize` handshake's access-event path, the "unknown"
>   MCP Apps support state of a stateless request without capabilities (Apps
>   support is now read from the `_meta` client capabilities every request
>   carries), batch pre-authorization, the `notifications/cancelled` caveat
>   (closing the request is the one cancellation path), and the SDK's 2025-era
>   `{ result }` wrap of non-object structured content and output schemas
>   (`rev2025Codec`'s `projectCallToolResult` and `wrapOutputSchemaForLegacy`),
>   which would have made one tool answer two shapes.
> - Who this cuts off. As of 2026-11-20 several widely used IDE and CLI MCP
>   clients still open with a 2025-era `initialize`; they cannot connect, and
>   a 2025-era client has no fall-forward to 2026-07-28. The official
>   TypeScript client (and tools built on it, such as the Inspector) connects
>   only in its modern mode (`versionNegotiation: { mode: { pin: "2026-07-28" } }`);
>   its default legacy mode is refused. An operator finds out from the refusal
>   the client shows ("Unsupported protocol version", naming `2026-07-28`) and
>   from `onObservation`'s `request-refused` events with reason
>   `protocol-version`, which count refused clients. A hosting platform forwards
>   2026-07-28 requests (`_meta` envelope; `MCP-Protocol-Version`, `Mcp-Method`
>   and `Mcp-Name` headers; `server/discover` instead of `initialize`), and may
>   send only `server/discover` (pinned to a mounted tool) or one `tools/call`:
>   a catalogue read would show tools beyond its pin, so it stays refused.
> - SEP-2106. The 2026-07-28 revision says structured content "can be any JSON
>   value (object, array, string, number, boolean, or null) that conforms to
>   the tool's `outputSchema` if one is defined", and a server "MUST provide
>   structured results that conform to this schema". A tool lists its
>   `outputSchema` whatever its root type, and a success sends its data, any
>   JSON value but `undefined`, as `structuredContent` beside the JSON text
>   block. A ref Procedure advertises its authored output schema whenever its
>   root declares a `type`; a typeless root (`$ref`, `anyOf`) still lists none,
>   because the SDK adds `type: "object"` to such a root when it can prove it
>   object-shaped, and the listed definition would then no longer hash to the
>   tool's version. A hand-written tool's typeless root is listed as the SDK
>   lists it, and the root check reads that listed schema: a root left without
>   `type` admits any value. SQL Procedures keep
>   `{ results }`; Views keep sending `{ rows, nextCursor? }` without a schema.
>   A success whose data the listed schema's root `type` (with `nullable`) does
>   not admit, `undefined` included, fails as `INTERNAL_ERROR` before it is
>   recorded; this is a root check, not validation. A dry run answers its
>   decision (`{ dryRun, event }`) as `structuredContent` whatever that root, as
>   it does for an object schema. A failure omits `structuredContent` when a
>   schema is listed.
> - Cancellation on Workers (measured on deployed Workers, 2026-11-20). From
>   compatibility date 2026-11-17, or with `enable_request_signal`, a client
>   closing the request aborts `ToolCall.signal` when Cloudflare sees the
>   disconnect, for JSON and SSE results; on an earlier date without the flag
>   only an SSE result (a call that sent progress) aborts it. The invocation
>   ends at the disconnect, so only synchronous abort listeners run: when the
>   client goes away before the tool settles, Core records the cancellation in
>   the abort event itself, as the `REQUEST_CANCELLED` completion observation
>   and, in gateway mode, the access event (`outcome: "error"`). Both keep that
>   first outcome and an invocation has one completion, so a tool that ignores
>   the signal and finishes where the runtime keeps running it (Bun) is still
>   recorded as cancelled: its result was not delivered, though its writes may
>   have been committed. A request the client left before the SDK ran it is
>   answered 499 by the SDK and recorded as cancelled, with no invocation. Work
>   kept alive with `waitUntil` runs on unless it checks the signal. `mantle generate` picks the newest date the
>   installed workerd supports, which can precede 2026-11-17; the flag is
>   documented, not added to generated configuration.
> - Observation: an `invocation` event carries `client`, the `clientInfo` name
>   and version the request's `_meta` declares; `request-refused` gains status
>   400 with reason `protocol-version`. The SDK's other refusals of what the
>   client sent (a batch, an invalid envelope, headers that contradict the
>   body, 405, 415) are neither observed nor logged as server failures; a 5xx
>   is logged.
> - App-only tools (`ui.visibility` without `"model"`, or `appOnly`): a request
>   that declares no MCP Apps support does not list them, and a `tools/call`
>   that names one runs it whatever the request declares, after the tool's own
>   authorization. Under the 2025-era "unknown" state any client that omitted
>   capabilities could call them, and one that declared capabilities without
>   the extension could not; visibility was never an access boundary (section
>   11), so the call no longer depends on that declaration, and a host that
>   forwards an App's call with `clientCapabilities: {}` reaches the tool.
> - MCP Apps: the Admin App reads any JSON value. The official App bridge
>   (ext-apps 2.0.4, also 2.1.0) still validates the result of an App's own
>   `callServerTool` with the 2025-era shape, so an App cannot yet receive a
>   non-object result from a tool it calls; a host's tool-result notification
>   reaches it.

### 5. Identity stays outside the SDK

The SDK never verifies tokens. Adapters verify the caller with `mantle-auth`
(ADR-0014), build the `HandlerContext`, and pass it as `authInfo.extra`. The
server factory reads it per request. Authorization extensions such as EMA are
unaffected.

### 6. Packages and dependency direction (D7)

Two packages are added; no other package is split.

| Package | Responsibility |
|---|---|
| `@aotter/mantle-mcp` | Optional. Registers the capability catalog on an official `McpServer` per surface (`createMantleMcpServer`), wraps `createMcpHandler` (`createMantleMcpHandler`), writes audit per call, and registers MCP Apps resources and app tools through `@modelcontextprotocol/ext-apps/server`. No UI dependency. |
| `@aotter/mantle-ui` | Optional. `/controller`: framework-free interaction controller; must not import React. `/` (root): React interaction components. `/kit` (with `kit.css` and `tokens.css`): the ADR-lite 909 kit moved from `@aotter/mantle-admin-ui/kit`, whose libraries are optional peers so `/controller` installs none. `/mcp-app`: a single-file `ui://` HTML build (`vite-plugin-singlefile`) using the official `App` bridge. |

```text
mantle-spec ◄── mantle-runtime ◄── mantle-mcp ◄── adapters, mantle-admin
                      ▲                 │
                      │                 └──► @modelcontextprotocol/server, ext-apps/server
                      │ (types only)
              mantle-ui/controller ◄── mantle-ui ◄── mantle-ui/mcp-app ──► ext-apps (App)
                                           ▲
                                     mantle-admin-ui
```

- Arrows point from consumer to dependency. Server packages never depend on
  UI packages; `mantle-mcp` receives MCP App HTML as injected bytes.

> **Amendment (0.2.0):** results carry no `_meta` interaction description.
> `planApp(plan, { surface, html })` (`@aotter/mantle/mcp`) embeds the plan's
> catalog (each View tool's columns as the fields they read, and, for a View
> that reads one table and outputs its `id`, the Procedure tools whose
> `target` is that Schema) as a JSON script in the injected HTML, and renders
> every View tool of the surface. A rendered result names its tool in
> `_meta["net.aotter.mantle/tool"]`. The App (`mantleAppHtml` from
> `@aotter/mantle-ui/mcp-app`) reviews a row as listed; a moved version is the
> server's `CONFLICT`. The preset serves it on `/mcp/staff`; a member-facing
> App is the application's own.
>
> **Amendment ([ADR-lite 1376](adr-lite-1376-admin-extensions.md) revision
> 4, decision 8):** the Admin App is built by the application from its Admin
> entry and served from the assets directory; the prebuilt `mantleAppHtml`
> (`@aotter/mantle-admin/mcp-app`) goes away. The catalog embedded when
> `ui://mantle-admin/admin/<digest>` is read is limited to the tools that caller can
> list: names and fields only, never rows. This is an exception to §10's "no
> caller data": that resource must not be cached or shared across callers.
- `@aotter/mantle-admin-ui/kit` re-exports from `@aotter/mantle-ui` for one
  minor release, then is removed.
- No exported UI module depends on Admin's router, global API client, query
  singletons or cookie session.

### 7. Interaction contract

| Term | Meaning |
|---|---|
| **Capability** | A callable View or Procedure on one surface, with its Trigger identity. |
| **Target** | The entity an interaction is about: collection plus a stable key, never a display label. |
| **Reference** | A declared relation from a field to a target collection and key. A reference alone does not mean an operation mutates or locks that entity. |
| **Operation target** | The entity an operation mutates and whose version it locks. |
| **Snapshot read** | The authorized read that produces what the human sees, including its version. |
| **Input binding** | An explicit mapping from snapshot fields to operation input. |
| **Version binding** | The input field carrying the observed version, taken from the snapshot the human saw. |
| **Renderer** | Presentation of a snapshot, form, review or outcome. Owns no semantics. |

Rules:

- An interaction is **entity-bound** only when target, snapshot read, input
  binding and (when required) version binding are all established by the
  contract. Otherwise no automatic binding is offered; the operation stays
  usable as an ordinary form.
- Nothing is guessed from names.
- **Derivable today:** builtin `update`/`delete`/`archive` and id-based
  `upsert` target `handler.schema` by input `id`, with `expectedVersion` when
  declared; a non-SQL View's rows target its `from` collection when `fields`
  includes `id`, and supply a version only when `fields` includes `version`.
- **Declared (D4, grammar-revise #1116):**
  - `x-mantle-ref: { schema, field }` on a Schema or View field names the
    target collection and the key field. `field` must be `id` or a
    single-field unique index of `schema`.
  - `Procedure.spec.target: { schema, id, version? }` names a `ref`
    handler's operation target: `id` and `version` are input property names.
    It is rejected on builtin handlers, whose target is already derivable.
  - Queries, notifications and multi-entity Procedures declare no target.
- `lockedCollection()` stays a diagnostic heuristic.
- SQL Views are not bound automatically until a validated output contract
  admits them.
- **View purpose (D5, #1115):** `View.spec.description` is added and projected
  into the View tool description.

### 8. Snapshot and version (D2)

- Public and member snapshots are read only through declared, parameterized
  Views.
- Staff snapshots use a bounded single-entry read offered only for
  collections that are the target of a declared interaction. Other staff
  reads go through Views. This limits which records flow into a model
  provider's context.
- The version bound to an operation is the version the human saw. A newer
  read is shown as "changed since the list" and requires a deliberate re-read
  and review; it never rebinds silently. Background refresh never replaces
  user edits.
- Conflicts preserve user input. Uncertain writes (timeout, abort) are not
  retried; the controller reconciles first.

### 9. Projection ownership (D8)

- Spec resolves D4 declarations during link. The RuntimePlan compiler emits
  interaction descriptors (`plan.interactions`); this advances
  `RUNTIME_PLAN_VERSION`.
- The capability catalog, Admin operations and the web client all read
  `plan.interactions`. HTTP-only staff Procedures never enter an MCP
  projection.
- Admin's inference is kept for one minor release. When an operation is bound
  only by inference, Admin logs one deprecation warning pointing to
  `Procedure.spec.target`. The next minor removes the inference.
- Dynamic availability is advisory. No mutating handler runs to infer
  availability.

### 10. MCP Apps

Implemented the way the official `add-app-to-server` and `create-mcp-app`
skills describe:

- `mantle-mcp` registers `ui://` resources with `registerAppResource` and
  interaction tools with `registerAppTool` and `_meta.ui.resourceUri`.
  App-only helpers use `_meta.ui.visibility: ["app"]` and are read-only.
- Negotiation uses `getUiCapability`, per request. A 2026-07-28 request, or a
  2025-era `initialize`, that declares no MCP Apps support gets no `_meta.ui`,
  no resources and no app-only tools; everything else is unchanged.
  *(Superseded by the #2100 amendment in section 4: there is no 2025-era
  `initialize`, and such a request lists no app-only tool but may call one.)*
- A stateless 2025-era request after `initialize` carries no client
  capabilities. It is treated as possibly supporting MCP Apps: it gets the App
  metadata and the app-only tools, so hosts with MCP Apps can call them on
  every request. Hosts without MCP Apps ignore the metadata but may list the
  app-only tools to the model. This is why app-only tools must be declared
  read-only. *(Superseded by the #2100 amendment in section 4: no 2025-era
  request is served, so there is no "unknown" support state.)*
- Each surface is its own `McpServer`; staff resources never appear on public.
- Resources hold reusable assets only: no caller data, no bearer. Per-call data
  travels in `structuredContent`. Every app tool keeps its text `content`.
- Opening an interaction is read-only; a mutation is always a separate
  explicit `tools/call`. Canonical Admin keeps refusing framing.
- **Preview (D10):** a staff-only, read-only, app-only `preview_entry` tool,
  offered only when a Web renderer is mounted, returns the rendered HTML in
  `structuredContent` under bearer authorization. The app shows it in a
  sandboxed `srcdoc` iframe without `allow-same-origin`. The response is
  `no-store` and the HTML never enters a shared resource.
- **Hosts (D6):** CI runs the official `basic-host` and
  `@modelcontextprotocol/client`; Claude and ChatGPT are verified manually per
  release of this feature. No identical behavior across hosts is assumed.

### 11. Human approval (D3)

Deferred. UI confirmation and app-only visibility do not prove a human
decision (Context 10). The handbook documents the pattern that works today: a
`readOnly: true` Schema blocks generic writes, and an approval Procedure with
only an HTTP Trigger and a `ctx.staff` requirement appears in Admin but in no
MCP catalog. A test asserts an MCP-audience token cannot call an HTTP
Trigger. App-only visibility is not an access boundary.

> **Amended (ADR-lite #1937, revision 3):** Core adds no mechanism for human
> approval. The application decides what is approved and binds target, input
> and version; the host confirms the person and hands the application only the
> proven single-use value through the request.

### 12. Presentation boundary

Renderer registries and `uiSchema` carry presentation only. Target, input
mapping, authorization, side effects and version semantics are never declared
there.

## Consequences

- One validated interaction definition drives Admin, application frontends
  and chat hosts. Admin becomes a consumer of binding rules.
- Applications that do not use MCP no longer carry any MCP code in Runtime.
  Applications that do add `@aotter/mantle-mcp` and its SDK dependency;
  measured on a minimal Worker, SDK plus zod is about 82 KiB gzip without Ajv.
- MCP business errors change from JSON-RPC errors to `isError` results
  (`breaking-change`), announced when adapters cut over.
- Manifests that need entity-bound interactions for `ref` handlers or non-id
  references adopt the D4 declarations. The sealed plan version advances, so
  applications rerun `mantle generate`.
- Hosts without MCP Apps support see only the additive `structuredContent`
  and `outputSchema`.

## Alternatives

- **Keep the hand-written dispatcher and add MCP Apps to it.** Duplicates
  the SDK, stays on one protocol version, and diverges from the official
  ext-apps helpers.
- **Validate in both the SDK and Runtime.** Two error shapes for one mistake,
  and Ajv in every Worker.
- **Put MCP Apps in Runtime with an injected provider.** Makes Runtime own a
  protocol extension; the SDK already owns resources.
- **More packages** (separate controller, kit, app packages). Three
  versioning surfaces for one feature; subpaths give the same boundaries.
- **Each surface derives relations itself.** Status quo; inconsistent.
- **Bindings in `uiSchema` or an SDK-side registry.** A second, unvalidated
  Manifest; rejected by #1109.
- **Embed canonical Admin.** Requires weakening framing and cookie policy.
- **Promote `lockedCollection()` to the execution contract.** A reference does
  not prove mutation or locking.

## How to apply

Work follows epic #1110 as stacked PRs:

1. #1126, #1127 — dispatcher factory; `structuredContent` and `outputSchema`.
2. #1129 — `CapabilityCatalog` and `InvokeCapabilityUseCase`.
3. #1130 — `@aotter/mantle-mcp`.
4. #1131 — adapters, Admin and templates cut over; hand-written dispatcher
   deleted.
5. #1115, #1116 — grammar-revise; then #1120 interaction descriptors.
6. #1121 — MCP Apps registration; #1122, #1123, #1124 — `@aotter/mantle-ui`;
   #1125 — preview; #1119 — host matrix.

### OAuth linking hints and the reference consent UI (2026-10-17)

An application may declare additional `authorizationScopes` for Core's standard
unauthenticated `WWW-Authenticate` challenge. This is a client authorization
request hint, separate from `requiredScopes` and tool guards; it never upgrades
an issued credential or modifies provider consent. Background access remains
explicit and application-owned. The Admin-selected reference uses its mantle-ui
consent page and Core's signed consent data/POST contract. The script-free Core
HTML remains the adapter-neutral fallback. Admin asset generation defaults
`html_handling` to `none` when omitted so a Worker-fetched shell is not
canonicalized back into a redirect loop; explicit application settings survive.
