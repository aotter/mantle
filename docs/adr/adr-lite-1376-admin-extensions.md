# ADR-lite 1376: Admin customization

**Status:** Accepted, revision 4. Supersedes revision 3 §1–§6 entirely.
Revision 3 shipped only in the 0.2.0 alpha prereleases (alpha.6 and alpha.7),
never in a stable release. Amends [ADR-lite 909](adr-lite-909-admin-ui-kit.md).

**Implementation:** in progress. Until the removals below land, the code
implements [revision 3](https://github.com/aotter/mantle/blob/v0.2.0-alpha.7/docs/adr/adr-lite-1376-admin-extensions.md), which stays the record for the keys and APIs it
defines.

## Context

Revision 3 kept Admin a single prebuilt SPA and opened it through
runtime-loaded modules, an import map and imperative renderers. That shape:

- cannot compile application Tailwind classes;
- needs import-map integrity and CSP plumbing;
- gives extension code no typed data access;
- differs from how React admin frameworks are extended (Payload, Sanity,
  react-admin, Refine, Strapi, Keycloakify).

In those frameworks the application builds the admin, composes it in code,
overrides named components, and reads data through hooks while the server
authorizes.

## Decision

1. **The application builds Admin.** `mantle bundle` builds it with Vite
   whenever the Worker selects Admin, from `src/admin.tsx` or a built-in
   default entry, into `<assets>/admin` (`mantle bundle <entry> <outdir>
   --assets <dir>`, default `<outdir>/client`). Worker output moves to
   `<outdir>/worker`.
   - The build works under `npm ci --ignore-scripts`: native tools come from
     platform `optionalDependencies`.
   - Nothing at runtime reads `node_modules`.
   - Pipelines that already run `mantle bundle` or `wrangler deploy` need no
     extra step.
   - The same build emits the same-origin preview document into
     `<assets>/admin`, and the host bridge stays a package export, so
     ADR-lite 909's sandbox preview contract holds.
   - There is no prebuilt-SPA path.
2. **Composition.** `defineAdmin(generatedAdmin, { nav, pages, components,
   plugins })`. Resources are derived from generated metadata; pages are React
   routes.
3. **Overrides.** Every named region accepts a component that receives the
   default props plus `renderDefault(props)`. The regions are Shell, Sidebar,
   Header, Brand, Home, CollectionList, RecordView, record asides and actions,
   and per-field cells and inputs. Plugins are `defineAdmin` fragments applied
   in order as a `renderDefault` chain. Slot names and props are versioned
   with the package.
4. **Data.** Hooks (`useView`, `useEntries`, `useEntry`, `useOperation`,
   `useCollectionTotal`, `useMe`) call only caller-authorized `/admin/api`
   routes, each of which checks the caller, and share Admin's query cache.
   Generated types bind names, inputs and rows. Refusals read as unavailable.
5. **The manifest keeps data semantics,** for example
   `uiSchema.nav.{group,order,hidden,standalone,parentField}`, list columns,
   filters, search and primary fields, Procedure `collectionAction`, and
   built-in widgets. Only component references (`<extension>/<contribution>`
   widgets, `list.cells`, `panels`) are removed.
6. **Theme** is the shadcn CSS variables, overridden by application CSS.
   **Eject** is a shadcn registry of the default components, built only on the
   public props and hooks.
7. **Authorization stays on the server.** Showing, hiding or replacing UI
   grants or denies nothing. Admin code is application code: it runs in the
   Admin origin with the viewer's session and can call any route the viewer
   reaches. So:
   - the right to deploy a project is full trust in that project, and a host
     that grants narrower roles inside a project governs deployment
     separately;
   - routes reachable from a project's Admin origin act only on that project;
     anything wider lives on another origin.

**Removed:** `adminExtensions`, `--admin-extensions`, `defineAdminExtension`,
the import map and shared shims, extension server handlers and
`/x/{extension}/*` routes. Server work is a Procedure, a View, or an
application route.

**Amends ADR-lite 909.** The Admin application, its layout, the data hooks and
the default components become public library surface of
`@aotter/mantle-admin`. The prebuilt Admin SPA goes away; the complete product
is the application-built `<assets>/admin`, which includes the sandbox preview
document. The kit's contract is otherwise unchanged.

## Non-goals

- Runtime-loaded or untrusted third-party Admin code, and its isolation tier.
- A marketplace.
- A second prebuilt distribution.
- A dashboard or query engine.
- Arbitrary SQL from hooks.

## Consequences

- Applications get one React tree, their own Tailwind classes, typed data
  access, and full replacement of any region.
- Each application installs Admin's UI and build dependencies and spends a few
  seconds of build time.
- Bun hosts add `mantle bundle` to their build.
- Breaking for alpha users of:
  - `navGroups` and `adminExtensions`;
  - manifests that use `fields.<name>.widget: <extension>/<contribution>`,
    `list.cells` or `panels`, which `mantle generate` then refuses;
  - the output layout: Worker output moves to `<outdir>/worker`, so wrangler
    configs (`main`, `base_dir`, `assets.directory`) must be regenerated with
    `mantle generate`.

  A migration note ships with the removal.
