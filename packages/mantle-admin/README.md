# @aotter/mantle-admin

The complete Mantle Admin product: the Admin app library and its build,
same-origin iframe preview and Admin MCP App. It uses the public `@aotter/mantle-ui` kit
and declares `@aotter/mantle` as a peer. The SDK never imports this package.

## Package migration

These exports moved from `@aotter/mantle-ui` without compatibility aliases:

| Former UI subpath | New Admin subpath |
| --- | --- |
| `/admin-preview` | `@aotter/mantle-admin/admin-preview` |
| `/mcp-app` | none: `@aotter/mantle-admin/mcp-app` (the prebuilt `mantleAppHtml`) is gone too; the application builds the App (see MCP App) |

The package ships no prebuilt SPA or MCP App: `admin/index.html`, `admin/preview.html`,
`admin/mcp-app.html` and `admin/host-bridge.js` are not exports. The application builds them (see Static
assets); the same-origin preview document and its bridge are written beside
`index.html`. An app that copied them from `node_modules` serves `<assets>/admin`
instead (breaking).

Admin-specific catalogue and tool-result adapters moved from the UI root to
`@aotter/mantle-admin/controller`. The generic interaction controller remains
at `@aotter/mantle-ui/controller`.

### MCP contributor migration

`adminMcpApps({ catalogue })` now returns an async `McpAppsSource` so Admin can
resolve its build-specific resource URI after the caller gates. Passing it directly
into `mcpHandler({ apps: { admin: … } })` is unchanged. Code that inspected
`.resources` on the default contributor must instead resolve the source with its
request/environment, or declare an explicit immutable `uri` for a static contributor.
A custom `html` function now requires that explicit build-specific `uri`; update it
when the served UI changes. Raw HTML strings may use automatic identity.

## Static assets

`mantle bundle` builds Admin for the application into `<assets>/admin` (default
`dist/client/admin`) whenever the Worker or Bun server imports `@aotter/mantle-admin/server`
(for a `bun-*` generate target it builds only Admin, since Bun runs the server as TypeScript),
through `buildAdmin({ entry, outDir })` from `@aotter/mantle-admin/build` (not a
CLI). The entry is `admin.tsx` beside the Worker entry, default-exporting
`defineAdmin(...)`, or the built-in entry. Vite, Tailwind and Admin's UI
packages are dependencies of this package, so the application adds none of them. React is not: the
application installs `react` and `react-dom` at one identical exact version, and `mantle bundle` refuses a
mismatch; the
build needs no install scripts (`npm ci --ignore-scripts` works). A `package-lock.json` made on one OS can lack the native build binaries (rolldown, `@tailwindcss/oxide`, lightningcss) that npm installs per platform from `optionalDependencies`, so a lockfile made on macOS can fail the build on a Linux host; create the lockfile on the build platform or use pnpm.
The build writes the shell, the preview
document, `host-bridge.js` and hashed assets. Serving the built directory needs no `node_modules`; producing it does, and
`wrangler dev` and `wrangler deploy` run the generated `build.command` (`mantle bundle`), so deploy before a pipeline removes `node_modules`.

Serve that directory through an app-owned asset binding or reader at `/admin/`;
`adminShell`'s `assets(path)` receives paths relative to it. Bun hosts read it
with `bunAdminAssets("dist/client/admin")` from `@aotter/mantle/bun/assets`; it takes a path with a leading slash and
returns `null` when missing, so give `adminShell` the adapter
`async path => (await assets("/" + path)) ?? new Response(null, { status: 404 })`. Missing assets stay missing;
the API does not read the filesystem or own a platform asset preset. Static SPA
files stay outside the Worker query bundle. Route an authenticated API request
to the Admin server with the app's already-resolved caller and generated Store,
View, Procedure and input-validation descriptors.

The generated `admin-bindings.ts` is application code. Mount its descriptors with
`admin` from `@aotter/mantle-admin/server` and collection routes from
`@aotter/mantle-admin/server/entries`:

```ts
const bindings = adminBindings({ handlers });
const api = admin(bindings.metadata, bindings.views, bindings.operations, {
  db: env => env.DB,
  caller: (request, env) => resolveCaller(request, authFor(env)),
  handlers,
  routes: entries(bindings.schemas, bindings.adapter),
});
```

Use `adminBindings()` when no ref handlers are declared. Select additional
site/media/identity routes with `/server/site`; Admin's resolver accepts only a
fresh admin cookie session. The API router handles `/admin/api` and returns
`undefined` for other paths, so the application must serve the SPA shell for
`/admin` and client routes, including `/admin/sign-in`, after mounting auth.
Keep missing `/admin/assets/*` as 404 responses. The built shell has no inline
script to authorize. The API cannot serve or rewrite assets.

All 22 languages are retained. English is the fallback in the entry; the saved
language loads before rendering, and switching waits for its language chunk.
Rich-text editors and the complete developer workspace load on demand.

## App library

`@aotter/mantle-admin/app` exports `defineAdmin(meta, { nav, pages, home, components, plugins, mcp })`, `<AdminLink>` and `<MantleAdmin admin>`.
An Admin entry default-exports `defineAdmin(...)`; `<MantleAdmin>` is the root
for an app that mounts Admin inside its own providers, and it renders once the
stored or browser language has loaded. The built-in entry is `defineAdmin({})`:
with no generated metadata, Admin reads its collections, Views and operations
from `/admin/api` at runtime. The application builds that entry when it has no `admin.tsx`.
`components` replace or wrap named regions of Admin (`Shell`, `Sidebar`, `Home`, `cell:<schema>.<field>`, `input:<schema>.<field>`, ...)
through `renderDefault`, and `plugins` compose such fragments; see the Native Admin guide, "Customising Admin".
`pages` adds pages of the application's own at `/admin/p/<path>`; `home` sets where `/admin` leads (a collection, an admin View or one of `pages`).
`nav` declares the sidebar groups the manifest uses (`ManifestNavGroup` in `generated/admin-client.ts`, checked by `tsc`) and adds `items` that lead to a collection, preset to a field's value, or to a View; see "Sidebar" in the same guide.
`@aotter/mantle-admin/build` also exports the optional `adminVitePlugin()` for hot reload in a Vite dev server.

`dist/registry/*.json` is a shadcn registry of starting-point components for these slots; `npx shadcn@4 add ./node_modules/@aotter/mantle-admin/dist/registry/admin-cell.json` copies one into the app's `src/admin/` to own (see "Eject a component" in the Admin UI guide).

`@aotter/mantle-admin/hooks` exports the data hooks (`useView`, `useOperation`, `useEntries`, `useEntry`,
`useCollectionTotal`, `useMe`, `useBadges`, `useHost`, `useAdminSurface`, `useOpenLink`) and `createAdminHooks<Types>()`, which `mantle generate --admin` calls
in `generated/admin-client.ts` to bind them to the application's View, collection and operation types. They call only the
caller-authorized `/admin/api` routes (or, in an MCP host, the admin MCP tools through `mcpAppTransport`), read a 403 and a 404
as `unavailable`, and share Admin's query cache. Browser only: the Worker's startup graph refuses them.

## Preview

Use `adminPreviewDocument` and `readAdminPreviewRequest` from `/admin-preview`
with the preview document and host bridge `buildAdmin` writes into the assets
directory. The immediate parent must
be same-origin. Validate the protocol-1 request envelope, bind the bridge to
one source revision, and authorize every runtime request. Unknown paths never
fall through to authentication or another origin. The canonical Admin document
continues to refuse framing.

A design preview displays generated developer metadata; it grants no role,
database access or authentication capability. The ER and business-flow
workspace remains part of the product.

## MCP App

For compatible deployments, `adminMcpApps({ catalogue, previous })` retains
application-owned `AdminMcpSnapshot` pages at their original URIs, with the current
caller's catalogue filtering and no current renderer ownership. Commit snapshots
or keep them in durable artifact storage before the next clean build. Follow the
installed Core handbook's MCP Apps retained-page/deployed-host recipe; old executable
HTML and CSP must remain versioned together. Host reconnect/cache clearing is not
an upgrade acceptance step.

For browser-only integrations, an optional `src/admin.mcp.tsx` selects a separate host-safe entry graph; `mantle bundle` discovers it beside `admin.tsx` (beside the Worker entry). With the build API, pass `buildAdmin({ entry, mcpEntry, outDir })`. Both entries use the existing `defineAdmin` API and can import one shared config/components/CSS module; the MCP entry must not import the browser entry or browser-only integrations. Without it, authoring and the whole-entry guard are unchanged. See [separate entry example](../../docs/handbook/guides/mcp-apps.md#isolate-browser-only-integrations).

`buildAdmin` (so `mantle bundle`) also builds the App from the same Admin entry by default, into the
single file `<assets>/admin/mcp-app.html`: your `defineAdmin` components, plugins, CSS, Tailwind classes and `pages`
that declare `mcp` are in it, and the build refuses an App that reads `/admin/api` or `document.cookie` or loads a
remote origin that `defineAdmin({ mcp: { csp } })` does not declare. `adminMcpApps({ catalogue: mcpAppCatalogues.admin })` (imported from the generated `generated/admin-descriptors.ts`) registers it
through the SDK's generic MCP Apps hook and, without `html`, reads that file (`env.ASSETS` on a Worker,
`dist/client/admin/mcp-app.html` on Bun, or `file`). Tools retain the same caller
permissions as ordinary MCP calls; the document holds no credentials. Reserve
`ui://mantle-admin/` resources for this contributor. The catalogue it embeds is
cut to the reading caller's tools, the `csp` declared in `defineAdmin` (carried in the file) and `domain` pass
through to `_meta.ui`. What the App asks of a host is in the
[MCP Apps guide](../../docs/handbook/guides/mcp-apps.md#the-admin-app-in-a-host); what an application's
components must do to render there, and how it upgrades from the prebuilt App, in
[Customising Admin for MCP hosts](../../docs/handbook/guides/mcp-apps.md#customising-admin-for-mcp-hosts).

Without an explicit `uri`, this is a request-time contributor: after the endpoint's
origin/identity gates, it derives `ui://mantle-admin/admin/<digest>` from the built
HTML, full static catalogue and resource metadata. Workers retain only the raw
immutable asset/identity per ASSETS binding; catalogue filtering happens per read.
Bun rereads the file so a new build changes the URI in the same process. A custom
`html` function must supply a build-specific `uri`. Use `renders: ['view_tool']`
to partition Views when registering another renderer; competing claims fail.

The App uses the pinned official ext-apps `App` and `PostMessageTransport` for initialization, notifications, host requests,
progress and cancellation. Admin adapts advertised host capabilities to its existing hooks. A separate browser guard pins the
parent origin after the official handshake and narrows subsequent message delivery to that origin (opaque origins require
`*`); protocol parsing stays in the official client. Closing the App rejects pending calls without retrying uncertain writes.

`@aotter/mantle-admin/testing` exports `checkMcpApp({ catalogue, html })`, the compatibility test `mantle generate --admin` writes as
`generated/admin-mcp-app.check.mjs`: it loads the built App in the official `AppBridge` under the spec's default CSP and fails on a network
request, a console error, an exception or a missing size. It needs the optional peer `playwright-core` and Chrome (`MANTLE_TEST_CHROMIUM`);
without a browser it fails. See [Run the compatibility test](../../docs/handbook/guides/mcp-apps.md#run-the-compatibility-test).

Unsafe native integer versions remain exact in transport; generic UI
interactions require safe numeric versions. Entries outside that range are
read-only rather than rounded. CSV streams authorized pages and derives its
fields from generated export metadata. The first page is read before responding;
a later page failure aborts the stream after partial bytes may have arrived.

## Development

Build `@aotter/mantle-ui` before this package. The browser tests exercise the
actual built shell, framing rules, field rendering and conflict
handling. Writes that may have committed are never retried automatically;
conflict re-reads preserve the person's draft. Native login and Store tests
require the selected SDK and Admin server integration, in addition to the SPA.
