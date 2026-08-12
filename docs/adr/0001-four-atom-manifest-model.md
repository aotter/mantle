# ADR-0001: 4-atom YAML manifest model under `cms.mantle.aotter.net/v1`

**Status:** Carried over from POC v0.0.x; refreshed and folded for v0.1.0 (incorporates POC ADRs 0005 + 0006).

**Date**: 2026-04-30 (POC origin), refreshed 2026-05-03 for v0.1.0 rebuild

**Deciders**: phsu

**Related**: ADR-0002 (closed enums for bindings)

---

## Context

The SDK's surface area to consumers is YAML manifests. The
question is: what set of resource kinds does that surface
expose? Too few and authors find themselves cramming concepts
into the wrong atom; too many and consumers face a long enum of
"what kind do I write today" with overlapping semantics.

Earlier iterations of this CMS experimented with 11 domain-shaped
kinds (`ContentSchema`, `ContentView`, `Form`, `Membership`,
`Email`, `Webhook`, `Workflow`, `ScheduledJob`, etc.). Two
problems surfaced:

1. **Authors couldn't find the right atom for a new feature.**
   "Is a contact form a `Form`, a `Workflow`, an `Email`, or all
   three?" Real features cross domain boundaries.
2. **Atoms drifted toward overlap.** A `Form` developed an
   `email:` block; a `Webhook` developed a `validation:` block;
   each new kind grew to subsume neighbors.

A multi-round design experiment (6 rounds + R6.5 falsification +
R7 reframing, run as a 4-agent debate over a blog feature
progression: like button → threaded comments → private posts →
rate-limited writes → cross-Schema invariants) reduced the kind
count to 4 and tested those 4 against 6 increasingly demanding
features without needing a 5th.

The relevant history that this ADR records (so future readers
don't re-litigate it):

- **R0 — "atoms ≡ PG primitives" claim**: the experiment opened
  with the heuristic "4 kinds because Postgres has 4
  application-developer primitives." Held for 6 rounds without
  challenge.
- **R6.5 — falsification round**: an agent proposed cutting to
  3 atoms by folding `Procedure` into `Schema.operations` (PG
  functions attach to schemas in pg_proc). 92→58 LOC reduction
  in the worked example by adding a default-CRUD shortcut.
  Accepted by the round's judge.
- **R7 — user reframing**: reverted to 4 atoms, but for a
  different reason than R0. The right axis isn't "PG
  primitive"; it's "contract vs implementation × state vs
  event":

  | | request | event |
  |---|---|---|
  | external API | View (read) / write-API atom | (empty in v0.1) |
  | internal | (Schema's writes are via the write-API atom) | Trigger (reaction) / Schema (state) |

**Design lesson** (worth surfacing because it shaped both this
ADR and the multi-doc YAML decision below): in multi-round
agent-team debates, decisions ratified in early rounds tend to
inherit forward through later rounds even when the local
conditions that justified them have changed. The orchestrator
must re-test prior naming / structural decisions whenever the
spec surface materially shifts; agent-team consensus is a strong
signal but not authoritative.

## Decision

The SDK exposes exactly **four declarative resource kinds** under
the `cms.mantle.aotter.net/v1` API group:

| Atom | Postgres equivalent | Externally exposed by itself? | Has user code? |
|---|---|---|---|
| `Schema` | `CREATE TABLE` | no | no |
| `View` | `CREATE VIEW` | yes (auto-mounted at `GET /api/views/<name>`; see ADR-0012) | no |
| `Procedure` | `CREATE FUNCTION ... LANGUAGE plpgsql` | **no** (transport-agnostic; needs a Trigger to bind) | **yes — handler ref to consumer's TS** |
| `Trigger` | `CREATE TRIGGER` + `pg_cron` + PostgREST route + `LISTEN/NOTIFY` | yes (the binding atom) | no |

### Path A: Trigger does all binding

A Procedure is **not externally exposed by itself**. To make it
callable over HTTP / MCP / cron / lifecycle / queue, declare a
`Trigger` whose `target.procedure` points at it. The same
Procedure can be bound by multiple Triggers (HTTP + cron + MCP,
all sharing one handler).

This is "Path A" relative to an alternative considered (and
rejected — see below) where Procedures carried an inline
`expose:` block.

### PG-1:1 mapping is the primary onboarding pitch

The mapping above is what new authors see first. Authors with
Postgres background orient instantly. Authors without it get a
mental anchor with 30 years of Codd/SQL/PostgREST literature
behind it.

### Composition rule

Anything more domain-shaped than these 4 (a `Form`,
`Membership`, `Email`, `Webhook`, `Workflow`, `ScheduledJob`)
is **not** an atom. It is composed in the consumer project by
combining the 4 atoms with consumer TypeScript. If a proposed
new feature wants a 5th kind, the proposer must show the 4
existing atoms cannot express it.

## Consequences

### Pros

- One question — "is it state, a query, an operation, or an
  event-binding?" — picks the atom every time. No "form vs
  workflow" gray zone.
- Read/write asymmetry (Views auto-mount, Procedures require
  Triggers) matches HTTP safe-vs-unsafe semantics. Authors don't
  have to remember which kinds the SDK auto-routes; the rule is
  derivable from the atom's nature.
- PG mapping gives the spec 30 years of literature and battle
  testing as background. Postgres has shipped these primitives
  in the same shape since SQL-92 (Schema, View, Procedure) plus
  Active Database / ECA rules from the 1990s (Trigger).
- Closed atom count makes the SDK's testing surface tractable:
  every code path can be enumerated as
  Schema-creation / View-query / Procedure-invocation /
  Trigger-firing combinations.

### Costs

- Atoms are coarse. A "form-with-validation-and-email" feature
  is 3 manifests (Schema + Procedure + Trigger), not 1. Mitigated
  by multi-doc YAML grouping (see § Authoring shape below).
- "Procedure is not directly exposed" is a teaching point; new
  authors initially try to call a Procedure URL and get 404.
  Mitigated by the dispatcher emitting a hint in the 404 if a
  Procedure exists with no Trigger binding (DRAFT — not yet
  spec'd as a code).
- The PG-1:1 pitch breaks down once authors look at the actual
  storage layer (D1 today). The mapping is conceptual; the
  runtime is SQLite + JSON.

### Risks

- **Authors try to subsume domain concepts into the 4 atoms by
  cramming.** A `Form` becomes "a Schema + a Procedure + an
  ad-hoc validator block in the handler." Mitigated by
  multi-doc YAML keeping atoms separate while the file count
  stays low; reviewers should push back when a single Procedure's
  handler becomes a workflow engine.
- **Trigger.source.kind expansion pressure.** v0.1 only ships
  `http`. As MCP / cron / lifecycle / queue source kinds land
  (DRAFT — see § Future grammar discipline below), the same
  atom has to accommodate radically different invocation shapes.
  The contract holds (one binding atom, many source kinds) but
  each new kind is a design pass.
- **The PG-1:1 pitch may become a constraint.** If a future
  capability has no PG analogue, framing pressure will push to
  shoehorn it into the table or to break the pitch. Either is
  defensible; the discipline is to flag the choice consciously.

## Alternatives considered

**(a) 11 domain-shaped kinds (early scaffolding)**.
Rejected: cross-cutting features didn't fit single kinds;
adjacent kinds drifted toward overlap. Authors couldn't pick.

**(b) 5 kinds — keep `Policy` as a separate atom**.
Rejected: row/field-level policy is sub-spec on the atom whose
data it concerns (Schema-attached visibility, Procedure-attached
auth gate). Lifting Policy to a kind invented a 5th locator
authors had to consult; folding it kept the locator count down.

**(c) 3 kinds — fold Procedure into `Schema.operations`** (R6.5).
Rejected: under R7's reframing, the right axis is contract /
implementation × state / event, not "PG attachment." Schema
holds state; Procedure holds operations against state; folding
them conflates "what data exists" with "what can happen to data."
Also the LOC win that motivated the fold (92→58 via default-CRUD)
was recovered without folding — captured in the DRAFT
`handler.kind: builtin` shortcut.

**(d) 4 kinds with `Procedure` retaining inline
`expose: { http: ... }` for single-source bindings**.
Rejected: created two ways to bind HTTP (inline `expose:` for
single-source, separate `Trigger` for multi-source). Doctrine
tax forever. Multi-doc YAML solves the file-count complaint
that motivated `expose:` without inventing redundant grammar.
See § Authoring shape below for the full retirement rationale.

## How to apply

- Adding a new feature: ask which of the 4 atoms holds each
  piece. Use the "external by itself?" column to settle "do I
  need a Trigger here?"
- Adding a new top-level kind: do not. First express as a
  composition of the 4 + consumer TS. If the composition is
  awkward, look for sub-spec on an existing atom before adding
  a 5th kind.
- Renaming an atom: do not. The names are public surface; even
  internally-motivated renames tend to drag schema-revise effort
  across consumers, code, docs, and agent training data. Bias
  toward keeping the names.
- Reading the spec: Schema = state, View = read API,
  Procedure = write API (internal), Trigger = binding. That
  4-word gloss covers ~90% of the questions authors ask.

## Implementation status

Names + PG-1:1 framing are documented in this ADR and the manifest grammar
reference. Manifest TS types live in `packages/mantle-spec/`. The external
[`aotter/mantle-starters`](https://github.com/aotter/mantle-starters)
repository declares consumer instances of each atom. Runtime dispatcher, View
executor, and Procedure dispatcher live in this repository.

---

## Future grammar discipline (was POC ADR-0005)

> Folded in 2026-05-03 from POC ADR-0005 ("v0.1 minimum essential
> grammar; rich grammar reserved as DRAFT"). The discipline below
> applies to every key inside every atom defined above.

### Context

The 4-atom design experiment (same 6 rounds + R6.5 + R7 cited
above) produced a rich inner grammar:

- 18 grammar keys across the 4 atoms
- 7 meta-rules (DRY across `requires` siblings; one-site
  placeholder evaluation; SDK helper doctrine; closed
  `x-mantle-bind` enum; list-shape for cross-resource refs;
  singleton-fallback exception; ctx.system origin invariant)
- 2 closed enums (`x-mantle-bind`, `ctx.*` predicate identity)
- 2 placeholder namespaces (`:ctx.*` identity bindings, `$.*`
  data-flow bindings)
- ~36 cognitive surface units (consumer-cc count)

The pressure-tested grammar covered features as ambitious as
`Trigger.target.project` (declarative cross-Schema aggregate
projection in same-tx), `Schema.spec.policies.{visible,
readable, writable}` (PG-RLS-style row/field policy),
`View.recursive` (declarative recursive CTEs),
`requires.window/quota/owns/contains` (temporal predicates,
rate caps, row ownership, array containment), and
`handler.kind: builtin` (default-CRUD shortcut).

Shipping all of that in v0.1 would mean roughly 5–10× the
dispatcher / validator / type-system surface v0.1 actually
needs, plus an OpenAPI emission story for keys (recursive CTEs,
RLS) that have no clean OpenAPI mapping.

The user principle, articulated 2026-04-30 EOD:

> 本次 iteration 只匡出四個 yml 最 minimum essential 的 grammar，
> 四個都蓋出來且能動，之後當應用場景擴充真的有需要再往上蓋。

(Translation: this iteration only ships the absolute minimum
grammar to make the 4 atoms work end-to-end; each extension
arrives when a real application use case demands it.)

This is YAGNI applied to grammar surface, motivated by:

- The runtime cost above.
- The risk that speculative grammar locks the wrong shape —
  features designed in the abstract often look different once a
  real use case applies pressure (R3-R5 of the design experiment
  showed multiple grammar shapes proposed and revised as
  features unfolded).
- The maintenance cost of keys nobody uses but everybody must
  understand.

### Decision

The v0.1 ship targets **minimum essential grammar only**. Rich
grammar from the design experiment is preserved as DRAFT in the
manifest grammar reference; it lands when a concrete use case
forces it.

#### v0.1 grammar lock per atom

**Schema (v0.1)**:
- `spec.schema:` (JSON Schema 2020-12 body)
- `spec.uniqueIndexes:` (composite uniques)
- `spec.indexes:` (ordered composite, non-unique access paths)
- `spec.searchableFields:` (top-level string allowlist; entry id is implicit)
- `spec.uiSchema.list.filterField:` (Admin-only operational enum tabs; indexed)
- Property extensions: `x-mantle-bind`, `x-mantle-ref`, `x-mcp-hint`

**View (v0.1)**:
- `spec.from:` (source Schema)
- `spec.fields:` (projected fields)
- `spec.filter:` AST — `eq`, `gt`, `gte`, `lt`, `lte`, `and`, `or`
- `spec.orderBy:`
- `spec.limit:`
- `spec.params:` (required query params referenced by filter values)
- `spec.requires.{auth, guard}:` (same authorization contract as Procedure)

**Procedure (v0.1)**:
- `spec.requires.auth.all:` (closed predicate vocabulary)
- `spec.requires.guard.procedure:` (one consumer-owned dynamic guard)
- `spec.input:` (JSON Schema 2020-12)
- `spec.output:` (JSON Schema 2020-12)
- `spec.handler.{kind: ref, ref: <opaque-key>}` — author-supplied
  handler function
- `spec.handler.{kind: builtin, op: <create | update | upsert |
  delete>, schema: <Schema name>}` — SDK-supplied CRUD shortcut
  (promoted to v0.1.0; runtime implemented by `InvokeBuiltinUseCase`)

**Trigger (v0.1)**:
- `spec.source.kind: http` — public HTTP endpoint
- `spec.source.{method, path}` (when `kind: http`)
- `spec.source.kind: lifecycle` — entry-writer hook (promoted to
  v0.1.0; runtime implemented by `LifecycleHookingEntryRepository`)
- `spec.source.{schema, on, errorPolicy}` (when `kind: lifecycle`)
- `spec.source.kind: mcp` plus `surface: public | staff` — MCP tool
  exposure for a declared Procedure
- `spec.target.procedure:`

#### v0.1 closed enums

- `x-mantle-bind: {ctx.user, ctx.staff, now}`
- `ctx.*` predicate vocabulary: `{user, staff, auth, auth.scope}` (no
  `system` until a use case forces it)
- `Trigger.source.kind: {http, lifecycle, mcp}`
- `Procedure.handler.kind: {ref, builtin}`
- `BuiltinOp: {create, update, upsert, delete}`
- `LifecycleHook: {before_create, after_create, before_update,
  after_update, before_delete, after_delete, before_publish,
  after_publish}`

#### What's DRAFT (do not implement, do not type)

- Schema: `policies.{visible, readable, writable, owner}`,
  `x-mantle-ref` auto-lift to virtual column,
  computed columns via projection Trigger
- View: `recursive`, `gatedBy`, `join`, `policies.skip`,
  filter AST extensions (`contains`, `not`, `in`, `like`)
- Procedure: `requires.auth.{any | all}` with disjunction;
  `owns:`, `contains:`, `withinMinutes:`, `requires.window`,
  `requires.quota`, `errors`, `retry`
- Trigger: `source.kind: {cron, queue}`,
  `target.project`, `atomicity`
  (`source.kind: mcp` was promoted in alpha.16 — #281)
- Cross-cutting: `ctx.system`, `$.*` placeholder namespace,
  `staffBypass:`

#### Discipline

- The v0.1 validator **rejects DRAFT keys at parse time** with a
  `DRAFT_KEY_USED` warning (not error — see the
  AI-as-primary-author contract on permissive bias). The
  diagnostic explicitly references the future-grammar reference
  so authors know the key is reserved, not
  unsupported-and-forgotten.
- Each DRAFT key has a documented **landing condition** (the
  use case that surfaces it). Promoting a key to v0.1+ requires
  showing that condition has been met — not just "it would be
  nice to have."
- Each promotion goes through a 3-agent design review
  (yml-editor proposes / code-impler tests buildability /
  fresh-dev verifies clarity) before locking.
- The v0.1 floor is the floor, not the ceiling. The atom set
  (4) is locked; the grammar inside each atom is permitted to
  grow.

### Consequences

#### Pros

- v0.1 dispatcher / validator / types are tractable in a small
  number of weeks, not many months.
- Author cognitive surface is small: 4 atoms × ~5 keys each ≈
  20 things to learn, instead of 18 keys with ~36 cognitive
  surface units.
- DRAFT keys document where the spec is **going**, so authors
  with future requirements can tell whether the project is on
  trajectory or not — without those features being prematurely
  committed.
- Each DRAFT promotion gets a real use case attached, so the
  grammar evolves under empirical pressure rather than
  speculation. This was the design experiment's strongest
  signal: features like `View.recursive` and
  `Trigger.target.project` looked very different once a real
  feature (threaded comments, cross-Schema invariants) applied
  pressure.

#### Costs

- Authors with ambitions beyond v0.1 (private posts, role-gated
  reads, rate limits, recursive views) must wait or write
  handler-side TS. For some projects this is enough to shop
  elsewhere; that's acceptable for an OSS v0.1.
- DRAFT documentation is itself a maintenance burden — the
  reference has to stay coherent as the spec evolves; stale
  DRAFT entries (features no longer planned) need pruning.
- The "warning, not error, on DRAFT keys" rule means an author
  who copies a DRAFT example into a manifest doesn't fail —
  they get a warning. This requires the validator to know the
  full DRAFT vocabulary, not just the v0.1 vocabulary.

#### Risks

- **Grammar surface grows ad-hoc.** Each DRAFT promotion looks
  reasonable; together they reproduce the over-grammar v0.1
  was avoiding. Mitigation: 3-agent review per promotion;
  promotions land in batches with documented use cases, not
  one-by-one.
- **DRAFT becomes vaporware.** Some DRAFT features are listed
  but never land because their use case never surfaces.
  Mitigation: this is fine — the appendix is documenting
  shapes, not commitments. If a DRAFT entry stays cold for >12
  months, prune it from the appendix and let the future
  proposer re-derive it.
- **Authors hit walls and route around the SDK.** "I need
  `View.recursive` so I'll just write raw SQL in a Procedure
  handler" — over time this drifts the actual extension shape
  away from what the SDK eventually builds. Mitigation: when
  ad-hoc handler patterns repeat, that's the use case that
  promotes the DRAFT key. Watch handler implementations for
  recurring patterns.

### Alternatives considered

**(a) Ship the full experiment grammar in v0.1**.
Rejected: 5–10× the dispatcher work; locks shapes in the
abstract before real use cases apply pressure; author surface
explodes.

**(b) Don't document DRAFT at all; ship v0.1 spec only**.
Rejected: authors with future requirements have no way to
evaluate trajectory; the design experiment's results would be
lost institutionally; future proposals would re-litigate solved
questions. The DRAFT reference is a forward-looking invariant.

**(c) Ship a subset of DRAFT in v0.1 (e.g. `policies.visible`
and `requires.auth.any`)**.
Rejected: any line we draw between v0.1 and DRAFT has the same
litigation problem. The principled cut is "minimum essential to
make 4 atoms work end-to-end"; anything richer needs a specific
motivation. None of the DRAFT features had that motivation in
the v0.1 ship list.

**(d) Promote DRAFT keys lazily — implement at runtime when
authors ask, no spec lock**.
Rejected: spec coherence demands keys are spec'd before they
ship. Authors writing against runtime-only features get
silently broken on SDK upgrades.

### How to apply

- Authoring v0.1 manifests: stick to the v0.1 vocabulary above.
  If something seems missing, check the DRAFT reference; if it's
  there and you have a concrete use case, file an issue
  describing the use case.
- SDK code: implement only v0.1 keys in the dispatcher /
  validator / types. DRAFT keys are documented but not handled.
- DRAFT promotion: needs a documented use case + 3-agent design
  review + ADR landing the promotion (with cross-link to the
  use case).
- Pruning DRAFT: if an entry has stayed cold for 12+ months,
  propose removal in a small ADR. Removal is reversible (the
  shape is in the experiment transcripts and prior ADR
  history).

---

## Authoring shape: multi-doc YAML (was POC ADR-0006)

> Folded in 2026-05-03 from POC ADR-0006 ("Multi-doc YAML over
> inline shortcuts for atom co-location"). The decision below
> defines how authors lay manifests out on disk; it is the
> direct corollary of "Trigger does all binding" above.

### Context

The 4-atom model means a single user-visible feature commonly
bundles multiple atoms. A contact form is at minimum:

- A `Schema` for `contact-messages`
- A `Procedure` `send-contact-message` (handler validates +
  inserts)
- A `Trigger` binding the Procedure to `POST /api/contact`

Three atoms, three manifests. With one file per manifest, a
small site with 10 features has 30+ manifest files. An early
design-experiment vibe-user called this out:

> 4 個 manifest 為了一顆 like 按鈕？要寫成這樣才能用？

(Translation: 4 manifests just for a like button? You have to
write all this to make it work?)

Two paths surfaced to address the file count:

#### Path A — Multi-doc YAML

YAML's standard `---` separator allows multiple documents in
one file. A "feature file" carries all atoms for that feature:

```yaml
# manifests/contact.yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: contact-messages }
spec:
  schema: { ... }

---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: send-contact-message }
spec:
  input:  { ... }
  output: { ... }
  handler: { kind: ref, ref: send-contact-message }

---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: contact-http }
spec:
  source: { kind: http, method: POST, path: /api/contact }
  target: { procedure: send-contact-message }
```

One file, three atoms, conceptual separation preserved. The
loader walks files and parses each `---` block as a separate
manifest.

#### Path B — Inline shortcut on Procedure (`expose:`)

Add a `Procedure.expose:` block that absorbs single-source HTTP
binding inline, eliminating the Trigger for the 1:1 case:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: send-contact-message }
spec:
  expose:
    http: { method: POST, path: /api/contact }
  input:  { ... }
  output: { ... }
  handler: { kind: ref, ref: send-contact-message }
```

The two paths solve the same surface concern (file count) but
have very different structural implications.

### Decision

**Path A: Multi-doc YAML.** `Procedure.expose:` is permanently
retired. Trigger does ALL transport binding. Co-locate related
atoms in one file via `---`.

#### Why Path B was retired

Path B created **two ways to bind a Procedure to HTTP**:

- For a Procedure with one HTTP transport: inline `expose:` on
  Procedure
- For a Procedure with multiple transports (HTTP + cron + MCP):
  separate `Trigger` per transport

This is the exact "two ways to do the same thing" failure mode.
Doctrine resolves it on paper ("expose for single, Trigger for
multi") but creates permanent tax:

- Authors must remember which form to use, and switch when
  cardinality changes (a single-HTTP Procedure that later
  needs an MCP binding has to be refactored from `expose:` to
  `Trigger`).
- The validator must understand both forms; OpenAPI emission
  has two source paths to walk.
- The PG-1:1 mapping is muddied: "Procedure ≡ pg_proc" is clean
  only if Procedure is internal-callable (no transport surface);
  `expose:` gives Procedure transport semantics, weakening the
  analogy.
- AI authors trying to introspect the manifest model get
  conflicting signals about what the atom does.

#### What multi-doc YAML accomplishes

- File count drops without inventing redundancy. A feature →
  one file, regardless of how many atoms it requires.
- Atom separation stays honest. Every atom has its own
  envelope (`apiVersion`, `kind`, `metadata`, `spec`); there
  is no "shortcut form."
- Related atoms sit next to each other for readers reviewing a
  feature.
- The PG-1:1 framing stays clean: Procedure is
  internal-callable, Trigger is the binding atom.

#### File organization conventions (suggested, not enforced)

- One feature → one file. Name the file by feature
  (`contact.yaml`, `posts.yaml`, `comments.yaml`), not by atom
  type.
- The shared file holds the Procedure + its Trigger + (when
  feature-specific) the Schema and View.
- Schemas that are referenced by many features can live in
  their own `<schema-name>.schema.yaml` file.
- Views with no Procedure / Trigger neighbors live in
  `<view-name>.view.yaml`.

The validator does not enforce naming conventions; it walks
all `*.yaml` under the manifest root and parses every `---`
block as a manifest.

### Consequences

#### Pros

- Single mechanism for HTTP binding (Trigger). Validator,
  OpenAPI emitter, runtime dispatcher all walk one shape.
- Conceptual atom separation preserved. The 4-atom story holds
  for every feature.
- File count tractable. A typical small site is 5–20 manifest
  files, not 30+.
- Cardinality changes (1 HTTP → HTTP + cron) are additive (add
  a Trigger); no refactor needed.
- AI authors learn one mental model, not two.

#### Costs

- Author must learn YAML's multi-doc syntax (`---`). This is
  standard YAML 1.2 and supported by every loader, but it is
  one more piece of syntax than "one file = one document."
- Some loaders (older / non-compliant) don't handle multi-doc.
  Standard `js-yaml` / `yaml` libraries do; the SDK uses
  `yaml` (already a dependency).
- File-discovery patterns (`find . -name "send-contact-message.trigger.yaml"`)
  no longer work for atoms inside multi-doc files. Authors
  must `grep` instead.
- Editor support: YAML language servers handle multi-doc, but
  some IDE features (e.g. JSON Schema validation per document
  in a multi-doc file) work less smoothly than in single-doc
  files. Acceptable for v0.1.

#### Risks

- **Author convenience pressure to reintroduce `expose:`.**
  Someone shows up with "but for the 80% case where I have one
  HTTP binding, the inline form is so much shorter!" The
  argument is real; the answer is: doctrine that creates two
  ways is permanent tax that grows with the codebase.
  Mitigation: this section is the answer to that argument; flag
  attempts and link here.
- **Multi-doc files grow unwieldy.** A "shop" feature might
  have a Schema + 3 Procedures + 5 Triggers + 2 Views. One
  file with 11 atoms is harder to navigate than 11 files.
  Mitigation: file-organization convention is suggestion, not
  rule; authors are free to split when it stops helping.
- **Co-location breaks discoverability for shared atoms.**
  A Schema referenced by 4 features can live in any of those
  4 files (or its own). Without grep / IDE go-to-def, finding
  the Schema definition requires knowing where the author
  put it. Mitigation: Loop 1 (`mantle validate`) emits the
  filesystem path in `VIEW_FROM_UNKNOWN_SCHEMA` diagnostics;
  IDE-shaped tooling (LSP — DRAFT) closes the rest.

### Alternatives considered

**(a) Path B: `Procedure.expose:`**.
Rejected (this section's main subject). Doctrine tax forever; PG
analogy weakened; cardinality refactor required when
single-source becomes multi-source.

**(b) One file per atom (early scaffolding default)**.
Rejected: file count complaint is real for multi-atom features.
Path A solves it without inventing redundancy.

**(c) New top-level kind `Feature` that bundles atoms**.
Rejected: turns a YAML file-organization concern into a spec
question. The 4-atom contract holds; an envelope-around-atoms
is structural noise.

**(d) Make Trigger optional with a default of "auto-mount the
Procedure at /api/p/<name>"**.
Rejected: hides the binding decision from the author, breaks
the PG-1:1 mapping (Procedures are not externally exposed by
themselves), and creates a third way to bind (this default +
explicit `Trigger` + explicit `expose:`).

### How to apply

- Authoring: one feature → one file with `---` separators.
- Reviewing: when an author writes a Procedure with an inline
  HTTP binding, push back with this section.
- Refactoring: a feature that grew from one HTTP binding to
  one HTTP + one cron + one MCP doesn't change the Procedure;
  it adds two more Triggers in the same file.
- Tooling: SDK loader walks `*.yaml` under manifest root and
  parses each `---` block; static validator emits diagnostics
  with file path + manifest pointer
  (`feature.yaml#/2/spec/from`) so multi-doc location stays
  precise.
