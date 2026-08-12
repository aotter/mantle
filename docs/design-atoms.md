# Design atoms — the 4 things this SDK exposes

> If you're an AI working in a project that consumes `@aotter/mantle-*`,
> read this first. It explains the entire surface area in one page.
>
> **Status**: v0.1 grammar lock. Atoms are shipped; rich sub-spec
> grammar (policies, recursive views, temporal predicates, quotas,
> projection triggers, cron/queue sources, and extended lifecycle hooks) is
> reserved as **DRAFT** — see "Future grammar" appendix. Editorial
> lifecycle is the one shipped grammar key whose runtime is **deferred
> to v0.1.x**: parser and boot accept the shape, while
> `request_publish` rejects it with `LIFECYCLE_NOT_IN_V010` until the approval
> queue lands. Do not use editorial for a v0.1 publishing workflow.
>
> **This is the reference manual** — what the system is. For *why* it
> ended up this shape (alternatives considered, trade-offs accepted),
> see the Architecture Decision Records under [`docs/adr/`](adr/README.md).
> For the SDK's contract with its primary author (CLI feedback loops,
> structured diagnostics, deterministic authoring), see
> [ADR-0007](adr/0007-ai-as-primary-author.md).

## TL;DR

> See ADR-0001 for rationale — why these 4 atoms, why the PG-1:1
> mapping pitch, and the design history.

The SDK exposes **exactly 4 declarative resource kinds**, scoped to the
**`cms.mantle.aotter.net/v1`** group of the mantle universe. They map 1-to-1 to the
primitives Postgres has shipped for 30 years.

| Our atom | Postgres equivalent | Externally exposed by itself? | Has user code? |
|---|---|---|---|
| **`Schema`** | `CREATE TABLE` | no (manipulated via View / Procedure) | no |
| **`View`** | `CREATE VIEW` | **yes** (auto-mounted on its declared public/staff REST and MCP surface; see ADR-0012) | no |
| **`Procedure`** | `CREATE FUNCTION ... LANGUAGE plpgsql` | **no** (transport-agnostic; needs a `Trigger` to bind it) | **yes — handler ref to consumer's TS file** |
| **`Trigger`** | `CREATE TRIGGER` + `pg_cron` + PostgREST route + `LISTEN/NOTIFY` | yes (the binding atom — turns Procedures into HTTP endpoints, cron jobs, MCP tools, lifecycle hooks) | no |

The **read/write asymmetry is by design** and matches HTTP safe-vs-unsafe
semantics. Reads (`View`) are idempotent and cacheable; the SDK
auto-mounts them. Writes (`Procedure`) change state; they require an
explicit `Trigger` to gain an external surface, with the auth/path
choices made deliberately.

**Composition rule**: anything more "domain-shaped" than these (a Form,
Membership, Email, Webhook, Workflow, ScheduledJob) is **not** an atom.
It's something you compose **in the consumer's project** by combining
these four plus your own TypeScript.

## Manifest envelope

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema | View | Procedure | Trigger
metadata:
  name: posts                # required, kebab-case, unique within deployment
  labels: { ... }            # optional, free-form
spec:
  ...                        # kind-specific
```

There is **no `namespace` field**. Resource names are unique within the
deployment. K8s-style namespaces are a "premature scale" abstraction for
our scope; SaaS multi-tenancy belongs in the consumer's app layer with a
`tenant_id` column gated by RBAC, not in the SDK metadata layer.

### Multi-doc YAML — keeping file count down

> See [ADR-0001 §"Authoring shape: multi-doc YAML"](adr/0001-four-atom-manifest-model.md#authoring-shape-multi-doc-yaml-was-poc-adr-0006)
> for rationale — why multi-doc YAML over an inline
> `Procedure.expose:` shortcut.

A logical feature commonly bundles a Procedure + a Trigger (and often a
Schema and a View). Put related atoms in one file separated by `---`:

```yaml
# manifests/contact.yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: send-contact-message }
spec:
  input:  { type: object, required: [name, message], properties: { ... } }
  output: { type: object, properties: { ok: { type: boolean } } }
  handler:
    kind: ref
    ref:  send-contact-message       # opaque registration key

---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: contact-http }
spec:
  source: { kind: http, method: POST, path: /api/contact }
  target: { procedure: send-contact-message }
```

One file, two atoms. File count stays low; conceptual atom separation
stays honest.

## What each atom is for (v0.1 minimum essential grammar)

### 1. `Schema` — the entity (internal)

A relation. Defines what data exists. You declare the JSON Schema for
each row, its indexes, and the binding directives. Schema is **not
directly externally exposed** — clients don't write to a Schema URL; they
hit a Procedure that the SDK translates into Schema mutations.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts                    # required: human-readable label for the admin UI
  localized: true                 # opt-in: row carries data.locale (ADR-0010)
  lifecycle: publishing               # default; 'operational' is operational, 'editorial' is reserved
  schema:
    $schema: https://json-schema.org/draft/2020-12/schema
    type: object
    required: [title, slug, content]
    properties:
      title:    { type: string, minLength: 1, maxLength: 200 }
      slug:     { type: string }
      locale:   { type: string }   # NOT in `required:`; the runtime locale
                                   # gate (mantle-runtime helpers.ts, per
                                   # ADR-0010) enforces presence on writes
                                   # against localized Schemas.
      content:  { type: string }
      authorId: { type: string, format: uuid, x-mantle-bind: ctx.user }
      createdAt: { type: integer, x-mcp-hint: timestamp-ms, x-mantle-bind: now }
  searchableFields: [title, slug]   # id is always searched
  uniqueIndexes: [[slug, locale]]
  indexes: [[locale, title]]        # ordered, non-unique hot path
```

**`spec.title`** — admin UI label. Required. AI authors must populate
in the user's primary language (the install-time chosen locale); the
SPA shows this everywhere instead of `metadata.name`.

**`spec.searchableFields`** — optional allowlist of top-level string
properties used by Admin and Staff MCP substring search. Entry id is always
searchable. This is separate from `indexes`; ordinary B-tree indexes do not
accelerate leading-wildcard substring search.

**`spec.uiSchema.list.filterField`** — optional Admin-only primary filter for
an operational collection. The field must declare a non-empty string `enum`
and be the first field of an `indexes` or `uniqueIndexes` tuple. Admin reuses
the enum for sidebar links and list tabs; Staff MCP uses declared Views for
richer query capabilities instead of reading UI configuration.

**`spec.localized: bool`** (default `false`, ADR-0010) — opt-in per
Schema. Localized Schemas store locale in `data.locale`; non-localized
Schemas reject `data.locale` writes. Site config must declare the set
of allowed locales (`site_config.locales`). The runtime layer reads
`site_config` per-request to resolve the active locale set; boot only
validates manifest shape.

**`spec.translates: { parent, on }`** (ADR-0010) — declares this
Schema as the translation companion to a non-localized parent, joined
on the named field (typically `slug`). Implies `localized: true`. The
admin UI surfaces the child only as locale tabs in the parent's editor.

#### Lifecycle

**`spec.lifecycle: 'publishing' | 'editorial' | 'operational'`** — controls the
entry's state machine.

- `publishing` (default) — `draft → published → archived`. No approval
  queue. **This is the only content-workflow mode whose runtime ships
  in v0.1.0.**
- `editorial` — the six-state machine with an approval queue
  (`draft → review → approved → scheduled → published → archived`,
  with `published` returnable to `draft` for republish). The grammar and
  state-machine vocabulary are reserved for forward compatibility, but the
  approval/request-publish runtime is deferred until after v0.1. In v0.1,
  manifest validation rejects it with `LIFECYCLE_NOT_IN_V010`; do not declare
  editorial for a current workflow.
- `operational` — records that are not authored content: orders,
  inventory snapshots, grant/audit rows — anything written by
  Procedures as a side effect rather than drafted by a person. No
  content workflow applies: entries are live (`published`) the moment
  they are created, are editable in place regardless of status, and
  have **no** publish / unpublish / archive transitions (all reject
  with `CONFLICT`). The admin console renders these collections flat —
  no draft/published filter buckets, no publish controls. Declare it
  on any Schema whose rows a human should *inspect and correct*, never
  *stage and publish*. Staff MCP emits `create_record_<schema>` and
  `update_record_<schema>` for these Schemas instead of draft tools.

The modes are **per-Schema and mix freely** within a site. There is no
site-wide lifecycle setting; one Schema can be `publishing` while another
is `editorial` and a third is `operational`.

**Property-level extensions** (JSON Schema vendor keywords, all optional):

These are the standard `x-` prefix that JSON Schema reserves for
extensions. Three are part of `cms.mantle.aotter.net/v1`:

#### `x-mantle-bind: <value>` — server-stamped fields

> See ADR-0002 for rationale — why this is a closed enum and not an
> open expression language.

Marks a property as **server-controlled**. The SDK fills the value at
write time; the caller MUST NOT supply it (callers who try to set a
bound field get `INPUT_VALIDATION_FAILED`). Eliminates the entire
class of handler-side `userId: ctx.user.id` boilerplate, and gives
the dispatcher an authoritative "who/when" tag without trusting the
wire.

**Closed enum** (any new value requires an explicit grammar-revise round):

| Value | Resolves to | Typical use |
|---|---|---|
| `ctx.user` | UUID of the signed-in end-user (from session cookie); `null` if anonymous | row ownership: `authorId`, `submittedBy`, `creatorId` |
| `ctx.staff` | UUID of the staff member acting (when a staff session is active); `null` for end-user-only paths | audit trail: `approvedBy`, `moderatedBy`, `grantedBy` |
| `now` | Server timestamp at write (ISO-8601 string with timezone) | `createdAt`, `submittedAt`, `grantedAt` |

**v0.1 stamping behavior**:
- Stamped on `INSERT` only. Update-stamping (e.g. `updatedAt: now` that
  re-stamps on every UPDATE) is DRAFT — it lands when first use case
  surfaces.
- Caller-supplied value: rejected at input validation. The Procedure's
  effective input schema strips bound fields before checking caller
  input, so callers can't accidentally send them.
- Visible in View output: yes, as ordinary columns. No special masking.
- Used by `requires.auth.owns:` predicate (DRAFT): the predicate
  compares a row's `x-mantle-bind: ctx.user` field to the current
  `:ctx.user` to verify ownership without configuring per-Schema
  owner-column names.

**Why a closed enum** (highest-leverage discipline in the spec): bind
values are server-controlled identity + time facts. If we accepted
arbitrary expressions (`x-mantle-bind: ${request.headers["x-team"]}`),
we'd be reinventing a templating language. Keeping the set finite and
named bounds the semantic surface forever.

**Example** (from a hypothetical extended `posts` Schema):
```yaml
properties:
  title:     { type: string, minLength: 1, maxLength: 200 }
  authorId:  { type: string, format: uuid, x-mantle-bind: ctx.user }
  createdAt: { type: string, format: date-time, x-mantle-bind: now }
  # caller sends only: { title }
  # SDK stamps: { title, authorId: <session UUID>, createdAt: <now ISO> }
```

#### `x-mantle-ref: <other-schema-name>` — cross-Schema reference

Informational FK marker on a string-typed field that holds an ID
referencing rows in another Schema. Not enforced in v0.1 (the SDK
passes it through; no foreign-key constraint, no cascade, no orphan
detection). The admin uses declared refs to show related rows and to nest
required child collections; it does not infer relationships from field names.
Declare a single-field `indexes` entry for the ref field (for example,
`indexes: [[authorId]]`) when reverse lookups must stay bounded. Mantle adds
the native entry-order columns to that access path. Future grammar may upgrade
it to enforced.

**Example**:
```yaml
authorId:
  type: string
  format: uuid
  x-mantle-ref: authors         # this UUID points at a row in `authors` Schema
```

**Implementation status**: declared in
`@aotter/mantle-spec` as the `MANTLE_REF_KEYWORD` constant; SDK
currently passes it through to consumers (admin UI uses it for picker
widgets) but does not enforce referential integrity at write time.

#### `x-mcp-hint: <hint-string>` — agent / widget intent

Descriptive hint for AI agents and admin UI widgets. The string is
accepted as free-form for forward compatibility, but conventional
values (`markdown`, `richtext`, `code`, `media`, `media-image`,
`media-video`, `media-file`) tell consumers how to render or generate
the field's value.

**Examples** (from the publication/blog starter manifests):
```yaml
content:
  type: string
  x-mcp-hint: markdown        # admin uses markdown editor; agents know to author markdown

coverUrl:
  type: string
  format: uri
  x-mcp-hint: media-image     # media-shaped URL; first-run uses external URLs
```

**Implementation status**: declared in
`@aotter/mantle-spec` as the `MCP_HINT_KEYWORD` constant. The
conventional values are `markdown`, `richtext`, `code`, `media`,
`media-image`, `media-video`, `media-file`, `money-minor`, and
`timestamp-ms` (the `media*` subset marks media-shaped fields).
MCP tool schemas preserve the hint for agents. Admin surfaces expose
media-shaped fields but first-party upload hosting is optional and not
part of first-run provisioning.

---

Anything beyond these three (policies, computed columns, RBAC grants,
owner declarations, `x-mantle-bind` enum extension) is **DRAFT** — see
appendix.

**Postgres analogue**: `CREATE TABLE posts (id UUID PRIMARY KEY, ...,
UNIQUE (slug, locale));`

### 2. `View` — the read surface (auto-exposed by surface)

A named, declarative read over Schemas. No Trigger is required. A View with
no `spec.surface` (or `surface: public`) mounts at
`GET /api/views/<name>` and becomes `query_view_<name>` on `/mcp`.
`surface: staff` instead mounts at `GET /admin/api/views/<name>` behind the
staff gate and appears only on `/mcp/staff`. See ADR-0012 for the full design
rationale.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: recent-published }
spec:
  from: posts
  fields: [id, title, slug, locale, publishedAt, updatedAt]
  filter:
    eq: { field: status, value: published }
  orderBy:
    - { field: updatedAt, direction: desc }
  limit: 20
```

**Param-driven Views** declare `spec.params` (a JSON Schema with
`type: object`); filter values reference them via the
`{ $param: <name> }` sentinel:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: posts-by-locale }
spec:
  from: post-translations
  params:
    type: object
    properties:
      locale: { type: string }
    required: [locale]
  filter:
    and:
      - eq: { field: status, value: published }
      - eq: { field: locale, value: { $param: locale } }
  limit: 100
```

REST callers paginate via reserved query-string knobs `?page=&show=`
(1-indexed page, server caps `show` at `View.spec.limit`). Reserved
names — `page` / `show` / `cursor` — must NOT appear in
`spec.params.properties` (the parser rejects with
`VIEW_PARAMS_RESERVED_NAME`).

Views may declare the same `requires.auth.all` predicates and optional
`requires.guard.procedure` as Procedures. Static auth runs before parameter
validation; the guard receives validated params and authorizes the whole
query. It does not rewrite SQL or filter individual rows. REST and MCP View
calls share this path.

Response envelope:

```json
{ "ok": true, "data": { "rows": [...], "page": 1, "show": 20, "hasMore": true } }
```

`hasMore` is the lazy form: `rows.length === show` ⇒ `true`. No COUNT
query, no `LIMIT n+1` probe.

**v0.1 filter AST**: comparison operators (`eq`, `gt`, `gte`, `lt`,
`lte`) plus `and` / `or`. Comparison `value` may be a literal or a
`{ $param: <name> }` sentinel. v0.1.0 enforces required-only param refs;
optional-with-skip semantics are reserved for v0.1.x. Field-to-field
comparisons are not supported yet; compare a field to a literal or
param. Anything else (`contains`, `recursive`, `gatedBy`,
`join.aggregate`, `policies.skip`) is DRAFT.

**Postgres analogue**: `CREATE VIEW recent_published AS SELECT ...
FROM posts WHERE status = 'published' ORDER BY updated_at DESC LIMIT
20;`. PG views are read-API surfaces by virtue of being queryable —
ours work the same way, just over HTTP.

### 3. `Procedure` — the typed callable (internal until bound)

The **only atom with a code seam**. YAML declares typed input + typed
output + auth requirement + handler reference; the consumer's project
provides the handler function with auto-generated TS types.

`Procedure` is **transport-agnostic and not directly exposed**. It does
not contain HTTP paths, methods, or MCP tool names. To call a Procedure
from outside the SDK runtime, declare a `Trigger` whose `target` points
at it. The same Procedure can be bound by multiple Triggers (HTTP +
cron + MCP + lifecycle, all sharing one handler).

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: send-contact-message }
spec:
  requires:
    auth:
      all: [ctx.user]                # logged-in users only
  input:
    type: object
    required: [name, message]
    properties:
      name:    { type: string, minLength: 1, maxLength: 80 }
      email:   { type: string, format: email }
      message: { type: string, minLength: 1, maxLength: 4000 }
  output:
    type: object
    properties:
      ok: { type: boolean }
  handler:
    kind: ref
    ref:  send-contact-message        # opaque registration key (NOT a path)
```

```ts
// src/mantle/config.ts
import { sendContactMessage } from "./handlers/send-contact-message";

export const handlers = {
  "send-contact-message": sendContactMessage,
};
```

**v0.1 `requires.auth`**: `{ all: [<predicate>] }` only. Predicates:
- `ctx.user` — caller is any signed-in end-user
- `ctx.staff: [<role>, ...]` — caller is staff in one of these roles
- `ctx.auth` — caller supplied any adapter-verified credential
- `ctx.auth.scope: <scope>` — verified credential carries the exact opaque,
  consumer-owned scope; repeat to require multiple scopes

Anything beyond this (`any:`, `owns:`, `withinMinutes:`, `contains:`,
`requires.window`, `requires.quota`, `errors`, `retry`) is DRAFT.

Both Procedures and Views may add one dynamic guard beside `auth`:

```yaml
requires:
  auth:
    all:
      - ctx.auth
      - { "ctx.auth.scope": "orders:read" }
  guard:
    procedure: require-active-access
```

The guard is an ordinary declared `handler.kind: ref` Procedure. It receives
the validated target input/View params and the same `HandlerContext`; success
permits the target. Any guard diagnostic, invalid output, missing handler, or
throw fails closed. Guards cannot be builtin, self-referential, or guarded
themselves. Current payments, membership, and entitlement state belongs in
the consumer guard handler, not in a new atom or Core repository. See
[API and MCP authorization](api-mcp-authorization.md).

**v0.1.0 `handler.kind`**: `ref` (author-supplied function) or
`builtin` (SDK-supplied CRUD shortcut). For `builtin`, declare
`op: <create | update | upsert | delete | archive>` and
`schema: <Schema name>` in place of `ref`. The runtime dispatch path is
implemented by `InvokeBuiltinUseCase`; parser and boot validation fail closed
on unknown ops, Schemas, or incompatible lifecycle use.

**Postgres analogue**: `CREATE FUNCTION send_contact_message(input
JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$ ... $$;`. PG functions are
internal callables — `pg_proc` rows scoped to a schema, not externally
addressable. Exposing them via HTTP requires PostgREST or a custom
RPC layer; in our world, that layer is `Trigger`.

### 4. `Trigger` — the event binding (the whole external surface for writes)

Says "when X happens, run Procedure Y." Every external surface for a
write — HTTP endpoint, MCP tool, cron job, lifecycle hook, queue
consumer — is a `Trigger`. There is no other way to expose a
Procedure.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: contact-http }
spec:
  source:
    kind:   http                       # v0.1 also supports mcp and lifecycle
    method: POST                       # POST | PUT | PATCH | DELETE
    path:   /api/contact               # OpenAPI {param} syntax for path params
                                       # path params auto-bind to identically-named input fields
                                       # input MUST declare them; no optional segments
  target:
    procedure: send-contact-message
```

The same Procedure can have multiple Triggers — that's how it becomes
"an HTTP endpoint AND a cron job AND an MCP tool" without duplicating
handler logic. Each transport is one Trigger; the Procedure body is
shared.

**v0.1 `Trigger.source.kind`**: `http` (public endpoint), `mcp` (named
tool on `surface: public | staff`), or `lifecycle` (entry-writer hook). For `lifecycle`, declare `schema`,
`on: [<hook>, ...]` from `LifecycleHook`, and optional `errorPolicy`
(`abort` is the `before_*` default; `continue` is the `after_*` default).
Lifecycle hooks are wired through `LifecycleHookingEntryRepository`, so
MCP, admin, and builtin write paths share the same hook behavior.

- `cron` / `queue` are **DRAFT (v0.2+)** — speculative, gated by
  concrete consumer demand. Same appendix § "DRAFT (v0.2+)."

The state-machine "lifecycle" from the Schema atom
(`Schema.spec.lifecycle: publishing | editorial`) is a separate domain
that shares the word. The Schema setting governs which states an
entry can be in; shipped lifecycle Triggers govern what fires around
mutations.

**Postgres analogue**: `CREATE TRIGGER ... AFTER INSERT ON posts
EXECUTE FUNCTION ...` (lifecycle); `pg_cron` extension (cron); plus
`CREATE FUNCTION` exposed via PostgREST routes (http) — Postgres has
had all of these via extensions for years, just split across multiple
mechanisms. We unify them under one atom.

## OpenAPI emission — manifests in, OpenAPI out

> See the `mantle-spec` README for rationale — why OpenAPI is
> emission target, not manifest shape (keeps MCP and other source
> kinds first-class peers, not `x-` extensions on an HTTP-flavored
> type).

The `Trigger { source.kind: http }` + `Procedure` pair is **not** an
OpenAPI Operation Object. It's a smaller, transport-neutral pair. The
SDK emits standard OpenAPI 3.1 from the manifest set so existing
tooling (Swagger UI, Redoc, openapi-generator, Stainless, Speakeasy)
works unchanged:

```bash
$ mantle emit-openapi --output ./openapi.json
```

Mapping:
- Each `Trigger { source.kind: http, target.procedure: X }` → one
  OpenAPI Operation Object at `path` + `method`
- The target Procedure's `input` → OpenAPI request body schema
- The target Procedure's `output` → OpenAPI 200 response schema
- configured cookie, OAuth bearer, API-key, and personal-token schemes →
  accurate OpenAPI `security` alternatives for auth-gated targets
- repeated `ctx.auth.scope` predicates → OAuth scopes plus
  `x-mantle-required-scopes`
- `requires.guard.procedure` → `x-mantle-guard-procedure` plus a `402`
  response
- Error code → HTTP status mapping (below) → OpenAPI 4xx/5xx response
  shapes

MCP Procedure tools emit from `Trigger.source.kind: mcp`; Views emit on their
declared surface. Catalog filtering is discovery UX only. Every `tools/call`
re-runs static auth and the dynamic guard. Required scopes/guard behavior stay
in the standard Tool description rather than a non-standard required-scopes
field.

## Manifest validation — JSON Schema in, zod at runtime

The author writes JSON Schema; the runtime validates with zod.
That split is intentional and load-bearing.

- **Authoring contract** = JSON Schema. `Schema.spec.schema`,
  `Procedure.spec.input`, `Procedure.spec.output` are all
  draft-2020-12 JSON Schema documents. This is what AI authors and
  human authors write, what the admin UI feeds JSON Forms, and what
  the OpenAPI emitter relays unchanged.
- **Runtime engine** = zod (v3). The `@aotter/mantle-spec`
  package ships a JSON-Schema → zod converter
  (`src/json-schema-zod.ts`); the runtime calls the converted zod
  schema on every Procedure invocation, View parameter parse, and
  manifest boot check.

**Why zod, not Ajv**: Cloudflare Workers' default Content-Security
Policy posture and bundle-size budget make Ajv (which generates
validators via `new Function(...)`) a poor fit. zod is interpreted,
ships small, and has no eval-shaped code paths. The price is a
narrower JSON Schema feature set; the converter documents which
keywords it supports.

The split also means: **manifests stay portable**. A consumer who
later swaps to a non-Workers adapter inherits the same JSON Schema
manifests; only the runtime validator changes if the adapter has
different constraints.

## Error code → HTTP status table

| Code | HTTP | When |
|---|---|---|
| `INPUT_VALIDATION_FAILED` | `400` | Procedure input fails zod-converted schema |
| `UNAUTHENTICATED` | `401` | no active session (admin API: missing/expired session cookie) |
| `AUTH_DENIED` | `403` | `requires.auth` predicate evaluated false (or admin: caller lacks required staff role) |
| `ENTITLEMENT_REQUIRED` | `402` | consumer guard denies current payment/membership/transaction entitlement |
| `NOT_FOUND` | `404` | resource not found — admin: approval id; runtime: View name at `/api/views/<name>` |
| `HANDLER_NOT_REGISTERED` | `500` | `handler.ref` key not registered at boot |
| `DISPATCHER_NOT_BUILT` | `501` | runtime feature not implemented in this SDK build |
| `INTERNAL_ERROR` | `500` | uncaught handler exception |
| `OUTPUT_VALIDATION_FAILED` | `500` | handler returned a value not matching its declared output schema |

All emitted with `phase: "runtime"` per ADR-0008. The same code
may also fire in earlier loops (e.g. `HANDLER_NOT_REGISTERED`
fires at boot — `phase: "boot"` — and that's where it should be
caught; the runtime occurrence is defense-in-depth).

Additional runtime codes activate as future grammar surfaces (e.g.
`QUOTA_EXCEEDED → 429` arrives with `requires.quota`).

## RBAC — what v0.1 ships, what's DRAFT

v0.1 auth gates use `requires.auth.all` with `ctx.user`,
`ctx.staff: [<roles>]`, `ctx.auth`, and `ctx.auth.scope` predicates on
Procedures and Views. This covers staff-only, logged-in-only,
credential-protected, and delegated-scope targets. One Procedure-backed guard
handles mutable consumer business state without widening the static grammar.

**Not yet shipped** (DRAFT):
- Row-level read visibility (private posts, friend-only audiences)
- Field-level write policies (this user can update body but not
  parent_id)
- Cross-Schema policy inheritance (gatedBy)
- Quotas, edit-windows, rate limits

These all live as `Schema.spec.policies.*` and `Procedure.spec.requires.*`
sub-specs in the DRAFT spec. See "Future grammar" appendix.

## How to think when extending this CMS

1. **What entities does the feature need?** → `Schema` for each.
2. **What named queries?** → `View` for each. Ad-hoc reads happen in
   Procedure handlers; only sanctioned ones get a View (and become
   external read endpoints).
3. **What operations?** → `Procedure` for each. One Procedure = one
   typed function call. Compose in handler code, not in YAML.
4. **What invokes them?** → `Trigger` per source. Multiple Triggers
   can target the same Procedure (HTTP + MCP + cron, all on one
   handler).
5. **Who's allowed?** → `Procedure/View.spec.requires.auth` for static
   identity/scope; optional `requires.guard.procedure` for one live,
   consumer-owned business check. Row-level and field-level rules remain
   future grammar.

If you find yourself wanting a 5th kind, **stop**. Sketch the same
thing as a composition of the four; almost always it works.

### Postgres heuristic for "is this an atom?"

> If it's a `CREATE X` in Postgres that an **application developer**
> would write (not a DBA, not the query planner), it maps to one of
> our 4 atoms. If it's a `CREATE X` that PG only needs because PG is a
> database engine — `INDEX`, `MATERIALIZED VIEW`, `TABLESPACE`,
> `STATISTICS`, `EVENT TRIGGER`, `EXTENSION`, `LANGUAGE`,
> `PUBLICATION`, `FOREIGN TABLE`, `RULE` — it **doesn't** map, and
> you likely don't need it either. Type-system extensions (`TYPE`,
> `DOMAIN`, `SEQUENCE`, `COLLATION`, `CAST`, `AGGREGATE`, `OPERATOR`)
> fold into JSON Schema inside `Schema` rather than becoming new
> kinds.

Postgres exposes ~25 object kinds total; an application developer
typically only writes 4–6 of them. The rest are engine internals that
Cloudflare D1 / KV abstract away.

## Storage backend — D1 today, Postgres-via-Hyperdrive tomorrow

> See the `mantle-cloudflare` README for rationale — why D1 for
> v0.1 (no-CC OSS onboarding, platform-native), and the documented
> PG path.

### How `Schema` data is stored on D1 today

All collections share one `entries` table (defined by the
Cloudflare adapter's storage migrations in
`@aotter/mantle-cloudflare`):

```sql
CREATE TABLE entries (
  id          TEXT PRIMARY KEY,
  collection  TEXT NOT NULL,        -- discriminator: 'posts', 'comments', ...
  status      TEXT NOT NULL,        -- 'draft' / 'published' / ...
  version     INTEGER NOT NULL,
  data        TEXT NOT NULL,        -- JSON blob: every Schema property (incl. locale, per ADR-0010)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  author_id   TEXT REFERENCES users(id)
);
```

Reserved metadata are native columns; **everything in your Schema's
`spec.schema.properties` lives inside the `data` JSON blob**. Locale
on localized Schemas lives at `data.locale` (per ADR-0010); for
indexing it surfaces as a JSON-extracted virtual generated column
(`json_extract(data, '$.locale')`) with a partial unique index, not as
a top-level column.

`uniqueIndexes` and ordered, non-unique `indexes` declarations compile
into affinity-correct virtual generated columns plus partial B-tree
indexes via the spec engine's DDL emitter (`@aotter/mantle-spec`).
Different collections coexist on the same table without colliding
because each generated-column expression is gated by `WHEN collection
= '<name>'`. See [Schema indexes on D1](schema-indexes.md) for the
grammar, leftmost-prefix rules, SQL helper, and query-plan examples.

### What works well on D1

- D1's SQLite has the **JSON1 extension built in**: `json_extract`,
  `json_each`, `json_object`, `json_array`, `json_set`, `json_valid`,
  plus `->` / `->>` operators.
- Reserved-column queries (`status = 'published'`, `ORDER BY
  updated_at`) use native indexes — fast.
- `uniqueIndexes`- and `indexes`-declared paths use virtual columns +
  partial indexes. Core-compiled Views and repository lookups reference
  those columns instead of repeating `json_extract`.

### Where D1's JSON support has limits (vs Postgres)

| Concern | D1 / SQLite | Postgres |
|---|---|---|
| JSON storage | TEXT — re-parsed on every `json_extract` | JSONB — stored as compact binary; faster repeated extraction |
| Index any JSON path | must declare each path explicitly via virtual column + index | GIN index on JSONB indexes all paths automatically |
| Array containment | `EXISTS (SELECT 1 FROM json_each(...) WHERE value = ?)` — full scan unless indexed | `data @> ARRAY[x]` with GIN — native operator |
| Path operators | `->`, `->>` only | `->`, `->>`, `#>`, `#>>`, `@>`, `?`, `?|`, `?&` |
| `DEFAULT now()` | not at column level — SDK-stamped via `x-mantle-bind: now` | native column default |
| Foreign key on JSON path | not supported on `VIRTUAL` columns; needs `STORED` (extra space) | not natively, but B-tree on expression OK |
| Row-level security | none — SDK-side filter rewriting | native RLS policies |
| Multi-statement transactions | session API serializes; not true ACID across statements | full ACID transactions |

### Practical scale envelope on D1

- **Blog-scale (< 10k entries / collection)**: today's design is
  comfortable. Anonymous public responses can hit version-local Workers
  Cache before the Worker; origin misses use indexed D1 reads.
- **Mid-scale (10k – 100k entries)**: declare measured list/filter
  access paths with ordered `indexes`. Cross-collection JSON-path joins
  may eventually gain `x-mantle-ref` auto-lift; that remains DRAFT.
- **Hard D1 limits**: 1 MB max row size; 5,000 rows per query result;
  single-writer per database (concurrent writes serialize).
- **Cross-region read**: D1 is region-pinned; first origin hit from a
  far region may pay replica latency. Eligible anonymous responses are
  then served by version-local Workers Cache.

### Scale-up path: D1 → Postgres via Cloudflare Hyperdrive

Cloudflare does not run a first-party Postgres service. The supported
path when D1 limits bind is **Cloudflare Hyperdrive** (a connection
pooler + query-cache that lets a Worker connect to any external
Postgres at near-edge latency):

- **Neon** (serverless Postgres with scale-to-zero) — closest
  ergonomic match; tightest CF integration.
- **Supabase** (PG + auth + storage) — works out of the box.
- **AWS RDS / Google Cloud SQL / Azure DB / self-hosted PG** — also
  supported via Hyperdrive.

When this path is taken (post-v0.1; not implemented yet), the
**author-facing YAML stays unchanged**. The SDK's compile target swaps:

| What changes (SDK runtime) | Author impact |
|---|---|
| `data TEXT` → `data JSONB` | none |
| Virtual generated columns → optional (PG can use GIN) | author may stop declaring `indexes` if defaults suffice; the same YAML remains valid |
| `json_each` → array operators (`@>`, `&&`) | none — predicates stay declarative |
| SDK-stamped `now` → `DEFAULT now()` (optional) | none |
| SDK-side policy rewriting → native RLS (optional) | none |
| `Trigger.target.project` single-writer DO → real same-transaction trigger | atomicity guarantee strengthens; YAML grammar unchanged (the `atomicity:` declaration just stops needing the eventual-consistency caveat) |

Migration shape: `entries` table dumped from D1, restored to PG. Stay
single-table-with-discriminator (drop-in) or split into
table-per-collection (more PG-idiomatic, longer migration). Both shapes
remain valid `cms.mantle.aotter.net/v1` deployments.

**v0.1 commitment**: D1 only via the Cloudflare adapter. Hyperdrive +
PG path is documented as the upgrade route but not implemented. SDKs
and starters target D1 exclusively. The Netlify adapter package
(`@aotter/mantle-netlify`) is a README stub for v0.2; its
existence is an engineering forcing function ensuring the runtime
package stays portable across adapters.

## Roadmap — what's not in v0.1.0

> See [ADR-0001 §"Future grammar discipline"](adr/0001-four-atom-manifest-model.md#future-grammar-discipline-was-poc-adr-0005)
> for the v0.1 minimum-vs-roadmap discipline, the promotion process,
> and the YAGNI argument that gates speculative shipping.

The atoms are locked at 4. Their **inner grammar** is intentionally
narrow at v0.1.0 and grows in two tiers:

1. **v0.1.0 shipped** — grammar parses and runtime behavior is wired
   in the current rebuild.
2. **v0.1.x committed** — on the patch-release roadmap. Spec is
   documented; implementation lands within the v0.1 series. The unsupported
   runtime path fails closed with a code naming the feature.
3. **DRAFT (v0.2+)** — speculative, gated by concrete consumer
   demand. Parser/static validation rejects with `DRAFT_KEY_USED`. May or may
   not ship — depends on whether real use cases apply pressure.

### v0.1.0 shipped

#### `Trigger.source.kind: lifecycle` — bind a Procedure to a Schema event

Grammar lives in v0.1.0. Runtime is the
`LifecycleHookingEntryRepository` decorator wrapping the entry-writer
chokepoint so MCP / admin / builtin paths all fire the same hooks.
Full shape lives further down.

#### `Procedure.handler.kind: builtin` — SDK-supplied CRUD Procedure

Grammar lives in v0.1.0. Runtime is the
`InvokeBuiltinUseCase` that dispatches `op: create | update | upsert
| delete | archive` against the entry-writer chokepoint with `x-mantle-bind`
stamping and `input ∩ Schema.properties` projection. Full shape lives
further down.

#### `Trigger.source.kind: mcp` and shared authorization

An MCP Trigger binds a declared Procedure to either the public or staff MCP
surface. Procedures/Views share `ctx.auth`/scope predicates and optional guard
orchestration across REST and MCP. Staff role is loaded live for each protected
call; staff Views remain absent and un-callable on public MCP.

### Detailed shipped grammar and reserved lifecycle

> The `handler.kind: builtin` and `Trigger.source.kind: lifecycle`
> sections below describe shipped v0.1.0 behavior. Only the
> `Schema.spec.lifecycle: editorial` remains reserved for a later release.

#### `Schema.spec.lifecycle: editorial` runtime

The parser reserves the key, but manifest validation emits
`LIFECYCLE_NOT_IN_V010`. When the approval-queue runtime lands, the same grammar
can be enabled without inventing a second lifecycle name.

#### `handler.kind: builtin` — thin shortcut over the storage adapter for trivial CRUD-shaped Procedures

Use when the body is "insert a row" / "update a row" / "delete a
row"; reach for `ref` when there is real business logic. Shape:

```yaml
spec:
  input:  { ... JSON Schema for the request body ... }
  output: { ... JSON Schema for the response body ... }
  handler:
    kind:   builtin
    op:     create | update | upsert | delete | archive
    schema: <Schema metadata.name>
```

| op | Behavior |
|---|---|
| `create` | INSERT a new row. Project `input ∩ Schema.spec.schema.properties`; stamp `x-mantle-bind` fields; generated id; status is `draft`, or immediately `published` for `lifecycle: operational`. |
| `update` | UPDATE in place. `input.id` + `input.expectedVersion` (OCC) required. Bumps version. |
| `upsert` | If `input.id` resolves, behaves as `update`; else as `create`. |
| `delete` | Hard DELETE by id. |
| `archive` | Soft-archive (status='archived'). The manifest validator permits this builtin only for `editorial` Schemas; the archive transition itself is runtime-wired, while editorial approval/request-publish remains deferred. |

The Procedure's `input` is the contract with the *caller*. It MAY
declare fields the Schema does not (e.g. a Turnstile token). The
builtin op silently projects `input ∩ Schema.properties` and ignores
the rest; JSON Schema's default `additionalProperties: true` lets
the side-channel fields pass validation. To act on those fields
(read the token, call the vendor), declare a `before_create`
lifecycle Trigger — see below.

`request_publish` and `publish` are intentionally not in the
builtin vocabulary. They are editorial-workflow operations, not CRUD
primitives.

#### `Trigger.source.kind: lifecycle` — bind a Procedure to a Schema event

Shape:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: contact-bot-check }
spec:
  source:
    kind:   lifecycle
    schema: contact-messages
    on:     [before_create]            # one or more hooks
    errorPolicy: abort                 # default: abort for before_*, continue for after_*
  target:
    procedure: bot-check                # any Procedure — re-bound across schemas
```

| Hook | Fires |
|---|---|
| `before_create` | Before INSERT. Throw cancels. |
| `after_create` | After INSERT. Default best-effort. |
| `before_update` | Before UPDATE. Throw cancels. |
| `after_update` | After UPDATE. Default best-effort. |
| `before_delete` | Before DELETE. Throw cancels. |
| `after_delete` | After DELETE. Default best-effort. |
| `before_publish` | Before any supported status transition to `published` (the shipped workflow is `publishing`). |
| `after_publish` | After any supported status transition to `published` (the shipped workflow is `publishing`). |

**Atomicity defaults by phase**:
- `before_*`: `errorPolicy: abort`. Handler throw cancels the
  surrounding mutation; caller receives the diagnostic.
- `after_*`: `errorPolicy: continue`. The committed mutation remains
  successful. On the inline / `ctx.waitUntil` path, a failure is logged
  and swallowed. With an optional `DeferredHookDispatcher`, failures
  surface to the delivery adapter so its at-least-once retry/DLQ policy
  can run; they still never roll back the entry mutation.

Authors override either default by declaring `errorPolicy: abort |
continue` explicitly.

**Hook handler input** is phase-specific. Synchronous `before_*` hooks
receive the original pre-projection Procedure input, so a
`before_create` hook on `contact-messages` can read the caller's
`recaptchaToken` even though the row never stores it. Every `after_*`
hook receives only persisted `entry.data`; deferred envelopes never
retain arbitrary request input.

Handlers also receive
`ctx.event = { id, trigger, hook, schema, entry }`. `id` is stable
across enqueue fallback and deferred retries; `trigger` is the current
`Trigger.metadata.name`. Deferred handlers use `${id}:${trigger}` as
their idempotency key. `entry` is null only on `before_create`; it is
the pre-mutation row for the other `before_*` hooks and the persisted
post-mutation row for every `after_*`.

**Hook ordering**: when multiple lifecycle Triggers bind the same
`(schema, hook)`, the runtime fires them **alphabetically by
`Trigger.metadata.name`**. A `priority: number` key is reserved for
v0.2; today, choose names that sort correctly (`010-bot-check`,
`020-rate-limit`).

For deferred delivery, that ordered Trigger-name list is captured in
one strict versioned event. Every captured Trigger runs before a
failure is returned to the Queue, so retry may replay Triggers that
already succeeded. Queue acceptance is not transactional with D1,
`waitUntil` fallback is best-effort, and exactly-once is not promised.
Cloudflare wiring, the 128 KB platform limit, retry/DLQ configuration,
idempotency, and legacy-envelope draining are specified in
[Deferred lifecycle hooks on Cloudflare Queues](deferred-lifecycle-queues.md).

`before_publish` and `after_publish` already wrap the shipped publishing
transition. When editorial approval lands, the same hooks wrap its final
transition to `published`; no second hook grammar is planned.

### DRAFT (v0.2+, speculative)

Each item below lands when the first concrete real-world use case
forces it, not on speculation. Today, do not implement; parser/static
validation rejects it with `DRAFT_KEY_USED`.

#### Schema future
- **`x-mantle-ref` auto-lift to virtual column** — when a property
  carrying `x-mantle-ref: <other-schema>` is referenced in any registered
  View's `filter:` or future `join:`, the SDK auto-creates the virtual
  column + non-unique index without requiring an explicit `indexes`
  declaration. Solves cross-collection JSON-path join
  performance without making authors think about it. Pure SDK
  behavior; no new YAML grammar.
- **`spec.policies.visible`** — row-level read predicate auto-AND'd
  into Views from this Schema. Lands with first private/audience
  feature.
- **`spec.policies.readable.fields`** — field-level wire-mask. Lands
  when staff-only fields surface (e.g. `threadLength` visible to
  editors only).
- **`spec.policies.writable.{fields, create}`** — field-level write
  gate auto-applied to all writers.
- **`spec.policies.owner`** — names the ownership column for `owns:`
  predicate. Currently implicit (`authorId`).
- **Computed columns via projection Trigger** — see `Trigger.target`.

#### View future
- **`recursive: { parent, rootWhen, pathBy, depthAs?, pathAs?, maxDepth }`**
  — declarative recursive CTE. Lands with first threaded-reads feature
  (comments, taxonomies).
- **`params: { <name>: <jsonschema> }`** — caller-bound view parameters.
- **`gatedBy: [{ schema, policy, on }]`** — cross-Schema visibility
  inheritance.
- **`join: [{ as, from, on, project?, aggregate?: count|exists, bind? }]`**
  — joined relations with optional reducer (per-row count or boolean).
- **`policies: { skip: [<policy-name> | field, ...] }`** — explicit
  bypass for admin/audit Views.
- Filter AST extension: `contains` (array containment), `not`, `in`, `like`.

#### Procedure future
- **`requires.auth.any`** with disjunction; the shipped `all` predicate
  vocabulary extends to `owns: { schema, idFrom }`, `contains: {
  schema, idFrom, field, valueFrom }`.
- **`requires.window.{withinMinutes, column?}`** — temporal
  precondition, sibling-modifier of `owns:`. DRY rule: window MUST
  sit beside exactly one `(schema, id)`-binding predicate in the same
  any/all group.
- **`requires.quota.{key, limit, per, overrideFrom?}`** — declarative
  rate cap. Override Schema lookup keyed by `ctx.user`. Counter
  substrate: Durable Object.
- **`errors.{onHandlerThrow, onRecursionDepth, maxDepth}`** + **`retry.{
  limit, backoff, retryOn, idempotencyKey?}`** — failure-policy
  declared. Retry + `op: create` requires `idempotencyKey:` (parse
  error otherwise).

#### Trigger future
- **`source.kind: cron`** with `expr:` — scheduled invocation.
- **`source.kind: queue`** — async fan-out / message-driven invocation.
- **`source.kind: lifecycle.foo`** — DRAFT extensions to the shipped
  lifecycle hooks (e.g. `before_archive`, `after_request_publish`).
  The 8 hooks listed in the detailed shipped section are the floor,
  not the ceiling.

(Full lifecycle Trigger spec for the 8 shipped hooks lives
in the detailed section above. The remaining DRAFT items
below are the speculative v0.2+ shapes that haven't yet been promoted
to a committed roadmap.)

- **`target.project: { schema, where, set: { <col>: { aggregate, from,
  where } } }`** — declarative aggregate-projection across Schemas.
  Replaces hand-written counter handlers. Same-transaction on PG;
  bounded-eventual on D1 via single-writer DO.
- **`atomicity: same-transaction | best-effort`** — explicit guarantee
  declaration when projection Triggers ship.

#### Cross-cutting future
- **Closed `ctx.*` predicate identity**: v0.1 `{ user, staff, auth,
  auth.scope }`
  extends to `{ ..., system }` when SDK-internal Trigger executor
  paths land. Multi-tenant deployments would add `{ tenant }` via
  grammar-revise round if/when that product shape is pursued. New
  entries require explicit grammar-revise (closed enum is
  load-bearing infrastructure).
- **Placeholder namespace `$.*`**: `$.input.<f>`, `$.row.<f>`, `$.op`,
  `$.params.<f>`, `$.source` — write-time data-flow bindings inside
  policy ASTs and handler signatures. Distinct from `:ctx.*` identity
  bindings; one-site evaluation rule.
- **`Schema.spec.staffBypass: [<role>]`** — DRY shortcut once
  `ctx.staff: [editor, owner]` repetition crosses 4+ schemas.

Each extension goes through a 3-agent review (yml-editor proposes /
code-impler tests buildability / fresh-dev verifies clarity) before
locking. v0.1 is the floor, not the ceiling.

## Lineage — the academic foundations

| Atom | Theory |
|---|---|
| `Schema` | Codd, "A Relational Model of Data..." (1970); SQL-92 base tables |
| `View` | Codd 1970; relational algebra (σ π ⋈ γ); SEQUEL/SQL DML |
| `Procedure` | SQL/PSM (1996); typed I/O; Birrell & Nelson RPC (1984); Moggi monads (1991) |
| `Trigger` | Active Database / ECA rules (Diaz & Paton, *Active Database Systems* 1999) |

The composite design — declarative resources + ECA-fired procedures +
policy-gated execution — is sometimes labeled **Active Database +
Policy-Based Management**. Postgres + PostgREST + pg_cron is the
canonical full-stack reference; we abstract that pattern up to the
application layer with K8s-style YAML manifests.
