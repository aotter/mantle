# ADR-0001: 4-atom YAML manifest model under `cms.mantle.aotter.net/v1`

**Status:** Accepted for the four-atom grammar and multi-document YAML;
the fixed `site.yaml` file contract is superseded by ADR-0019.

**Date**: 2026-04-30 (POC origin); last amended 2026-08-16

**Deciders**: phsu

**Related**: ADR-0002 (closed enums for bindings),
[ADR-0019](0019-sealed-manifest-runtime-pipeline.md) (caller-owned source boundary)

> **2026-08-16 amendment:** the four atoms and multi-document YAML remain
> normative. Core no longer assigns source file names: its parser accepts
> caller-owned source IDs, and its CLI reads immediate `.yaml` / `.yml` files
> in lexicographic order. `manifests/site.yaml` remains only a starter
> convention. Fixed-file statements below are retained as decision history.

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
| `Trigger` | `CREATE TRIGGER` + route/tool binding | yes (the binding atom) | no |

### Path A: Trigger does all binding

A Procedure is **not externally exposed by itself**. To make it
callable over HTTP / MCP / lifecycle, declare a
`Trigger` whose `target.procedure` points at it. The same
Procedure can be bound by multiple Triggers (HTTP + MCP,
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
- **Trigger.source.kind expansion pressure.** v0.1 ships `http`, `mcp`,
  and `lifecycle`. Each new source kind requires a complete grammar and
  runtime design pass.
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
Also the LOC win that motivated the fold (92→58 via default CRUD)
was recovered without folding through the shipped
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

## Grammar changes

The parser accepts only grammar implemented by the current SDK. Unknown keys and
closed-enum values fail validation; Mantle does not reserve speculative syntax.
Add new grammar only alongside a concrete use case, runtime behavior, validation,
and an ADR update. Earlier experiments remain available in git history.

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

Three atoms, three documents. With one file per atom, a
small site with 10 features has 30+ manifest files. An early
design-experiment vibe-user called this out:

> 4 個 manifest 為了一顆 like 按鈕？要寫成這樣才能用？

(Translation: 4 manifests just for a like button? You have to
write all this to make it work?)

Two paths surfaced to address the file count:

#### Path A — Multi-doc YAML

YAML's standard `---` separator allows multiple documents in
one file. The fixed site manifest carries all atoms:

```yaml
# manifests/site.yaml
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
loader reads `site.yaml` and parses each `---` block as a separate
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
- For a Procedure with multiple transports (HTTP + MCP):
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

- File count drops without inventing redundancy. A site has one
  authored manifest file regardless of how many atoms it requires.
- Atom separation stays honest. Every atom has its own
  envelope (`apiVersion`, `kind`, `metadata`, `spec`); there
  is no "shortcut form."
- Related atoms sit next to each other for readers reviewing the site.
- The PG-1:1 framing stays clean: Procedure is
  internal-callable, Trigger is the binding atom.

#### Fixed file contract

The authored file is always `manifests/site.yaml`. The common loader rejects
a missing or differently named file, and every `---` document becomes one
atom. This is enforced so humans and agents never need a file-discovery rule.

### Consequences

#### Pros

- Single mechanism for HTTP binding (Trigger). Validator,
  OpenAPI emitter, runtime dispatcher all walk one shape.
- Conceptual atom separation preserved. The 4-atom story holds
  for every feature.
- File count is fixed at one authored manifest.
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
- Authors use `grep` by atom name inside `manifests/site.yaml` instead of
  discovering feature-specific filenames.
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
- **`site.yaml` can grow.** Search by `kind` plus `metadata.name`; reconsider
  splitting only when real projects show that one deterministic location is
  worse than file discovery.

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

- Authoring: put every atom in `manifests/site.yaml`, separated by `---`.
- Reviewing: when an author writes a Procedure with an inline
  HTTP binding, push back with this section.
- Refactoring: a feature that grew from one HTTP binding to
  HTTP + MCP doesn't change the Procedure; it adds one Trigger
  in the same file.
- Tooling: SDK loader reads `<manifest-root>/site.yaml` and parses each `---`
  block; static validator emits diagnostics
  with file path + manifest pointer
  (`site.yaml#/2/spec/from`) so multi-doc location stays
  precise.
