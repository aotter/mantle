# ADR-0029: MCP Apps interaction contracts, projection ownership and package boundaries

**Status:** Proposed — draft for maintainer review. Items marked **OPEN** are
undecided and must be resolved (or explicitly deferred) before this ADR is
accepted. Nothing marked OPEN may be implemented on the strength of this draft.

**Date:** 2026-09-25

**Related:** epic [#1110](https://github.com/aotter/mantle/issues/1110)
(supersedes #1109); tracked here as [#1114](https://github.com/aotter/mantle/issues/1114).
Builds on [ADR-0012](0012-views-as-public-rest.md),
[ADR-0014](0014-auth-better-auth-and-multi-tenant-mcp.md),
[ADR-0019](0019-sealed-manifest-runtime-pipeline.md),
[ADR-0020](0020-builtin-handler-contracts-and-matched-upsert.md),
[ADR-0022](0022-caller-observed-version-occ.md),
[ADR-lite 845](adr-lite-845-frontend-client.md),
[ADR-lite 861](adr-lite-861-admin-webmcp.md),
[ADR-lite 909](adr-lite-909-admin-ui-kit.md).
External: MCP tools specification 2025-11-25 and the MCP Apps extension.

## Open decisions

| ID | Decision | Tracking | Blocks |
|---|---|---|---|
| **D1** | Business errors: keep JSON-RPC errors, or move to `isError` tool results | [#1111](https://github.com/aotter/mantle/issues/1111) | Compatibility §8; MCP Apps outcome handling |
| **D2** | Staff snapshot read: bounded single-entry read tool, or Views only | [#1112](https://github.com/aotter/mantle/issues/1112) | Snapshot §4; example B |
| **D3** | Mandatory human approval: define, or defer explicitly | [#1113](https://github.com/aotter/mantle/issues/1113) | Approval §10 |
| **D4** | Grammar for an explicit reference key and a declared operation target | [#1116](https://github.com/aotter/mantle/issues/1116) | Contract §3; custom-handler binding |
| **D5** | Add `View.spec.description` | [#1115](https://github.com/aotter/mantle/issues/1115) | Discovery §2 |
| **D6** | Target MCP Apps hosts and their acceptance bar | [#1119](https://github.com/aotter/mantle/issues/1119) | Transport §7; preview transport; D1 evidence |
| **D7** | Package placement of the interaction controller and the React components | this ADR | Packages §9 |
| **D8** | Migration of Admin's existing row-binding inference | this ADR | Projection §5 |

Where this draft makes a recommendation on an open item, it is labelled
*Recommendation* and is not a decision.

## Context

Mantle already projects callable capabilities from the sealed RuntimePlan:
`projectCallableCapabilities` (`mantle-runtime/src/domain/service/CallableCapabilityProjector.ts`)
feeds staff and public MCP, Admin WebMCP and the web client. What is missing is
the link from a discovered **record** to a correctly bound **operation** and a
**renderer**, and a transport that can open that interaction inside a chat host.

The current code has these relevant facts, verified on `develop` @ `35d2c14`:

1. **Row binding is inferred, and only in Admin.** `discoverRowBindings`
   (`mantle-admin/src/mountMantleAdmin.ts`) picks the bound row field by a
   same-name property, then a lone single-field unique index, then `id`. The
   procurement example deliberately omits `x-mantle-ref` because that inference
   would bind `requestNumber` where builtin `update` needs the entry id.
2. **Admin's View page has no row operations.** Bindings are keyed by Schema
   collection, not by View.
3. **SQL Views declare no output.** ADR-lite 845 promises no row schema;
   `viewExposesVersion` can only substring-match SQL text.
4. **Spec already derives some relations.** `MCP_TOOL_INPUT_UNREACHABLE` and
   `lockedCollection()` (`mantle-spec/src/domain/service/ManifestGraphValidator.ts`)
   infer which collection an OCC write locks. They are diagnostic heuristics,
   not an execution contract.
5. **Staff MCP has no single-entry read.** Generic update tools require
   `expected_version`; Procedures use the reserved `expectedVersion`.
6. **Admin binds the version read when the dialog opens**
   (`mantle-admin-ui/src/features/content/row-operations.tsx`), not the version
   of the row the user saw in a list.
7. **Tool results were text only** and business errors are JSON-RPC `-32000`
   errors with `error.data`; `Procedure.spec.output` is validated at runtime but
   was not advertised.
8. **Website preview** (`?preview=1`) is authorized by a staff session cookie,
   which is a third-party cookie inside a chat host's sandboxed iframe.
9. **Canonical Admin refuses framing** (`frame-ancestors 'none'`,
   `X-Frame-Options: DENY`).
10. **An MCP App's `tools/call` is proxied by the host** with the same client
    credential the model uses. The server cannot tell a UI call from a model
    call; `AuditSink` records the OAuth client, not the actor.

## Decision

### 1. Scope and invariants

MCP Apps support is optional and generic. Schema, View, Procedure and Trigger
remain the only atoms. Runtime stays adapter-neutral and gains no UI, HTML,
router, cookie or host-bridge ownership. Authorization, Procedure guards, OCC
and audit keep their current owners; no presentation request becomes an
alternate execution path. Procurement and article editing are acceptance
examples, not built-in concepts. Core defines no inbox, pending status,
assignment model or approval engine.

### 2. Discovery

A capability's purpose reaches agents from Manifest text only: titles and
descriptions, projected through the existing capability projection.

- Procedure: `spec.title`, `spec.description` (existing).
- View: `spec.title` (existing) and **OPEN D5** `spec.description`. A Schema's
  description may be appended as source context, never as the View's purpose.

### 3. Interaction contract vocabulary

| Term | Meaning |
|---|---|
| **Capability** | A callable View or Procedure on one surface, with its Trigger identity. |
| **Target** | The entity an interaction is about, identified by collection plus a stable key, never by a display label. |
| **Reference** | A declared relation from an input field to a target collection and key. A reference alone does not mean the operation mutates or locks that entity. |
| **Operation target** | The entity an operation mutates and whose version it locks. |
| **Snapshot read** | The authorized read that produces what the human sees, including any version. |
| **Input binding** | An explicit mapping from snapshot/target fields to operation input fields. |
| **Version binding** | The operation input field that carries the observed version of the operation target, taken from the snapshot the human saw. |
| **Renderer** | Presentation of a snapshot, form, review or outcome. Owns no semantics. |
| **Outcome** | Success result or structured failure of an explicit invocation. |

Rules:

- An interaction is **entity-bound** only when target, snapshot read, input
  binding and (if the operation requires it) version binding are all
  established by the contract. Otherwise no automatic binding is offered; the
  operation remains usable as an ordinary form over its input schema, and
  execution is unchanged.
- Nothing is guessed from names: no collection, key, version source or side
  effect is inferred from an operation or field name.
- **Derivable without grammar change:**
  - builtin `update`/`delete`/`archive` (and id-based `upsert`): operation
    target is `handler.schema` by input `id`; version binding is
    `expectedVersion` when declared (ADR-0020/0022);
  - a non-SQL View's rows target its `from` collection when `fields` includes
    `id`; the View supplies a version only when `fields` includes `version`;
  - Trigger identity and surface from `plan.mcpTools`.
- **Not derivable today** (require **OPEN D4**): the key a reference binds when
  it is not the entry id; the operation target of a `ref` handler.
  `lockedCollection()` stays a diagnostic heuristic and is not promoted to an
  execution contract.
- Queries, notifications and multi-entity operations need no single target.
  D4 must not impose a target declaration on every Procedure.
- SQL Views are not bound automatically. They are not excluded permanently: a
  future validated output/field-mapping contract may admit them. A join may
  have more than one target.

### 4. Snapshot read and version binding

- Public and member snapshots are read only through declared, parameterized
  Views, so View field lists and `requires` stay the boundary. No generic
  entity reader is added for these surfaces.
- Staff snapshots: **OPEN D2** — a bounded single-entry read (all staff, or
  only collections that declare entity-bound interactions) versus Views only.
  *Recommendation:* scope any staff read to declared interaction targets,
  because it also limits which records flow into a model provider's context.
- The version bound to an operation is the version of the snapshot rendered to
  the human. If a later read returns a newer version, the UI shows that the
  record changed and requires a deliberate re-read and review; it never
  rebinds silently. A background refresh never replaces user edits.
- The contract names the version input field. Both existing wire names
  (`expectedVersion` on Procedures, `expected_version` on generic update
  tools) are described explicitly rather than assumed.
- Conflicts preserve user input. Uncertain writes (timeout, abort) are not
  retried automatically; the client reconciles first.

### 5. Projection ownership

- Spec resolves references (including D4 declarations) during link.
- The RuntimePlan compiler emits interaction descriptors as part of the sealed
  plan. Adding them advances `RUNTIME_PLAN_VERSION`.
- Runtime projects descriptors per transport: staff MCP, public MCP, Admin
  operations and the web client. Projections stay explicit per surface.
  HTTP-only staff Procedures never enter an MCP projection, and Trigger
  identity is preserved.
- Admin stops deriving bindings itself (`discoverRowBindings`, `rowField`),
  and `staffMcp` route hints consume the descriptors instead of tool-name
  prefixes.
- **OPEN D8** — migration of existing Admin row actions that rely on inference.
  Candidates: (a) keep inference for manifests without declarations for one
  minor release with a warning diagnostic, then remove it; (b) remove it
  immediately and emit a validation error with a fix hint; (c) keep inference
  permanently for Admin only. *Recommendation:* (a).
- Dynamic availability is advisory and never replaces invocation-time checks.
  No mutating handler runs to infer availability or effects.

### 6. Presentation boundary

Renderer registries and `uiSchema` carry presentation only. Target, input
mapping, authorization, side effects and version semantics must not be
declared there, so they cannot become a second Manifest. `uiSchema` stays
closed and staff/Admin-scoped as today.

### 7. MCP Apps transport

- The dispatcher gains the MCP Apps resource layer: the `resources`
  capability, `resources/list`, `resources/read`, and tool `_meta.ui` linking.
  Resource bytes come from an **injected provider**; Runtime ships no HTML.
- UI metadata is added only for clients that declare MCP Apps support. For all
  other clients, `tools/list` and `tools/call` are unchanged.
- Resources are surface-scoped and authorized like tools. Shared resources
  contain reusable assets only: no caller-specific records and no bearer
  tokens.
- Opening or preparing an interaction is read-only. A mutation is always a
  separate, explicit `tools/call`.
- Opening a UI does not suspend the agent; result and context updates follow
  what each host supports.
- Canonical Admin keeps refusing framing. MCP Apps compose reusable components
  over the host bridge instead.
- Website preview security is fixed now: authorized, content-isolated, no
  dependence on third-party Admin cookies, and private drafts never in shared
  assets or caches. The preview transport (for example HTML in a bearer-scoped
  tool result rendered in a nested sandbox) is chosen only after **OPEN D6**
  host verification.
- Target hosts, protocol versions and bridge capabilities: **OPEN D6**. No
  identical behavior across hosts is assumed.

### 8. Results, errors and compatibility

- **Success results (proposed in #1127):** `structuredContent` for
  plain-object results, with the text block unchanged. A Procedure advertises
  an `outputSchema` only when a standard JSON Schema validator accepts every
  value Runtime accepts. The projection is an allowlist that only loosens the
  declared schema; ineligible outputs advertise none. Views advertise none.
- **Errors: OPEN D1.** Today business errors are JSON-RPC errors carrying
  `error.data.code`, and this is documented behavior. Any move to `isError`
  results is one global compatibility decision, not a per-tool or UI-only
  variant, and no standard capability negotiation for error format is assumed.
  Protocol errors, business execution errors and HTTP authentication
  challenges (`401` + `WWW-Authenticate`) are defined separately; the OAuth
  challenge stays at HTTP.
- Dispatcher wiring is shared through `createMcpDispatcher` (proposed in
  #1126). Each transport keeps its own identity resolution and surface gate.

### 9. Packages and dependency direction

```text
mantle-spec ──► mantle-runtime ──► (adapters: cloudflare, bun, vercel)
                    │
                    ├──► interaction controller (framework-free)   ◄── OPEN D7
                    │         │
                    │         └──► React components                ◄── OPEN D7
                    │                   │
                    │                   ├──► mantle-admin-ui (consumer)
                    │                   └──► MCP App bundle (optional)
                    └──► MCP resource layer (in runtime; provider injected)
```

- Fixed: interaction descriptors live in Runtime (domain service beside
  `CallableCapabilityProjector`). The MCP resource layer lives in Runtime's MCP
  infrastructure with an injected provider. Nothing in Runtime imports React,
  HTML or host globals.
- **OPEN D7** — the framework-free controller (draft, dirty, review, pending,
  conflict, cancel over injected read/invoke) goes either in a subpath beside
  `@aotter/mantle-web/client` or in a new package. The React components go
  either into `@aotter/mantle-admin-ui/kit`, which amends ADR-lite 909, or into
  a separate feature subpath or package, which leaves 909's primitive-kit
  boundary intact. *Recommendation:* controller as a `mantle-web` subpath;
  components as a separate `mantle-admin-ui` feature subpath.
- Either way, no exported module may depend on Admin's router, global API
  client, query singletons or cookie session. A new package updates the
  CONTRIBUTING package-topology table.

### 10. Human approval

Recorded facts: UI confirmation and app-only tool visibility do not prove a
human decision (Context 10), and opening a UI does not suspend the agent.

**OPEN D3.** If mandatory approval is introduced, it is enforced at the server
application boundary, binds target, input and version, and covers every
alternate write path: generic CRUD, HTTP Triggers and Admin operations. Until
D3 is decided, no change may claim that a confirmation step enforces approval.

*Recommendation:* defer a Core mechanism and document the pattern that works
today. A `readOnly: true` Schema blocks generic writes. An approval Procedure
with only an HTTP Trigger and a `ctx.staff` requirement then appears in Admin
but in no MCP catalog. This pattern still needs a check that MCP-audience
tokens cannot call HTTP Triggers.

## Consequences

- One validated interaction definition can drive Admin, application frontends
  and chat hosts. Admin becomes a consumer rather than the owner of binding
  rules.
- Manifests that need entity-bound interactions for `ref` handlers or
  non-id references must adopt the D4 declarations.
- The sealed plan version advances when descriptors are added, so applications
  rerun `mantle generate`.
- Hosts without MCP Apps support see no change beyond the additive
  `structuredContent`.
- D1 may introduce a breaking wire change. If so, it is labelled
  `breaking-change` and documented.

## Alternatives

- **Each surface derives relations itself.** Status quo; duplicated and
  inconsistent.
- **SDK-side configuration registry for bindings.** An unvalidated second
  Manifest; rejected by #1109.
- **Carry bindings in `uiSchema`.** Staff-only, presentation-scoped, and mixes
  semantics into presentation.
- **Embed the canonical Admin in chat.** Requires weakening Admin's framing
  policy and cookie assumptions.
- **Promote `lockedCollection()` to the execution contract.** A reference does
  not prove mutation or locking; rejected in the #1109 discussion.

## How to apply

- Treat every OPEN item as a stop: do not implement it until this ADR records
  a decision.
- Implementation follows the epic's sub-issues. #1117 and #1118 do not depend
  on D1–D8. #1120–#1125 depend on this ADR and on the listed decisions.
- New grammar (D4, D5) goes through grammar-revise before code.

## Implementation status

- #1126 (`createMcpDispatcher`, #1118): draft PR.
- #1127 (`structuredContent` and safe `outputSchema`, #1117): draft PR,
  stacked on #1126.
- All other sections: not started.
