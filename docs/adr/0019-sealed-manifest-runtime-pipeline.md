# ADR-0019: Seal the manifest-to-runtime pipeline

**Status:** Accepted

**Date:** 2026-08-16

**Related:** [#656](https://github.com/aotter/mantle/issues/656),
[#662](https://github.com/aotter/mantle/issues/662),
[#546](https://github.com/aotter/mantle/issues/546), ADR-0008, ADR-0009,
ADR-0011, ADR-0018

## Context

Mantle already has an adapter-neutral runtime package and structured
diagnostics, but its real execution boundary is still the complete Cloudflare
site product. Authored YAML is parsed into an ordinary `Manifest[]`; validation,
defaulting, lookup construction, boot checks, SQL compilation, storage setup,
public rendering, and Admin helpers then overlap across spec, runtime, and the
Cloudflare adapter.

That overlap creates two portability failures:

1. A downstream caller can bypass an earlier stage and reinterpret raw
   manifests, so a rule or default can have more than one owner.
2. Embedding the runtime also selects SQL-shaped storage, public Web behavior,
   Admin assets, and Cloudflare-oriented boot conventions.

The product needs one embeddable Core that can be called directly by an
existing application, with Web, Admin, and platform integrations selected
downstream. The migration cannot introduce a permanent `v2` pipeline beside
the current one: every compatibility path must delegate forward and be deleted
within the same milestone.

## Decision

### One sealed pipeline

Mantle has one supported semantic path:

```text
ManifestSourceSet
  -> parse + normalize
  -> ParsedManifestSet
  -> link
  -> LinkedManifestSet
  -> compile
  -> RuntimePlan
  -> prepare deployment
  -> PreparedRevision
  -> bind runtime
  -> MantleRuntime
```

Decode may remain an internal parser step. The public contract starts with
caller-supplied sources and ends with a programmatic runtime. A failed stage
does not produce a usable value for the next stage.

Parse, link, and compile are pure and deterministic. Their sealed outputs may
be constructed only by their owning package, apart from explicit test fixture
helpers. Source locations remain authored metadata; they do not affect the
semantic fingerprint.

### One owner per invariant

| Stage | Owns | Must not own |
|---|---|---|
| Parse + normalize | YAML syntax/alias limits, closed four-atom shape, primitive and atom-local rules, behavior-affecting defaults, source metadata | Cross-atom references, handlers, storage, optional routes |
| Link | Duplicate symbols, cross-atom references, guard graphs, translations, manifest-owned route/tool collisions | I/O, selected modules, handler availability |
| Compile | Immutable lookup records, authorization plans, Trigger indices, Procedure descriptors, logical View plans, semantic fingerprint | Connections, repositories, handlers, requests, templates, assets |
| Prepare | Selected storage migrations/indexes/native Views, handler availability, selected capability/route checks, readiness revision | YAML interpretation or request execution |
| Bind/invoke | Semantic ports, handler dispatch, parameter binding, centralized authorization, content/View/Procedure/Trigger/lifecycle operations | DDL, route mounting, assets, HTTP/session/cache policy |
| Optional modules/adapters | Web/Admin composition and request/session/cache/platform translation | Re-parsing, re-linking, or a second authorization/runtime stack |

The current-to-target rule ledger and evidence are maintained in
[`docs/sealed-pipeline-ownership.md`](../sealed-pipeline-ownership.md).

### Core and optional products

`@aotter/mantle-spec` owns source, parse, normalize, link, introspection, and
manifest-derived code generation. It has no runtime or platform dependency.

`@aotter/mantle-runtime` owns `RuntimePlan`, preparation contracts, semantic
storage ports, and `MantleRuntime`. The portable runtime input is prepared
semantic storage, not `DatabaseDriver`. It has no Web, Admin, Cloudflare, Bun,
or Vercel dependency.

`@aotter/mantle-web` is optional and owns the official public HTML, Markdown,
`llms.txt`, sitemap, SEO, preview, template, and public-path composition.
Applications still own their router, URLs, navigation, and design. Platform
adapters own HTTP mounting and cache behavior.

`@aotter/mantle-admin` is optional and owns Admin API/application
orchestration and its asset contract. `@aotter/mantle-admin-ui` remains the UI
artifact. Core supplies content operations and authorization but does not
serve the UI or reserve Admin paths when the module is absent.

Cloudflare, Bun, and Vercel packages bind platform storage, lifecycle,
request/session, cache, and asset concerns. They may expose convenience
facades, but those facades compose the same Core and selected modules.

### Storage and Views

Preparation accepts a selected storage adapter and produces semantic ports,
including existing content repositories/readers and a `ViewQueryExecutor`.
Concrete D1/SQLite drivers and SQL repositories remain implementation details.
An existing application may either pass its already-owned database/client to
an official adapter or implement the semantic ports over its own tables.

Declarative Views compile to logical plans once. Storage preparation lowers
those plans to native queries. The v0.1 `View.spec.sql` form remains explicitly
SQLite-only and is rejected by unsupported storage during preparation; Mantle
does not guess a translation and does not add a universal query driver.

### Naming and code generation

The Core execution unit is `MantleRuntime`, not a site. Optional TypeScript
generation is a pure projection of linked/compiled semantics and exposes
`bindMantle(runtime)`. It emits deterministic lower-camel identifiers while
preserving manifest wire names internally. Identifier collisions are errors.

Code generation is never required by the runtime and never copies Web or Admin
assets. Dynamic/string-based calls remain the escape hatch for JavaScript and
runtime-defined consumers.

### Migration rule

Issues #663 through #673 move ownership in pipeline order. At every step:

- existing callers may use a temporary wrapper only if it delegates to the new
  owner;
- no rule, default, query compiler, authorization evaluator, or router is
  implemented twice;
- the old owner and its obsolete tests are deleted when its last caller moves;
- exact packed consumers, not workspace links, are the final compatibility
  gate.

Breaking API changes from the `v0.1.0-alpha.7` contract are allowed in the
0.1.2 milestone. Migration notes should keep old projects mechanically
adaptable, but downward compatibility is not a reason to retain a second stack.

## Consequences

### Positive

- Human and agent authors get one deterministic path and one diagnostic owner.
- Existing applications can embed Core without surrendering process, router,
  database, or transaction ownership.
- Web, Admin, and each platform can evolve without entering Core.
- Performance work happens once per semantic revision instead of per request.
- Compatibility code has a defined deletion point.

### Negative

- 0.1.2 intentionally breaks parts of the alpha.7 API.
- Cloudflare's current convenience facade must be decomposed and then
  reassembled from optional modules.
- Downstream projects must update generated imports and runtime construction.
- Exact consumer tests are required across more than one platform.

## Alternatives

### Keep `Manifest[]` as the shared contract

Rejected. It cannot prove that defaults, references, and plans were evaluated
once, and it lets every downstream package rebuild semantic state.

### Generalize `DatabaseDriver` for every database

Rejected. Its SQL/D1 shape is not a useful MongoDB or application-domain
contract. Existing semantic repository ports are the smaller portable seam.

### Add a plugin/provider framework

Rejected. Ordinary package dependencies, exported mount functions, and narrow
ports cover the known compositions. A registry would add a second architecture
before a use case requires it.

### Build a parallel Core v2 and migrate later

Rejected. It duplicates rules and makes deletion optional. The migration is
ordered specifically so each new owner replaces the old owner in place.

## How to apply

- Start a pipeline change at the current owner listed in the rule ledger.
- Add one check at the new owner, route every caller through it, then delete the
  old implementation and obsolete tests.
- Reject runtime imports of raw manifests, Web/Admin packages, or platform
  primitives once their migration issue closes.
- Prefer current ports and native platform APIs; add a package only for a real
  dependency/runtime boundary.
- PR descriptions for #656 must state old owner, new owner, evidence, deleted
  code, and any diagnostic timing change.

## Implementation status

Issue #662 records the current behavior, ownership ledger, consumer corpus, and
performance baseline. Issues #663 through #674 execute the migration and final
repository cleanup. The ADR is complete only when #673 removes every temporary
compatibility path; #674 then updates contributor guidance to the final tree.
