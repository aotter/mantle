# @aotter/mantle-cloudflare

Cloudflare Workers adapter for mantle.

This package mounts the runtime on Hono, implements the runtime ports against
Cloudflare D1 / KV / Workers assets, and owns Better Auth wiring for GitHub
OAuth plus MCP OAuth/DCR.

`0.0.7-alpha` is an early prerelease for the agent-provisioning proof. The API
surface remains in flux until `v0.1.0`.

## Optional R2 Media Uploads

R2-backed staff media uploads are adapter-specific post-launch work, not part
of the Core SDK skill contract or Day 1 landing path. Use the Cloudflare recipe
only when a site actually needs staff-managed images or files:

<https://raw.githubusercontent.com/aotter/mantle/develop/docs/media-uploads.md>
