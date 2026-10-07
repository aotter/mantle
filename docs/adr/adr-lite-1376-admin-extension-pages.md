# ADR-lite 1376: Host extension pages in Admin

**Status:** Proposed

## Context

A host that mounts Admin sometimes needs a console page of its own (for
example, an operator's access-management screen) next to the generated
collections, Views and operations. The Admin SPA had no way to add one: its
routes and navigation are fixed, `createAdminSurface` has no host routes, and
the UI kit (ADR-lite 909) deliberately does not export the application shell.
Hosts were left with forking the SPA or patching its private DOM.

## Decision

`createAdminSurface` accepts `extensions: { pages, api? }`.

- A page is `{ id, title, role, module }`. `id` is unique kebab-case, `role` is
  the minimum staff role, and `module` is a same-origin absolute path; any other
  value fails construction.
- `GET /admin/api/site` (and bootstrap's `site`) returns `extensions`: the
  pages the caller's role reaches. The SPA lists them under More and renders
  `/admin/x/{id}` by importing `module` and calling its `mount(element,
  { id, apiBase, language, theme })`, which may return a cleanup.
- `{basePath}/api/x/{id}/{path}` calls `api(request, { caller, page, path })`
  after Admin's own checks (a signed-in staff session, the page's role).
  `null` answers 404. Answers are `no-store` unless the host sets
  `cache-control`. Cross-site mutation protection is the `withCaller` wrapper's,
  as for every Admin route.

The module is the host's own code and runs in Admin's origin with Admin's
privileges; Core does not sandbox it. Same-origin is required so the Admin
shell keeps its existing content-security and framing policy.

## Consequences

- Hosts add pages and their APIs without forking the SPA; the SPA stays one
  build. Without `extensions`, nothing changes.
- A page's UI builds on `@aotter/mantle-ui/kit` and `kit.css` for the Admin
  look; it receives no private SPA modules.
- Page authorization beyond the minimum role is the host's, in `api`.
