# @aotter/mantle-spec

Spec engine for mantle.

This package owns the manifest grammar, YAML parsing, validation diagnostics,
locale helpers, JSON-Schema to zod conversion, and the CLI primitives used by
the umbrella package. Direct installs expose the fallback `mantle-spec` binary;
adopter projects use `mantle` from `@aotter/mantle`.

This package is prerelease software. Its `package.json` is the exact version
authority; the API surface may change until `v0.1.0`.

## Embed the parser

Core accepts caller-owned source values; it does not require a project root or
a file named `site.yaml`:

```ts
import { parseManifestSources } from "@aotter/mantle-spec";

const parsed = parseManifestSources({
  sources: [{ sourceId: "database:tenant-42", text: manifestYaml }],
});

if (!parsed.ok) {
  throw new Error(JSON.stringify(parsed.diagnostics));
}

for (const { manifest, source } of parsed.value.entries) {
  console.log(manifest.kind, manifest.metadata.name, source);
}
```

`sourceId` is an opaque identity chosen by the caller. Successful values are
canonical and sealed; a failed parse returns diagnostics without a partial
`ParsedManifestSet`.

The CLI `--manifests` directory reads its immediate `.yaml` and `.yml` files
in lexicographic order. File names belong to the caller; discovery is not
recursive.

## Use Spec in an existing application

An application can reuse manifest parsing, linking, diagnostics, and entry-data
validation while keeping its own framework, storage, authentication, and admin
UI. It does not need to install Runtime or adopt a Starter.

See [Spec-only host adoption](https://github.com/aotter/mantle/blob/develop/docs/spec-only-host-adoption.md) for a
tested fixture, a model/ER-browser pattern, and the distinction between Spec
validation and a future maintainer-defined ecosystem recognition process.
