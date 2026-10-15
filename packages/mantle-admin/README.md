# @aotter/mantle-admin

The complete Mantle Admin product: the SPA, extension client API, same-origin
iframe preview and Admin MCP App. It uses the public `@aotter/mantle-ui` kit
and declares `@aotter/mantle` as a peer. The SDK never imports this package.

## Package migration

These exports moved from `@aotter/mantle-ui` without compatibility aliases:

| Former UI subpath | New Admin subpath |
| --- | --- |
| `/admin/index.html` | `@aotter/mantle-admin/admin/index.html` |
| `/admin/preview.html` | `@aotter/mantle-admin/admin/preview.html` |
| `/admin/host-bridge.js` | `@aotter/mantle-admin/admin/host-bridge.js` |
| `/extension` | `@aotter/mantle-admin/extension` |
| `/admin-preview` | `@aotter/mantle-admin/admin-preview` |
| `/mcp-app` | `@aotter/mantle-admin/mcp-app` |

Admin-specific catalogue and tool-result adapters moved from the UI root to
`@aotter/mantle-admin/controller`. The generic interaction controller remains
at `@aotter/mantle-ui/controller`.

## Static assets

`mantle bundle` builds Admin for the application into `<assets>/admin` (default
`dist/client/admin`) whenever the Worker imports `@aotter/mantle-admin/server`,
through `buildAdmin({ entry, outDir })` from `@aotter/mantle-admin/build` (not a
CLI). The entry is `admin.tsx` beside the Worker entry, default-exporting
`defineAdmin(...)`, or the built-in entry. Vite, Tailwind, React and Admin's UI
packages are dependencies of this package, so the application adds none; the
build needs no install scripts (`npm ci --ignore-scripts` works). A `package-lock.json` made on one OS can lack the native build binaries (rolldown, `@tailwindcss/oxide`, lightningcss) that npm installs per platform from `optionalDependencies`, so a lockfile made on macOS can fail the build on a Linux host; create the lockfile on the build platform or use pnpm.
The build writes the shell, the preview
document, `host-bridge.js`, the extension shims and hashed assets.

Serve that directory through an app-owned asset binding or reader at `/admin/`;
`adminShell`'s `assets(path)` receives paths relative to it. Bun hosts serve the
prebuilt directory of `@aotter/mantle-admin/admin/index.html` the same way until
they build Admin too. Missing assets stay missing;
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
Keep missing `/admin/assets/*` and `/admin/shared/*` as 404 responses. Supply a
CSP that allows the built import map by its exact SHA-256 hash; never authorize
inline extension scripts. The API cannot serve or rewrite assets.

All 22 languages are retained. English is the fallback in the entry; the saved
language loads before rendering, and switching waits for its language chunk.
Rich-text editors and the complete developer workspace load on demand.

## App library

`@aotter/mantle-admin/app` exports `defineAdmin(meta)` and `<MantleAdmin admin>`.
An Admin entry default-exports `defineAdmin(...)`; `<MantleAdmin>` is the root
for an app that mounts Admin inside its own providers, and it renders once the
stored or browser language has loaded. The built-in entry is `defineAdmin({})`:
with no generated metadata, Admin reads its collections, Views and operations
from `/admin/api` at runtime. The prebuilt SPA is that entry, built the same way.
Admin extensions load only in Admin built by `buildAdmin`: its page supplies the
import map and shared modules that extension modules resolve `react` and the kit
through. An app that renders `<MantleAdmin>` in its own build has neither, so
extension client modules fail to load there.

## Extensions

```ts
import { defineAdminExtension } from "@aotter/mantle-admin/extension";
import { Button } from "@aotter/mantle-ui/kit";
```

Admin's build-time import map shares React and its kit with extensions. An
extension module must resolve these imports through that map; do not bundle
another React instance. The app owns extension asset hosting and supplies the
module URL and integrity metadata. Runtime Admin does not fetch modules to
calculate integrity.

## Preview

Use `adminPreviewDocument` and `readAdminPreviewRequest` from `/admin-preview`
with the exported preview document and host bridge. The immediate parent must
be same-origin. Validate the protocol-1 request envelope, bind the bridge to
one source revision, and authorize every runtime request. Unknown paths never
fall through to authentication or another origin. The canonical Admin document
continues to refuse framing.

A design preview displays generated developer metadata; it grants no role,
database access or authentication capability. The ER and business-flow
workspace remains part of the product.

## MCP App

The `/mcp-app` entry exports `mantleAppHtml`. The Admin contributor registers
it through the SDK's generic MCP Apps hook. Tools retain the same caller
permissions as ordinary MCP calls; the document holds no credentials. Reserve
`ui://mantle-admin/` resources for this contributor. The catalogue it embeds is
cut to the reading caller's tools, and `domain` passes through to
`_meta.ui.domain`. What the App asks of a host is in the
[MCP Apps guide](../../docs/handbook/guides/mcp-apps.md#the-admin-app-in-a-host).

Unsafe native integer versions remain exact in transport; generic UI
interactions require safe numeric versions. Entries outside that range are
read-only rather than rounded. CSV streams authorized pages and derives its
fields from generated export metadata. The first page is read before responding;
a later page failure aborts the stream after partial bytes may have arrived.

## Development

Build `@aotter/mantle-ui` before this package. The browser tests exercise the
actual built shell, extensions, framing rules, field rendering and conflict
handling. Writes that may have committed are never retried automatically;
conflict re-reads preserve the person's draft. Native login and Store tests
require the selected SDK and Admin server integration, in addition to the SPA.
