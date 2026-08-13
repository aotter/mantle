# ADR-0009: Consumer-supplied manifests at SDK boot

**Status:** Carried over from POC v0.0.x; amended for the parser-free v0.1
consumer boundary.

**Date:** 2026-05-01 (POC); last amended 2026-08-03

**Related:** [ADR-0001](0001-four-atom-manifest-model.md),
[ADR-0007](0007-ai-as-primary-author.md),
[ADR-0018](0018-core-starters-repository-boundary.md)

## Context

The four-atom model promises that domain shape is authored in the consumer's
project. Core therefore cannot ship a fixed manifest set: doing so would force
every new Schema, View, Procedure, or Trigger through an SDK fork/release.

The first v0.1 implementation imported YAML as Wrangler Text modules and parsed
it during Worker startup. That kept ownership correct but leaked authoring-only
YAML machinery into the runtime bundle and coupled consumers to Wrangler
`[[rules]]`. The public CLI now provides one build-time compilation boundary.

## Decision

Consumers own exactly `manifests/site.yaml`. The installed `mantle` CLI parses
and validates its multi-document YAML, then writes the machine-owned runtime
module and handler types. A missing or differently named file fails before
generation:

```bash
pnpm exec mantle generate
pnpm exec mantle generate --check
```

The outputs are:

- `.mantle/generated/site.ts` — a parser-free `readonly Manifest[]` export;
- `.mantle/generated/types.d.ts` — handler declarations derived from the same
  validated manifest set.

The Worker imports the generated array rather than YAML text:

```ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { manifest } from "../.mantle/generated/site.js";

export default createMantleWorker({ manifest });
```

Low-level composition passes the same array as `CmsConfig.manifests`. Core and
adapters ship zero application manifests. The registry, boot validator, View
executor, HTTP/MCP mounts, and tool catalog are built only from the consumer's
generated array.

`mantle generate --check` must gate validation/deploy so authored YAML cannot
drift from checked-in generated output. Generation never edits YAML, handlers,
skills, package metadata, styles, or provider configuration.

### Adapter scope

Compilation is adapter-independent and uses Node at author/build time. The
Worker runtime receives plain typed objects, so Cloudflare needs no YAML Text
module rule and a future adapter needs no equivalent bundler hook.

### Single authority

YAML remains the authored source of truth. Generated TypeScript is a
deterministic transport artifact and must not be hand-edited. Parser
diagnostics point to the consumer manifest document/pointer before generation;
runtime boot validation covers cross-manifest and registered-handler facts.

## Worked example

The external [`aotter/mantle-starters`](https://github.com/aotter/mantle-starters)
repository owns the blank project and typed overlays. Materialized projects
carry their own `manifests/site.yaml`, generated module, handlers, and package scripts;
they consume the exact packed Core artifact rather than a workspace link.

## Consequences

### Benefits

- Consumers can compose all four atoms without forking or publishing Core.
- One CLI parse/validation path drives runtime objects and handler types.
- Worker bundles do not include the YAML parser or consumer YAML text imports.
- Every REST/MCP catalog automatically reflects the generated consumer set.
- Other adapters consume the same `readonly Manifest[]` with no filesystem or
  bundler-specific manifest loader.

### Costs

- Projects keep deterministic generated files and must run `generate` after
  editing YAML.
- CI/deploy must run `generate --check`; otherwise an old generated module can
  outlive its source YAML.
- Merge conflicts in generated output are resolved by re-running the installed
  command, never by editing the artifact.

### Risks and controls

- **Version skew:** always run the generator from the installed package and
  read its embedded docs. Do not generate a versioned project from `develop`.
- **Hidden stale output:** keep `mantle generate --check` in the normal project
  validation gate.
- **Runtime/parser divergence:** generated objects come from the same parser
  used by `validate`; focused packed-package tests compare the consumer output.
- **Multi-tenancy pressure:** Core still sees one flat manifest set per Worker.
  Tenant isolation remains an application concern; this ADR adds no namespace.

## Alternatives considered

**Runtime YAML Text imports.** Replaced. They require Wrangler-specific rules,
ambient YAML modules, and ship authoring-only parse machinery in the Worker.

**Runtime filesystem discovery.** Rejected. Workers have no runtime filesystem,
and hidden discovery would make inputs and diagnostics less deterministic.

**Application-specific manifest packages.** Rejected for the baseline. It adds
publish/version overhead to files that belong in one consumer repo.

**SDK-embedded manifests or override precedence.** Rejected. Core is
content-agnostic, so there is no default manifest set and no merge policy.

## How to apply

When a Core feature needs the manifest set, accept the parsed consumer-owned
array; never hardcode starter collection names or read consumer files at
runtime.

When authoring or reviewing a generated project:

1. Edit only `manifests/site.yaml`; do not create feature-named manifest files.
2. Run the installed `pnpm exec mantle generate`.
3. Import `manifest` from `.mantle/generated/site.js` into the conventional
   Worker, or pass it as `CmsConfig.manifests` in low-level composition.
4. Run `pnpm exec mantle generate --check` in validation and before deploy.
5. Reject Wrangler YAML Text rules, runtime `parseManifests*` calls, or a second
   manifest loader in a new generated project.

## Implementation status

Implemented by the umbrella `mantle generate` command and the conventional
Cloudflare Worker facade. Exact commands and output paths are documented in the
version-matched `@aotter/mantle` README and embedded Core skills.
