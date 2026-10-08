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
  source: ACCESS_MODULE,               // the module's code; Admin serves it at {basePath}/extensions/access.js
  // or, served by the host instead: module: '/assets/access/admin.js', integrity?: 'sha384-…'
  contributes: {
    pages:    [{ id, title, role, nav: { group: 'more' | 'settings', order? } }],
    settings: [{ id, title, role, schema }],          // JSON Schema form, no client code
    actions:  [{ id, title, role, target, presentation, destructive?, when? }],
    panels:   [{ id, title, role, target, when? }],
    fields:   [{ id, target, when?, optionsSchema? }],
  },
  handlers: {
    api?(request, { caller, extension, path }): Promise<Response | null>,
    settings?: { [id]: { load(caller), save(caller, value) } },
    actions?:  { [id]: { run(caller, { record?, selection?, schema? }) } },
  },
}
```

### 1a. Projects author extensions; hosts may add their own

Extensions are not a host-only feature. An agent customizing a project's Admin
is the main author:

- A project exports `adminExtensions: AdminExtension[]`. The generated preset
  writes `src/admin-extensions.ts` for it and passes it to
  `createAdminSurface`. A host that builds Admin itself (for example a hosted
  platform) reads the same export and appends its own extensions.
- Extension ids are one namespace per Admin. A host extension whose id
  collides with a project extension fails construction, so a project can
  never shadow a host page, and the reverse.
- A module needs no build step: Admin's import map provides React, the kit and
  the extension helper (§4), so plain ESM works. `source` lets Admin serve the
  module itself, so a project needs no static-file setup; Admin computes its
  integrity. The same project shows the same extensions locally and when
  deployed; a host only adds.

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

Contributions and their targets (§1b covers how manifests use them):

| Contribution | Targets (`/v1`) | Client code |
| --- | --- | --- |
| page | its own route `/admin/x/{extension}/{page}`; in navigation when it declares `nav` | a renderer |
| settings | its own route `/admin/x/{extension}/{id}`, always in navigation | none. Admin renders `schema` (the form subset) with its form; `load` and `save` run on the server |
| action | `record/v1` (record header), `list.selection/v1` (bulk), `list.toolbar/v1` | `presentation: 'run' \| 'confirm'` needs none (the server `run` is called). `'dialog'` mounts client code in an Admin dialog |
| panel | `record.sidebar/v1`, `home/v1` | a renderer |
| field | `field.input/v1`, `field.cell/v1` | a renderer |

`when` is a closed predicate over names only: `{ schema?: string[], field?:
string[], format?: string[] }`. It contains no expressions and no record
values, so the server can evaluate it.

`role` is the minimum staff role, the same vocabulary as `requires.auth`.

### 1b. Manifests pick contributions through `uiSchema`

There are two ways to attach a contribution. Both stay:

- **From the manifest.** `uiSchema` already chooses Admin presentation
  (`fields.<name>.widget: textarea`, `list.columns`, `collectionAction`).
  It may also name a contribution as `<extension>/<contribution>`:

  ```yaml
  # Schema products
  uiSchema:
    fields:
      color: { widget: brand-kit/color, options: { palette: brand } }
      notes: { widget: textarea }
    list:
      cells: { color: brand-kit/swatch }       # field.cell/v1
    panels: [brand-kit/usage]                  # record.sidebar/v1
  # Procedure reassign-order (uiSchema.fields.<name>.widget works the same)
  # View sales-by-region
  uiSchema:
    list: { cells: { region: maps/region-badge } }
  ```

  - The binding sits next to the field it changes. An agent writes both in
    one change, and a manifest review shows it.
  - `options` is passed to the renderer as `ctx.options`. A contribution may
    declare `optionsSchema` (the settings form subset). `options` is checked
    against it, and a contribution without one refuses `options`.
  - The target kind must match the key: `fields.*.widget` names a
    `field.input/v1` contribution, `list.cells.*` a `field.cell/v1`
    contribution, and `panels` a `record.sidebar/v1` contribution.
- **From the extension.** `when: { schema, field, format }` attaches a
  contribution everywhere it matches without touching manifests, for example
  every field with `x-mcp-hint: money-minor`. This suits host extensions and
  cross-cutting widgets.

When both apply to one place, the manifest wins.

**Validation.**
- The manifest grammar checks the shape: `<extension>/<contribution>` with
  kebab-case parts. `textarea` stays the one built-in widget.
- Whether the named contribution exists, has the right target and accepts the
  `options` is checked where the plan and the extensions meet:
  - `createAdminSurface` fails construction with `UI_EXTENSION_UNKNOWN`,
    `UI_EXTENSION_TARGET` or `UI_EXTENSION_OPTIONS`.
  - `checkPlanUiExtensions(plan, extensions)` is exported, so a deploy step or
    a test can run the same check before the service starts.

**Who may be named.** A manifest may name only the project's own extensions,
never a host's. A project then renders the same locally and when deployed. A
host attaches its contributions with `when` instead.

**Effect.** `uiSchema` stays presentation only. It never changes validation,
MCP schemas or authorization. The field's JSON Schema still validates what a
widget sends.

### 2. The server decides what a caller sees, and checks again on use

- `GET /admin/api/site` (and bootstrap's `site`) returns the contributions
  the caller's role reaches, with their declarations only. Handlers and
  `integrity` are not sent.
- Every extension route checks a signed-in staff session and the
  contribution's role before it calls the host:
  - `{basePath}/api/x/{extension}/settings/{id}`: `GET` → `load`, `PATCH { value }` → `save`
  - `{basePath}/api/x/{extension}/actions/{id}`: `POST` → `run`, with `{ record }`, `{ selection }` or `{ schema }` for the action's target; `when.schema` is enforced here too
  - `{basePath}/api/x/{extension}/api/{path}` → `api`, for the extension's lowest contribution role
  - `GET {basePath}/extensions/{id}.js` → a `source` extension's module, for the same role
- `save` input is validated against `schema` before the host sees it (400 with
  `error.fields` otherwise).
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
  fields:  { 'color': (element, ctx) => ({ update(next) {}, unmount() {} }) },
})
```

A renderer returns nothing, a cleanup, or `{ update, unmount }`. With `update`,
Admin passes later contexts (a new value, a new language) in place instead of
mounting again; a field value the renderer reported itself never remounts it.

- Admin imports `module` once, when a contribution that needs it is first
  shown, and calls the renderer for that contribution.
- A renderer for an undeclared contribution is ignored. A declared
  contribution without a renderer shows an error in its place.
- The context is serializable and typed per target. It holds `{ extension,
  contribution, apiBase, language, theme, caller: { role } }` plus:
  - `record: { schema, id, version }` for record targets
  - `selection: { schema, ids }` for list targets
  - `field: { schema, name, value, readOnly, property }` for field targets,
    and `options` from `uiSchema`; `field.input/v1` also gets `onChange(value)`
- A small `host` object offers `navigate(path)`, `notify(message)` and
  `close()` for dialogs.
- Nothing else from the SPA is reachable.

### 4. Shared dependencies come from Admin

- Admin's HTML declares an import map for `react`, `react/jsx-runtime`,
  `react-dom`, `react-dom/client`, `@aotter/mantle-ui/kit` and
  `@aotter/mantle-ui/extension`, served beside the shell. The React entries
  re-export Admin's own instance; the kit and the helper are real modules
  that import React through the same map, and the kit's stylesheet loads with
  the first extension.
- Extension modules use these specifiers directly (or mark them external when
  bundling). They share Admin's single React and keep its look, theme and
  accessibility.
- The kit and the extension helper are the whole public UI surface. The shell
  stays private (ADR-lite 909).

### 5. Trust tier

- Extensions are trusted host code. They run in Admin's origin with Admin's
  privileges, and Core does not sandbox them.
- `module` must be a same-origin path, so Admin keeps its existing CSP and
  framing policy.
- `integrity` (given for `module`, computed for `source`) goes into the
  shell's import map, so the browser enforces it on import.
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
  - a non-same-origin `module`, or both `module` and `source`
  - a contribution that needs code when there is neither
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
  declaration that tooling validates and diffs before deploy. A `uiSchema`
  line in the manifest binds it to a field, a list cell or a record panel.
- The `uiSchema` vocabulary widens: `fields.<name>.widget` accepts
  `<extension>/<contribution>` beside `textarea`, with `options`; Schemas gain
  `list.cells` and `panels`; staff Views gain `list.cells`. This record is the
  grammar decision CONTRIBUTING requires for new keys: the name's shape is
  closed and checked at generate time (`SCHEMA_UI_INVALID`,
  `VIEW_UI_INVALID`), and its existence at construction
  (`UI_EXTENSION_UNKNOWN`, `UI_EXTENSION_TARGET`, `UI_EXTENSION_OPTIONS`).
- Settings pages need no client code at all. This covers most host
  configuration screens and is the easiest kind for an agent to author and
  review.
- Admin takes on an import map and the `@aotter/mantle-ui/extension` entry.
- The first draft's `extensions: { pages, api }` is replaced before any
  release; it was never published.
