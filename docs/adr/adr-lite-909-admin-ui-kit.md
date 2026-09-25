# ADR-lite 909: Mantle Admin UI kit export

**Status:** Accepted; amended by [ADR-0029](0029-mcp-apps-interaction-contracts.md) (the kit moves to `@aotter/mantle-ui`, with a one-minor re-export from `@aotter/mantle-admin-ui/kit`)

## Context

Mantle applications need the Admin product's React/shadcn visual language
without copying components or embedding the full Admin SPA. The Admin package
previously exposed only static product assets and a server-side token string.
Its same-origin `preview.html` contract remains the correct boundary for a
complete embedded Admin or Developer UI.

## Decision

`@aotter/mantle-admin-ui/kit` exports the existing domain-neutral shadcn
primitives and Mantle one-time-code input. `kit.css` contains their compiled
Tailwind styles and complete Admin theme; `tokens.css` contains only the stable
Mantle design variables.

The kit does not export the Admin application, authenticated layout, router,
queries, API client, or feature views. Those modules assume Admin routes and
transport contracts and remain private. Consumers needing the complete product
use the canonical Admin assets or the explicit same-origin sandbox preview.

Copy-owned shadcn recipes may compose the public kit into working defaults.
They are installed as source in the consuming application rather than exposed
as another runtime framework. The first recipe is an email OTP page with
optional legal links.

## Consequences

- Applications can share Mantle controls and visual tokens without depending
  on Builder internals or duplicating Admin CSS.
- The static Admin SPA remains unchanged and optional.
- New public kit components require package-level contract and rendering tests.
- Authentication and legal-consent policy remain application concerns, not UI
  primitive behavior.
