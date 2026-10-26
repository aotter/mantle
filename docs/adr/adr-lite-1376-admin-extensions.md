# ADR-lite 1376: Admin customization

**Status:** Accepted, revision 4. Supersedes revision 3 entirely.
Revision 3 shipped only in the 0.2.0 alpha prereleases (alpha.6 and alpha.7),
never in a stable release. Amends [ADR-lite 909](adr-lite-909-admin-ui-kit.md) and
[ADR-0029](0029-mcp-apps-interaction-contracts.md).

**Implementation:** in progress. Until the removals below land,
[revision 3](https://github.com/aotter/mantle/blob/v0.2.0-alpha.7/docs/adr/adr-lite-1376-admin-extensions.md)
describes the code.

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
   from `src/admin.tsx` or a built-in default entry into `<assets>/admin`
   (`mantle bundle <entry> <outdir> --assets <dir>`, default
   `<outdir>/client`). On Workers it does so when the Worker bundle imports
   `@aotter/mantle-admin/server`, and Worker output moves to
   `<outdir>/worker`; the assets directory must not overlap the Worker
   directory. On Bun, which runs the server as TypeScript, the generate
   target recorded in `.mantle-inputs.json` makes `mantle bundle` build only
   Admin.
   - The build works under `npm ci --ignore-scripts`: native tools come from
     platform `optionalDependencies`.
   - Admin assets are never read from `node_modules` at runtime.
   - Pipelines that already run `mantle bundle` or `wrangler deploy` need no
     extra step.
   - The same build emits the same-origin preview document and
     `host-bridge.js` into `<assets>/admin`, so ADR-lite 909's sandbox
     preview contract holds.
   - There is no prebuilt-SPA path.
2. **Composition.** `defineAdmin(generatedAdmin, { nav, pages, components,
   plugins })`; pages are React routes. `pages[].header` composes localized description and
   React actions beside the native page title on both surfaces when explicitly
   supplied; `false` delegates the heading to the page element (#1711). The Admin bundle is public static
   content: generated code contributes types and only the names the
   application's own code references, never Procedure statements, guards,
   audiences, authorization predicates or full lists of Views and
   Procedures. Resources, and what each caller sees, come at runtime from
   caller-filtered `/admin/api` metadata.
3. **Overrides.** Every named region accepts a component that receives the
   default props plus `renderDefault(props)`. The regions are Shell, Sidebar,
   Header, Brand, Home, CollectionList, RecordView, record asides, record
   and list (bulk) actions, per-field and per-View-column cells, and
   per-field inputs. Plugins are `defineAdmin` fragments applied
   in order as a `renderDefault` chain. Slot names and props are versioned
   with the package.
4. **Data.** Hooks (`useView`, `useEntries`, `useEntry`, `useOperation`,
   `useCollectionTotal`, `useMe`, `useBadges`) call only caller-authorized
   `/admin/api` routes in the browser (decision 8 covers MCP hosts), each of
   which checks the caller, and share Admin's query cache. Generated types bind
   names, inputs and rows. Refusals read as unavailable.
   - **Schema locks (#1822).** When a Schema declares `spec.lock`, each entry
     the editor and list routes return (`useEntry`, `useEntries`) carries
     `locks: { update, delete }`: per verb, `{ lock, message }` of the first
     lock that holds for the caller's generic write of that row, read by the
     same `when` (NULL holds) in the read's projection, or `false`. A trusted
     caller reads both as `false`. An entry has no `locks` field when the
     Schema has no locks or the read did not evaluate them (related entries
     and reference titles). It is advisory: the write's own WHERE
     decides, and a refusal is `CONFLICT` `kind: "lock"`. Default components
     disable Save, rename, Delete and transitions and show the message; the
     operational unlock toggle never overrides it.
5. **The manifest keeps data semantics;** only component references
   (`<extension>/<contribution>` widgets, `list.cells`, `panels`) are
   removed.
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
8. **MCP Apps.** By default the Admin MCP App is one View's rows plus Procedure row
   actions; the full Admin (shell,
   sidebar, router) does not run inside an MCP host.
   - `mantle bundle` builds it from the same entry by default (an optional
     `src/admin.mcp.tsx` isolates browser-only imports, #1712), as a single-file
     `<assets>/admin/mcp-app.html`, served as `ui://mantle-admin/admin/<digest>`
     by default (#1705): the Admin contributor hashes its HTML, catalogue and
     resource metadata; Core validates and serves the resulting links without
     owning a UI build. An explicit custom URI is an immutable build identity.
     The file holds no catalog; the server embeds it when the resource is
     read, limited to the tools that caller can list. Served over HTTP, the
     file keeps Admin's anti-framing headers.
   - Each slot reflects its mounted surface. View cells are `both`. Collection
     cells, record inputs, record actions, record views and record asides are
     browser-only (#1710); fullscreen does not introduce record CRUD. A
     Procedure action input is not a collection record input. Shell, Sidebar,
     Header, Brand, Home, CollectionList, list (bulk) actions, pages and
     navigation are `browser`.
   - A custom page may opt in with `pages[].mcp: { renders: <view> }`. It is
     then type-checked like a `both` slot and served as its own App.
   - In a host, `both` slots read and write through MCP tool calls to the
     View and Procedure tools rather than `/admin/api`, open links through
     the host, and take the host's neutral colours and fonts while the
     application keeps its brand colours. Hooks without a matching tool read
     as unavailable; no tools are added for the App.
   - The build fails any App output that calls `/admin/api`, reads
     `document.cookie` or loads an undeclared origin, and `mantle generate`
     emits a compatibility test that loads the App in the official
     `AppBridge` for every overridden `both` slot and every `pages[].mcp`
     page.

**Removed:** `adminExtensions`, `--admin-extensions`, `defineAdminExtension`,
the import map and shared shims, extension server handlers and
`/x/{extension}/*` routes. Server work is a Procedure, a View, or an
application route.

**Amends ADR-lite 909.** The Admin application, its layout, the data hooks and
the default components become public library surface of
`@aotter/mantle-admin`. The prebuilt Admin SPA goes away; the complete product
is the application-built `<assets>/admin`, which includes the sandbox preview
document and its host bridge. The kit's contract is otherwise unchanged.

## Non-goals

- Runtime-loaded or untrusted third-party Admin code, and its isolation tier.
- A marketplace.
- A second prebuilt distribution.
- A dashboard or query engine.
- Arbitrary SQL from hooks.
- MCP tools added only for the App.

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
    `mantle generate`, or edited by hand for `wrangler.toml`, where it only
    prints the keys;
  - the prebuilt App (`mantleAppHtml` from `@aotter/mantle-admin/mcp-app`),
    which the application-built `mcp-app.html` replaces.

  A migration note ships with the removal.
