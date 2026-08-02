# @aotter/mantle-spec

Spec engine for mantle.

This package owns the manifest grammar, YAML parsing, validation diagnostics,
locale helpers, JSON-Schema to zod conversion, and the CLI primitives used by
the umbrella package. Direct installs expose the fallback `mantle-spec` binary;
adopter projects use `mantle` from `@aotter/mantle`.

`0.0.7-alpha` is an early prerelease for the agent-provisioning proof. The API
surface remains in flux until `v0.1.0`.
