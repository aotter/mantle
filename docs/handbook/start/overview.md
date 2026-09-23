---
description: Choose a Mantle integration, discover manifest capabilities, and find tutorials, task guides, concepts and field-level reference.
---
# Mantle handbook

Mantle turns YAML manifests into a validated runtime plan, typed TypeScript
bindings, and optional HTTP, MCP and Admin surfaces. Your application owns the
host, storage and frontend. Four atoms describe the contract: **Schema** stores
data, **View** reads it, **Procedure** acts on it, and **Trigger** binds an action
to HTTP, MCP or lifecycle events.

This handbook describes the SDK snapshot that carries it. For an installed
project, read `node_modules/@aotter/mantle/docs/handbook/`; a website or Git
branch can describe a different version. The [release index](../releases/index.md)
links published releases. A prerelease capability is not a promise that the
current npm `latest` contains it.

## Start with your integration

| Goal | Start here | Result |
|---|---|---|
| Understand what manifests can express | [Manifest feature reference](../reference/features.md) | A capability-to-field map across the four atoms. |
| Validate manifests in an existing tool | [Spec-only adoption](../../spec-only-host-adoption.md) | Parse and link without Runtime, storage or a UI. |
| Embed Runtime in an existing host | [Runtime and adapters](../concepts/runtime-and-adapters.md), then [typed queries](../guides/typed-queries.md) | Bind your storage and call the generated API. |
| Build a local Cloudflare API | [Minimal Worker tutorial](./quickstart-worker.md) | A running public View and a verified HTTP response. |
| Add a staff console | [Local Admin tutorial](./quickstart-admin.md) | Email OTP, Admin assets and a local human workflow. |
| Build on ChatGPT Sites | [Sites integration](../chatgpt-sites/index.md) | Host-owned sign-in and deployment with Mantle content. |
| Work through a coding agent | [Skill installation and handoff](../guides/agent-setup.md) | Bootstrap skill, pinned package, then project-local instructions. |

Human authors can follow these pages directly; installing an agent skill is
optional. Do not start with `mantle generate` in an empty directory: author the
manifests and host first, then generate and validate.

## Find the right kind of documentation

- **Tutorials** walk through a running minimal service or local Admin.
- **Task guides** explain typed queries, Admin customization and agent setup.
- **Concepts** explain the four atoms, runtime, lifecycle, authorization and transports.
- **Reference** lists accepted fields, defaults, restrictions and diagnostics.
- **Host guides** cover Cloudflare and Sites wiring and operations.
- **Examples** supply complete domain manifests and runnable host references.

The [project and CLI guide](./project-and-cli.md) describes file ownership and
the verification loop. The [examples hub](../examples/hub.md) helps select a
domain model. Use the [field reference](../reference/manifest.md) when checking
exact syntax; do not infer grammar from a UI screenshot.

## Source

- [Core package](../../../packages/mantle/README.md)
- [Handbook navigation](../navigation.json)
- [Consumer skills](../../../skills/README.md)
