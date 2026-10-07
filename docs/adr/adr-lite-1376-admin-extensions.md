# ADR-lite 1376: Admin extensions

**Status:** Proposed (revision 3: the full contract, for hosts and for
projects; replaces the pages-only draft)

## Context

A project or the host that mounts Admin sometimes needs its own UI next to the generated
collections, Views and operations. Examples are an operator's
access-management screen, a record action that calls a host service, or a
field widget for a host-specific format. Today the Admin SPA has no way to add
any of these:

- Its routes and navigation are fixed.
- `createAdminSurface` has no host routes.
- The UI kit (ADR-lite 909) deliberately does not export the application
  shell.

Hosts are left with forking the SPA or patching its private DOM.

The first draft of this record added whole pages only. A survey of how other
products open their admin turns up the same set of extension points in
almost all of them. The CMS products were Strapi, Directus, Payload, Sanity,
Contentful, Keystone, Decap, Tina and WordPress. The platforms were Shopify
Admin UI extensions, VS Code, Grafana, Backstage, Atlassian Forge, Figma and
the Keycloak admin console. The recurring points are:

- pages with a navigation entry
- record and list actions
- record side panels
- field widgets
- dashboard widgets
- settings pages
- server endpoints

The survey also turns up five lessons that bear on this design:

1. **Only a narrow, typed surface survives major versions.** Every product
   that exposed its internal context or helper packages broke all its plugins
   at the next major: Strapi's helper-plugin, Sanity's Parts, Payload 2→3,
   Decap's React pin. Contentful's location-scoped SDK and Backstage's typed
   data refs aged well.
2. **Declare in data, run in code.** The extension says *what* attaches
   *where* as data. Code supplies only the behavior. Grafana had to retrofit a
   static mirror of its imperative `addLink` calls before it could index,
   validate or lazy-load extensions. Declarations can also be validated and
   diffed before anything runs. That matters here because agents author and
   deploy Mantle projects.
3. **Typed contribution points beat free-form injection zones.** Strapi 5 and
   Sanity steer integrators to typed actions with a position and a dialog
   kind. Strapi now marks its free zones internal.
4. **Navigation visibility is not authorization.** Strapi, Payload and
   Directus all warn about this. Every extension route has to check the
   caller on the server.
5. **Same-origin code has no security boundary.** That is acceptable for code
   the host installs and trusts. Untrusted third-party code needs an iframe
   (Contentful, Forge Custom UI) or remote rendering (Shopify). The contract
   should allow such an isolation tier later without changing.

## Decision

### 1. One declaration per extension, from the project or the host

`createAdminSurface` accepts `extensions: AdminExtension[]`. Each extension
pairs a declaration, which is plain data, with server handlers, which are
code:

```ts
{
  apiVersion: 1,
  id: 'access',                        // kebab-case, unique, immutable once deployed
  title: { en: 'Access', 'zh-TW': '存取權限' },
  module: '/assets/access/admin.js',   // same-origin ESM; required only if a contribution needs client code
  integrity: 'sha384-…',               // optional Subresource Integrity for module
  contributes: {
    pages:    [{ id, title, role, nav: { group: 'more' | 'settings', order? } }],
    settings: [{ id, title, role, schema }],          // JSON Schema form, no client code
    actions:  [{ id, title, role, target, presentation, destructive?, when? }],
    panels:   [{ id, title, role, target, when? }],
    fields:   [{ id, target, when }],
  },
  handlers: {
    api?(request, { caller, extension, path }): Promise<Response | null>,
    settings?: { [id]: { load(caller), save(caller, value) } },
    actions?:  { [id]: { run(caller, { record?, selection? }) } },
  },
}
```

### 1a. Projects author extensions; hosts may add their own

Extensions are not a host-only feature. An agent customizing a project's Admin
is the main author:

- A project's service module may export `adminExtensions: AdminExtension[]`
  next to its other service exports. The generated preset passes them to
  `createAdminSurface`. A host that builds Admin itself (for example a hosted
  platform) reads the same export and appends its own extensions.
- Extension ids are one namespace per Admin. A host extension whose id
  collides with a project extension fails construction, so a project can
  never shadow a host page, and the reverse.
- `mantle verify` validates a project's declarations against the exported
  JSON Schema, and `mantle build` bundles each `module` with the import map's
  packages kept external (§4). The same project shows the same extensions
  locally and when deployed; a host only adds.

**Trust.** A project extension's module runs in Admin's origin with the
viewer's session. That gives it no more power than the project already has:
whoever can deploy the project already controls its server code, its
handlers and its storage. Two rules keep that equivalence true:

- Host extension routes reachable from a project's Admin origin must act only
  on that project. Anything wider (an organization console, other projects)
  lives on a different origin, so a project module never holds its session.
- A host that restricts what some staff may do inside a project (fine-grained
  policies) must treat the right to deploy as full trust in that project, and
  govern deployment separately.

Contributions and their targets:

| Contribution | Targets (`/v1`) | Client code |
| --- | --- | --- |
| page | its own route `/admin/x/{extension}/{page}` | `mount` |
| settings | its own route under Settings | none. Admin renders `schema` with the kit form; `load` and `save` run on the server |
| action | `record/v1` (record header), `list.selection/v1` (bulk), `list.toolbar/v1` | `presentation: 'run' \| 'confirm'` needs none (the server `run` is called). `'dialog'` mounts client code in an Admin dialog |
| panel | `record.sidebar/v1`, `home/v1` | `mount` |
| field | `field.input/v1`, `field.cell/v1` | `mount` |

`when` is a closed predicate over names only: `{ schema?: string[], field?:
string[], format?: string[] }`. It contains no expressions and no record
values, so the server can evaluate it.

`role` is the minimum staff role, the same vocabulary as `requires.auth`.

### 2. The server decides what a caller sees, and checks again on use

- `GET /admin/api/site` (and bootstrap's `site`) returns the contributions
  the caller's role reaches, with their declarations only. Handlers and
  `integrity` are not sent.
- Every extension route checks a signed-in staff session and the
  contribution's role before it calls the host:
  - `{basePath}/api/x/{extension}/{path}` → `api`
  - `…/settings/{id}` → `load` and `save`
  - `…/actions/{id}` → `run`
- `save` input is validated against `schema` before the host sees it.
- `null` answers 404. Answers are `no-store` unless the host sets
  `cache-control`. Cross-site mutation protection is the `withCaller`
  wrapper's, as for every Admin route.
- The checks above are the minimum. Finer authorization is the host's, inside
  its handlers.

### 3. Client modules supply renderers keyed by contribution id

```ts
import { defineAdminExtension } from '@aotter/mantle-ui/extension'

export default defineAdminExtension({
  pages:   { overview: (element, ctx) => cleanup },
  actions: { 'reassign': (element, ctx) => cleanup },   // dialog presentation only
  panels:  { 'history': (element, ctx) => cleanup },
  fields:  { 'color': (element, ctx) => cleanup },
})
```

- Admin imports `module` once, when a contribution that needs it is first
  shown, and calls the renderer for that contribution.
- A renderer for an undeclared contribution is ignored. A declared
  contribution without a renderer shows an error in its place.
- The context is serializable and typed per target. It holds `{ extension,
  contribution, apiBase, language, theme, caller: { role } }` plus:
  - `record: { schema, id, version }` for record targets
  - `selection: { schema, ids }` for list targets
  - `field: { schema, name, value, readOnly }` for field targets, which also
    get `onChange(value)`
- A small `host` object offers `navigate(path)`, `notify(message)` and
  `close()` for dialogs.
- Nothing else from the SPA is reachable.

### 4. Shared dependencies come from Admin

- Admin's HTML declares an import map for `react`, `react-dom`,
  `@aotter/mantle-ui/kit` and `@aotter/mantle-ui/extension`, all served from
  Admin's own assets.
- Extension modules mark these as external. They share Admin's single React
  and kit instance and keep its look, theme and accessibility.
- The kit and the extension helper are the whole public UI surface. The shell
  stays private (ADR-lite 909).

### 5. Trust tier

- Extensions are trusted host code. They run in Admin's origin with Admin's
  privileges, and Core does not sandbox them.
- `module` must be a same-origin path, so Admin keeps its existing CSP and
  framing policy.
- `integrity`, when given, is enforced on import.
- An isolated tier for untrusted extensions is reserved and is not part of
  this decision. Because contexts are serializable and the UI surface is the
  kit, an iframe or remote-rendering tier can reuse this declaration format
  unchanged.

### 6. Stability and tooling

- `apiVersion` and the `/v1` target names version the contract. Within a
  version, changes are additive only. A breaking change adds `/v2`, and both
  run side by side through a deprecation window.
- Construction validates every declaration and fails on:
  - a bad or duplicate id
  - an unknown target or `apiVersion`
  - a non-same-origin `module`
  - a contribution that needs code when `module` is missing
  - a settings `schema` outside the form subset
- Core exports the declaration's JSON Schema, so tooling and agents can check
  a declaration without running it.
- Core also exports `diffAdminExtensions(previous, next)`. It reports added
  and removed contributions, role changes and module changes, for review
  screens.

## Non-goals

- Replacing the shell, navigation component or layout.
- Free-form injection into arbitrary DOM.
- A marketplace or untrusted third-party extensions (reserved tier, above).
- Server-side sandboxing of handlers. They are host code in the host's
  process.
- Declaring extensions in the YAML manifest. They live in the project's
  service module (TypeScript), so the four-atom grammar does not change.

## Consequences

- Projects and hosts add pages, settings, actions, panels and field widgets
  without forking the SPA, and the SPA stays one build. Without
  `extensions`, nothing changes.
- An agent can customize a project's Admin with a small module and a
  declaration that tooling validates and diffs before deploy.
- Settings pages need no client code at all. This covers most host
  configuration screens and is the easiest kind for an agent to author and
  review.
- Admin takes on an import map and the `@aotter/mantle-ui/extension` entry.
- The first draft's `extensions: { pages, api }` is replaced before any
  release; it was never published.
