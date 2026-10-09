# ADR-0040: Mantle is a thin toolkit over native hosts and dialects

**Status:** Accepted direction; implementation changes require their own review.

**Date:** 2026-10-09

**Amends:** ADR-0007's premise that the runtime carries application complexity.
Clarifies ADR-0019, ADR-0032, ADR-0036 and ADR-0039; their existing execution,
policy and trust-boundary guarantees remain in force.

## Context

Mantle is a config-as-code toolkit. Authors, usually working with their own
coding agent, choose application semantics and operate the resulting service.
Mantle compiles manifests into a sealed plan and wires execution to the selected
host and dialect. Generated application source remains application-owned.

ADR-0007's original wording encouraged moving complexity into the runtime.
That is too broad: automatic query repairs, extra coordination protocols and
resource wrappers can conceal native behavior and impose costs on every call.
ADR-0039 already rejects this approach for PostgreSQL emulation. The same
boundary should govern future SDK decisions.

## Decision

### 1. Responsibility follows ownership

| Owner | Responsibility |
|---|---|
| Application author and coding agent | Business rules, SQL result semantics, unique paging order, indexes, migration planning, deployment, authorization configuration and performance tuning. |
| Mantle compiler and Core | Faithful lowering and execution of the declared contract, structured diagnostics, existing policy enforcement, correct transactions and request context. |
| Host, dialect and native libraries | Native query execution, connection pooling, transaction mechanisms, transport state and platform lifetimes, wired by the application or its preset. |

SDK bugs remain Mantle's responsibility. Losing an authored sort key, retaining
another request's context or recreating a reusable pool is not an author error.
Applications configure authorization; Mantle must correctly enforce the
declared scope, visibility and caller contract.

### 2. Preserve native semantics and performance

- Each dialect is its own target. Preserve its ordering, collation, indexes,
  transaction behavior and query planner rather than emulate another engine.
- Reuse native resources for their supported lifetime: a host-supported pool
  and persistent transport can outlive requests; request context cannot.
  This does not require cross-request client reuse on hosts that forbid it.
- Prefer direct fixes to SQL lowering, closure ownership or existing dispatch
  arguments. Do not add a second pool, proxy or lifecycle manager around a
  native implementation without a concrete requirement and measured benefit.
- Do not add per-call queries, window functions, probes or round trips merely
  to compensate for an application precondition. Any necessary added cost must
  be explicit and justified against the native execution path.

### 3. Store stays a clean persistence abstraction

Store retains its declared query, policy and atomic-write contract. It does
not become an application orchestrator, tuning service, pool manager or
deployment coordinator. Host-specific execution and resource ownership stay
at the host/driver seam; business policy stays in authored application logic.

### 4. Make requirements visible, not magical

Document preconditions with types, generated source, SQL examples and
actionable diagnostics. Check facts known at generation time there. Keep
validation at each trust boundary, including runtime plans. Avoid redundant
checks within the same trusted execution path.

For example, keyset paging requires an ordering unique to each result row;
a parent ID alone may not suffice after a one-to-many join. State that
requirement rather than silently invent a key or add a default uniqueness
query. A diagnostic must not claim proof the compiler cannot establish.

Native configuration belongs at the existing host or dialect seam. Avoid a
new configuration language or generic option bag when application-owned code
already expresses the choice. Defaults and generated behavior must be
documented. This decision neither removes existing guarantees nor silently
changes existing defaults.

## Consequences

Authors and their coding agents carry application-specific decisions. Mantle
must provide enough inspectable output and diagnostics for them to do so.
Portability means selecting and compiling for a target, not equal behavior
or equal performance across targets.

Some application errors cannot be proven away by Core. Support limits must
be stated honestly. Required validation, authorization, OCC and atomicity
remain SDK obligations; thinness is not permission to weaken them.

## Alternatives

- **A runtime that automatically makes arbitrary applications safe or fast.**
  Rejected: it expands responsibility and adds hidden query work and state.
- **Expose only raw drivers.** Rejected: manifest compilation, Store's declared
  guarantees and optional composed surfaces are the toolkit's purpose.

## How to apply

For a proposed change, identify its owner, the smallest existing seam that can
implement it, and any added query work, round trips or persistent state. Prefer
an existing native primitive or an explicit authoring requirement before a
new abstraction. Measure performance-sensitive execution changes and test the
specific guarantees affected; do not create a general subsystem for one case.

## Implementation status

This records the architecture direction. It changes no runtime code, manifest
grammar, paging behavior, pooling, collation defaults or migration policy.
Individual fixes and compatibility changes need separately reviewed changes.
