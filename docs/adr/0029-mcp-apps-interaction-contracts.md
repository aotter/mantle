# ADR-0029: Official MCP SDK, interaction contracts and MCP Apps

**Status:** Accepted

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

Both protocol eras are served: `2026-07-28` and `2025-*` in stateless mode
(`createMcpHandler(..., { legacy: "stateless" })`).

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
  the value when it is a plain object.
- **Business failure:** `isError: true` with `{ diagnostics: [Diagnostic] }`
  (the ADR-0008 shape) as a JSON text block, repeated as `structuredContent`
  unless the tool advertises an `outputSchema`. Structured results must
  conform to that schema, and 1.x clients validate them even on `isError`.
  This replaces the JSON-RPC `-32000` business error and is a breaking wire
  change, announced with the cutover.
- **Protocol failure** (malformed request, unknown method, unsupported
  version) stays a JSON-RPC error owned by the SDK.
- **Authentication:** an anonymous call to a tool whose capability
  `requiresIdentity` (including any member of a 2025-era batch) is answered
  before the SDK with HTTP 401 and a `WWW-Authenticate` challenge built by the
  SDK helper. The SDK's own
  `scopeChallenge` covers scopes only; identity stays outside it.

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
- A stateless 2025-era request after `initialize` carries no client
  capabilities. It is treated as possibly supporting MCP Apps: it gets the App
  metadata and the app-only tools, so hosts with MCP Apps can call them on
  every request. Hosts without MCP Apps ignore the metadata but may list the
  app-only tools to the model. This is why app-only tools must be declared
  read-only.
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
Trigger. Any future Core mechanism is enforced at the server boundary and
binds target, input and version.

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
