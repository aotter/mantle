# ADR-lite 1376: Admin customization

**Status:** Accepted, revision 4. Supersedes revision 3 §1–§6 entirely.
Revision 3 shipped only in the 0.2.0 alpha prereleases (alpha.6 and alpha.7),
never in a stable release; its text remains in git history. Amends
[ADR-lite 909](adr-lite-909-admin-ui-kit.md).

**Implementation:** in progress. Until the removal lands, the code still
implements revision 3: `adminExtensions`, `--admin-extensions`,
`defineAdminExtension`, the import map, the `/x/{extension}/*` routes, and the
`uiSchema` keys that name contributions (`fields.<name>.widget:
<extension>/<contribution>`, `list.cells`, `panels`). Revision 3 remains the
grammar record for those keys until they are removed.

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
   default entry, into `<assets>/admin` (`--assets`, default `dist/client`).
   Worker output moves to `dist/worker`.
   - The build works under `npm ci --ignore-scripts`: native tools come from
     platform `optionalDependencies`.
   - Nothing at runtime reads `node_modules`.
   - Pipelines that already run `mantle bundle` or `wrangler deploy` need no
     extra step.
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
   `useCollectionTotal`, `useMe`) call only the existing caller-authorized
   `/admin/api` routes and share Admin's query cache. Generated types bind
   names, inputs and rows. Refusals read as unavailable.
5. **The manifest keeps data semantics only:**
   `uiSchema.nav.{group,order,hidden,standalone,parentField}`, list columns
   and filters, and built-in widgets. Component references
   (`<extension>/<contribution>` widgets, `list.cells`, `panels`) are removed.
6. **Theme** is the shadcn CSS variables, overridden by application CSS.
   **Eject** is a shadcn registry of the default components, built only on the
   public props and hooks.
7. **Authorization stays on the server.** Showing, hiding or replacing UI
   grants or denies nothing.

**Removed:** `adminExtensions`, `--admin-extensions`, `defineAdminExtension`,
the import map and shared shims, extension server handlers and
`/x/{extension}/*` routes. Server work is a Procedure, a View, or an
application route.

**Amends ADR-lite 909.** The Admin application, its layout, the data hooks and
the default components become public library surface of
`@aotter/mantle-admin`, and the prebuilt Admin SPA goes away. The kit's
contract is otherwise unchanged.

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
- Breaking for alpha users of `navGroups` and `adminExtensions`. A migration
  note ships with the removal.
