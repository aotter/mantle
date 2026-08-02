# @aotter/mantle-spec

Spec engine for mantle.

This package owns the manifest grammar, YAML parsing, validation diagnostics,
locale helpers, JSON-Schema to zod conversion, and the direct-consumer
`mantle-spec` CLI. Generated sites install `@aotter/mantle`, which owns the
full `mantle` command including `generate` and `update`.

`0.0.7-alpha` is an early prerelease for the agent-provisioning proof. The API
surface remains in flux until `v0.1.0`.
