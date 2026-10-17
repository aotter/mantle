# MCP Apps

Generated `mcp()` accepts app-owned UI resources on either endpoint. Each
endpoint accepts one contributor or an array; Admin uses the same public hook:

```ts
import type { McpApps } from '@aotter/mantle/mcp';
import { adminMcpApps } from '@aotter/mantle-admin/mcp';
import { mcp } from './generated/mcp.js';
import { mcpAppCatalogues } from './generated/admin-descriptors.js';

declare const db: (env: Env) => D1Database; // as in service composition
declare const caller: Parameters<typeof mcp>[0]['caller'];
declare function loadAppHtml(): string;

const app: McpApps = { resources: [{
  uri: 'ui://my-app/records/build-1', name: 'my-app-records',
  html: () => loadAppHtml(), renders: ['records'],
}] };
const handler = mcp({ db, caller, apps: {
  public: app,
  admin: adminMcpApps({ catalogue: mcpAppCatalogues.admin }), // or an array with your own contributors
} });
```

Use your own `ui://<app>/…` prefix. `ui://mantle-admin/…` is reserved for Admin.
HTML is reusable static content; caller-specific data comes from tool results.
Build the front end with the official `@modelcontextprotocol/ext-apps` client.
`renders` links tools to `_meta.ui.resourceUri`; `appOnly` adds
`visibility: ["app"]`. Both name tools actually exposed on that endpoint.
Resources may supply CSP, permissions, `prefersBorder` and `domain`; each is
passed through as the resource's `_meta.ui`. `domain` is the dedicated sandbox
origin for hosts that serve each App from its own origin; use the form that
host documents.

## Package and application ownership

Core (`@aotter/mantle`) owns tools, resources, endpoint links and server authorization,
validation, scope and OCC. It has no React, DOM or Admin dependency. The optional
`@aotter/mantle-ui` owns reusable presentation and interaction controllers: pass it
data and invocation callbacks; it knows no MCP connection, cookie, role or Admin API.
`@aotter/mantle-admin` owns the Admin product, its existing hooks/surface transport
and the thin adapter to the pinned official ext-apps client. The official client
owns protocol negotiation, messages and connection lifecycle; the separate browser
source/origin guard is not a protocol implementation.

Applications own domain components and build entries. A frontend MCP App uses its
own React entry, official ext-apps and optionally mantle-ui, registered through
Core's generic resources. It needs no Admin package or Admin session. See the
[standalone frontend example](../../examples/frontend-mcp-app/README.md) for a
small owner-scoped example. `public` names the frontend endpoint, not anonymous
access: use the application's verified Caller and generated authorization rules.
UI visibility and `appOnly` metadata grant no execution authority.

The default Admin App uses the default composition. Custom Admin Apps use the same
`defineAdmin` entry, slots and hooks, with `pages[].mcp` for explicit page opt-in;
an application may also supply its own resource. There is no extra Mantle bridge
package, provider, slot registry or query cache to install for these paths.

When combining a custom renderer with Admin, partition ownership explicitly:

```ts
// Both views already belong to this endpoint. Custom resources use their own prefix.
const adminApps = [
  adminMcpApps({ catalogue: mcpAppCatalogues.admin, renders: ['pending_requests'] }),
  { resources: [{ uri: 'ui://my-app/details/build-2', name: 'my-details',
    html: () => loadAppHtml(), renders: ['request_details'] }] },
];
```

Register the array on `apps.admin`. Leaving Admin's default ownership of all Views
while another resource claims one is an error, independent of registration order.

An HTML loader receives `{ tools, env, request }`: `tools` is the same tool names this caller's
`tools/list` returns on the endpoint (with `authorize` configured, only those
it allows), so the HTML it renders names no tool the caller cannot see; `env` is
the environment the handler was called with (a Worker's bindings, such as
`ASSETS`) and `request` the `resources/read` request, for its origin. Loaders
that take less, or nothing, keep working. `adminMcpApps` uses it: the catalogue
it embeds holds only the Views and row actions in `tools`. A host that caches
the resource across callers may hold an older catalogue; a View it does not
describe still shows its rows, with no action to open.

`adminMcpApps({ catalogue })` takes `mcpAppCatalogues.admin`, which `mantle generate --admin` writes to
`generated/admin-descriptors.ts` (pass it as is). It needs no `html`: its default loader reads the file
`mantle bundle` built, `/admin/mcp-app.html`, through `env.ASSETS.fetch` on a
Worker, and from `dist/client/admin/mcp-app.html` on Bun (`file` names another
path). The Worker's assets binding must be named `ASSETS` (otherwise pass `html`);
the loader follows the one same-origin redirect the default `html_handling` answers a
`.html` path with. Pass `html` (a string or a loader) to serve the App from elsewhere. The
file carries the `csp` your `defineAdmin({ mcp: { csp } })` declared; a loader may return
`{ html, csp }` instead of a string, and the handler sends that `csp` as `_meta.ui.csp` on
`resources/read`; it replaces the resource's own `csp` rather than merging with it. A loader
that throws answers the host with a redacted error and logs the message on the server.

Resource URIs are immutable cache identities. By default Admin contributes an async
resource source: after the request passes the origin/identity/Admin gates, Admin
reads its built asset and hashes the HTML, full static catalogue and material
resource metadata into `ui://mantle-admin/admin/<digest>`. A new UI build or catalogue
gets a new URI, used consistently by tools and resource reads. Workers cache only
the raw immutable asset/identity per contributor and ASSETS binding; caller-filtered
catalogues are embedded per read. Bun rereads the file so rebuilding in the same
process changes the identity. Run `mantle bundle` and deploy its assets with the server;
missing assets can fail discovery when Admin resolves the build identity.

An explicit `uri` keeps application-owned identity. A custom `html` function must
supply a build-specific `uri`: Core cannot infer its build or safely memoize its
request-dependent output. A raw `html` string may use the automatic identity.

### Keep old conversations working after an upgrade

A new URI does not invalidate a host's saved tool definitions or old conversation
cards. Keep previously deployed pages with `adminMcpApps({ catalogue, previous })`.
`previous` is an array of `AdminMcpSnapshot` from `@aotter/mantle-admin/mcp`:
`{ uri, html, csp?, domain?, title? }`. Each `html` includes the original `mantle-catalog`
script (the page returned by `resources/read`, not the raw bundle). The SDK serves
its original HTML and metadata at its original URI, filters its catalogue against
the current caller's tools on every read, and gives only the current build renderer
ownership. A removed/denied tool gains no authority through an old page.

Store these snapshots in the application's source or durable artifact storage;
an isolate cache or untracked `dist/` is insufficient for a clean CI deployment.
Keep an explicit retention window. Old pages outside that window and incompatible
tool renames/input/output changes need an application migration. Never answer an
old digest with the latest HTML. Host metadata refresh is a development/recovery
operation, not a normal compatible-upgrade requirement.

For the default built loader, share the exact declaration in
`src/mcp-app-definition.ts` (no `html` or `previous`):

```ts
import { mcpAppCatalogues } from '../generated/admin-descriptors.ts';
export const appDefinition = { catalogue: mcpAppCatalogues.admin };
```

The service imports that definition and a committed `mcp-app-previous.json` at the project root
(initially `[]`), and passes `adminMcpApps({ ...appDefinition, previous })` to its
endpoint. Keep custom `renders`, catalogue extensions, `domain` and `title` in the
shared definition too. Node 22.18+ can read these generated `.ts` modules; a
TypeScript app using `.ts` import paths enables `allowImportingTsExtensions`
with `noEmit`. JSON imports use `with { type: 'json' }`.
Keep snapshots outside the directory containing `admin.tsx`: Tailwind scans that
directory, and compiled HTML/JavaScript inside a snapshot can be mistaken for
utility class names and change subsequent CSS builds.

After a successful deployment, archive the **exact asset just deployed** with
this application-owned `scripts/archive-mcp-app.mjs`, then commit the snapshot
for the next build. Run it in the deployment script, not as a manual cache fix:

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { adminMcpApps } from '@aotter/mantle-admin/mcp';
import { appDefinition } from '../src/mcp-app-definition.ts';

const path = 'mcp-app-previous.json';
const previous = JSON.parse(readFileSync(path, 'utf8'));
const context = { env: {}, request: new Request('https://archive.invalid/mcp') };
const source = adminMcpApps({ ...appDefinition,
  html: readFileSync('dist/client/admin/mcp-app.html', 'utf8') });
const { resources: [resource] } = typeof source === 'function' ? await source(context) : source;
const tools = new Set([...Object.keys(appDefinition.catalogue.views),
  ...Object.keys(appDefinition.catalogue.actions)]);
const loaded = typeof resource.html === 'string' ? resource.html
  : await resource.html({ ...context, tools });
const page = typeof loaded === 'string' ? { html: loaded } : loaded;
const snapshot = { uri: resource.uri, title: resource.title, ...page,
  ...(resource.domain === undefined ? {} : { domain: resource.domain }) };
// This application's policy: retain the last two deployed pages for future builds.
writeFileSync(path, JSON.stringify([...previous.filter(p => p.uri !== snapshot.uri), snapshot].slice(-2)) + '\n');
```

This archives static UI/catalogue metadata, never rows, cookies or OAuth tokens.
Custom loaders must archive their actual immutable resource, including CSP/domain,
instead of using this default-asset recipe. Compare the archived URI with deployed
`tools/list`/`resources/read`; a mismatching declaration or stale local build is
not deployment evidence.

Core accepts static contributors or async `(context: { env, request }) => McpApps`
sources, including mixed arrays. Static declarations are checked at construction;
async sources resolve after the endpoint's origin and caller gates, then their
links are checked without reusing another request's resource links. Request-bound
tool tables check on the first matching request and recheck changed tool names. Duplicate
resource URIs or names, conflicting tool ownership, and absent or foreign-endpoint
tools throw `ContractError` with code `MCP_APP_CONFLICT`. HTML loaders never run during import or handler construction. Treat descriptors as
immutable after construction. Static HTML loaders run only on `resources/read`;
async sources may read immutable build assets to declare their identity. Failures
return a redacted internal error. Core never reads a build file or computes a UI digest.

Generated media-enabled handlers keep the same cache while resolving their tool
table against each request's environment. Database handles, storage and Caller
are never retained in that cache. The low-level SDK also accepts an async
`(request, env) => tools` resolver; its names must match the endpoint's App
catalogue. If its tool names change, those links are checked again, and a call
always uses the current request's tool table.

Clients advertise `io.modelcontextprotocol/ui` and MIME type
`text/html;profile=mcp-app` in initialization capabilities or, for stateless
requests, in `params._meta["io.modelcontextprotocol/clientCapabilities"]`.
An explicit capability declaration without UI support receives no UI resources, UI tool metadata or App-only tools. A stateless request with no capability declaration is treated as unknown and retains App support. Other tools retain their existing validation,
authorization, caller, origin and database behavior.

## The Admin App in a host

The Admin App speaks MCP Apps `2026-01-26` to the host and asks only for what
the host advertises in `hostCapabilities`:

- Without `serverTools` it is read-only: rows show, no row action opens and no
  list refresh is attempted.
- `format: "uri"` values with an `http(s)` URL open through `ui/open-link`
  when the host offers `openLinks`, and are plain text otherwise. The sandbox
  blocks navigation, so the App never uses `window.open` or `target="_blank"`.
- After a row action succeeds, `ui/update-model-context` tells the model the
  tool, the row id and the outcome, for its next turn. The App never sends
  `ui/message`, which would speak for the user.
- It declares `availableDisplayModes: ["inline", "fullscreen"]` and offers a
  full-screen toggle (`ui/request-display-mode`) when the host lists
  `fullscreen` in its context.
- `appInfo.version` is the `@aotter/mantle-admin` version.

The pinned official client validates host context. Invalid protocol data is not
reinterpreted by a second Mantle wire parser; connection failures are visible.
Mantle applies only presentation fields and style variables it supports. `locale` and
`timeZone` format dates (an unknown zone falls back to the browser's);
`safeAreaInsets` become root padding; `containerDimensions` bound the root: a
fixed or maximum height scrolls, and the reported size stays within it.
`theme: "dark"` sets both `data-theme` and the `.dark` class. Only the spec's
style variables are applied; [Theme](#theme) says how they meet your own.

A View result carries its rows twice, as the JSON text block and as
`structuredContent`. Hosts truncate long tool results (about 150k characters
is reported for some), and a truncated text block is no longer JSON. So an MCP
View page is cut by size: `limit` still accepts 1 to 500, but a page holds only
as many of those rows as fit 60,000 characters of JSON. It stops before the first
row that overflows, and the next cursor resumes at that row, so no row is skipped
or repeated. A single row over the budget is returned alone, with its cursor, and a
View without an order (one page, no cursor) is returned whole; any page still over the
budget carries a notice that hosts may truncate it. The default is 50 rows. REST and native paging keep their 500-row limit.

Checks against real hosts need an account and a public HTTPS endpoint, so
they are manual: add the endpoint as a custom connector in each host, call a
View tool with an App, and check light and dark themes, a narrow window,
full screen, a row action, and a link. Check too that the host advertises
`hostCapabilities.serverTools`; without it the App is read-only. The automated interoperability test
uses the official `AppBridge`; your app runs its generated version ([Run the compatibility test](#run-the-compatibility-test)).

### Verify a deployed App in ChatGPT

When intentionally introducing changed tool contracts during development, refresh the connector's tools
in ChatGPT settings and reload the conversation before testing. Reconnecting an
OAuth account renews credentials; it does not establish that the host adopted
the new tool catalogue. Discover the current render tool and its
`_meta.ui.resourceUri`, then invoke it in a new turn. An older card retains its
original URI, which the current deployment may no longer serve.

For a compatible upgrade, retain that original resource as described above and
test the old conversation **before** any tool refresh or reconnect. Test a clean
first connection separately. Normal initial OAuth consent is expected; renewal
or clearing host state to make an upgrade pass is not a successful upgrade test.

Diagnose the first failing stage before changing the App:

- `connector_auth_required` from the host's widget request: renew the existing
  linked account through its normal OAuth flow.
- `HTML asset not found`: compare the card's URI with the current authenticated
  `tools/list` and `resources/read`; refresh stale host metadata, or repair a
  missing/mismatched resource. A successful static asset GET alone is insufficient.
- Widget request succeeds, but the sandbox document fails to load: inspect that
  document's network result. The App bridge cannot initialize before its HTML runs.
  Browser automation can itself pause document responses and abort the host's
  sandbox navigation. If the automation reports a paused document response, repeat
  the same card in native Chrome with that tab's automation debugger disconnected.
  Compare the same deployment and resource URI before blaming the SDK. Reattaching
  automation to an already loaded iframe does not test its initial navigation.
- HTML runs, but initialization fails: inspect the official client's connection
  error and test the same resource HTML with the official `AppBridge` host.

Accept host rendering only after the iframe visibly displays the returned data.
Record the tested URI and distinguish a successful tool result, local official-host
replay and actual ChatGPT rendering. The assistant saying it displayed a card is
not evidence that the iframe rendered. Verify with the host's CSP enforcement
enabled and preserve authentication throughout; label any CSP-disabled diagnostic
run separately. Exercise a read-only UI tool call, such as loading the next page,
to check the live bridge as well as the initial result.


## Customising Admin for MCP hosts

`mantle bundle` builds the Admin MCP App from the same entry as the browser Admin
(`src/admin.tsx`, or the built-in one) into one self-contained file,
`<assets>/admin/mcp-app.html`, which `adminMcpApps` serves as
`ui://mantle-admin/admin/<digest>` by default. Shared View cells and opted-in pages reach the host, with application plugins,
Tailwind classes and CSS. Browser-only record/input overrides do not mount there.

### Which slots render where

| Slot | Browser | MCP host |
| --- | --- | --- |
| `Shell`, `Sidebar`, `Header`, `Brand`, `Home`, `CollectionList`, `list.actions:<schema>` | yes | never: the App has no shell, sidebar or router |
| `cell:view:<view>.<column>` | yes | yes: each column of the rows the host's View tool returned |
| `cell:<schema>.<field>`, `input:<schema>.<field>`, `record.aside:<schema>`, `record.actions:<schema>`, `RecordView` | yes | never: browser-only record/collection slots; their `surface` is `"browser"` (`mantle bundle` reminds you) |
| `pages[]`, `nav`, `home`, nav badges | yes | only a page that declares `mcp` (below) |

A component for a `both` slot gets `surface` (`"browser"` or `"mcp-app"`). The
record/collection slots keep `surface: "browser"` for an explicit, truthful contract.
Other browser-only slots have no `surface` prop.

Migration (#1710): remove unreachable `surface === "mcp-app"` branches from
record/input/collection overrides. Their surface is now typed as the browser
literal. Move shared interactions to a View cell or opted-in page; changing
this type does not add a record editor, entry tool, or automatic CRUD to MCP.

### Record input versus Procedure action input

`input:requests.title` wraps the browser record editor's `value`, `onChange`,
`readOnly` and JSON Schema property. It does not customize an MCP action dialog.
The native App builds that dialog from the Procedure's declared input schema,
binds the row identity and observed version, validates input, and runs the
existing authorized Procedure tool. There is no View `actions` field.
Declare `Procedure.spec.target: { schema: requests, id: id, version: expectedVersion }`
and expose it with a Trigger whose `source: { kind: mcp, surface: admin }` and
`target: { procedure: approve }`. Return the target row's unchanged `id` and
`version` in the View, preserving their column provenance (do not replace them
with a computed label, joined row identity or synthetic version). Admin derives
row bindings from that target and the View's proven columns. See
[Procedure targets and row placement](native-admin.md#collection-navigation-and-operation-placement)
and the shipped [purchasing manifest](../../examples/purchasing/manifests/purchasing.yaml)
for complete Procedure/Trigger syntax. Changing the UI grants no execution rights.

For custom MCP interaction, use an opted-in page with `useView` and
`useOperation` instead of trying to render a record editor. The shared-page example below demonstrates page opt-in;
[Native Admin](native-admin.md) describes generated typed hooks. An operation
component follows the same public contract:

```tsx
// In a typed opted-in page; replace approve/input with your generated names.
function Approve({ id }: { id: string }) {
  const { run, pending } = useOperation("approve");
  const [message, setMessage] = useState("");
  return <><button disabled={!run || pending} onClick={() => {
    void run?.({ id }).then(() => setMessage("Done"), () => setMessage("Not available"));
  }}>Approve</button><p role="status">{message}</p></>;
}
```

Import `useState` from React and `useOperation` from your generated
`admin-client` (its types are tied to your manifests). Include observed-version
input when the Procedure declares OCC; never replace it with an unguarded write.
Without serverTools capability, `run` is absent and this button stays disabled.
A missing or denied tool is reported as unavailable when invoked; an enabled
button does not establish permission. To ship a record-oriented MCP UI today, explicitly
declare its read View and write Procedure; `useEntry` is unavailable in MCP.

### Rules for a component that renders in a host

1. **Data only through the hooks.** `useView` and `useOperation` call the View's
   or Procedure's admin MCP tool through the host, as the signed-in caller.
   `useEntries`, `useEntry`, `useCollectionTotal`, `useMe` and `useBadges` have no
   tool and read `unavailable`: declare the data a component needs as an admin
   View. Without the host's `serverTools`, `useOperation().run` is `undefined`.
   No `fetch` to `/admin/api`, no `document.cookie`: the build refuses both.
2. **Links through the host.** `<AdminLink>` and `useOpenLink()` open an http(s)
   URL through `ui/open-link`; the sandbox blocks `window.open` and
   `target="_blank"`. An `/admin/...` path has no origin in a host, so
   `<AdminLink>` shows it as text.
3. **No assumed width.** The host sets the frame; a narrow one and a full screen
   must both work.
4. **Remote assets only from origins you declare.** Something from another origin
   loads only if `defineAdmin({ mcp: { csp } })` names it in the list its use needs:
   `resourceDomains` for an image, font, stylesheet or script,
   `connectDomains` for `fetch`, `WebSocket`, `EventSource` and `import()`,
   `frameDomains` for an iframe (`baseUriDomains` is for `<base>`). Each entry is an
   origin, `https://host[:port]` or `https://*.host`; the build refuses `*`, a bare
   scheme or a path. You declare it once: the build writes it into
   `mcp-app.html` and `adminMcpApps` sends it as `_meta.ui.csp` on `resources/read`
   (not on `resources/list`, which names no HTML). Prefer assets bundled into your entry: they are inlined.
5. **Branch on the surface if you must, but both branches render.**
   `useAdminSurface()` and the `surface` prop say where you are; a component that
   shows nothing in a host is a hole in the host's view.

### Theme

The App's colours come from three layers, later over earlier:

1. Admin's default tokens (`@aotter/mantle-ui/tokens.css`: the shadcn variables
   `--background`, `--primary`, `--chart-1` and the rest).
2. Your own CSS, which your entry imports: your `--primary` or `.dark {}`
   overrides apply in the App as they do in the browser Admin.
3. The host's style variables, for neutral colours, radii, text sizes and the
   font only, laid over the tokens. The table lists, for each host variable the
   App reads, the Tailwind theme variable it feeds.

| Host variable | App theme variable |
| --- | --- |
| `--color-background-primary` | `--color-background`, `--color-card`, `--color-popover` |
| `--color-text-primary` | `--color-foreground`, `--color-card-foreground`, `--color-popover-foreground`, `--color-secondary-foreground`, `--color-accent-foreground` |
| `--color-background-secondary` | `--color-muted`, `--color-secondary`, `--color-accent` |
| `--color-text-secondary` | `--color-muted-foreground` |
| `--color-border-primary` | `--color-border`, `--color-input` |
| `--color-ring-primary` | `--color-ring` |
| `--color-text-danger` | `--color-destructive` |
| `--border-radius-sm` | `--radius-sm` |
| `--border-radius-md` | `--radius-md` |
| `--border-radius-lg` | `--radius-lg` |
| `--font-text-xs-size` | `--text-xs` |
| `--font-text-xs-line-height` | `--text-xs--line-height` |
| `--font-text-sm-size` | `--text-sm` |
| `--font-text-sm-line-height` | `--text-sm--line-height` |
| `--font-text-md-size` | `--text-base` |
| `--font-text-md-line-height` | `--text-base--line-height` |
| `--font-sans` | `--font-app` (the App's font) |

`--font-mono` and `--font-weight-*` apply as the host gives them. The primary
colours (`--color-primary`, `--color-primary-foreground`) and the chart colours
(`--color-chart-1` to `-5`) are your brand's and are never the host's.
`--sidebar-*` and `--app-*` do not apply in a host. The host's theme marks the
root with both `data-theme` and the `.dark` class, so your `.dark {}` block and
`dark:` classes follow it; a host that sends no theme gets the system's colour scheme (`prefers-color-scheme`), as the same `.dark` class, and a theme the host sends wins over it.
The variables a host does not send fall back to the tokens.

### A page for an MCP App view: `pages[].mcp`

A custom page may also be an App view. Name a View that has an admin MCP tool:

```tsx
export default defineAdmin(admin, {
  pages: [{
    path: "queue", title: "Queue", element: <QueuePage />,
    header: { description: "Items awaiting review", actions: <QueueActions /> },
    mcp: { renders: "pending-requests" },
  }],
});
```

The explicit `header` object shares the native title, localized description and
React actions with browser Admin. Its actions must use the same host-safe hooks
and capability fallbacks as the page. `header: false` delegates the heading to
the element; omit `header` to preserve element-only MCP presentation (and the
browser's native title). Do not render a second h1 inside `element` when using
the native heading.

When the host's tool is that View's tool, the App shows `<QueuePage />` instead
of the default rows table, in the host's frame and theme. The page reads its own data
through the hooks (`useView("pending-requests", input)` calls the View's tool through
the host), so use only `both` hooks and components, and render something sensible
when a hook reads `unavailable`.
The generated `admin-client.ts` records, for each View, `true` when it is an admin MCP tool and `null` when not; `tsc`
refuses a `renders` that is misspelt, names a collection, or names a View with no
admin MCP tool. When several pages name one View, the first is shown.

### What `mantle bundle` checks

`buildAdmin`, which `mantle bundle` runs, builds the App and then refuses it,
naming the module (and the slot, when it can tell) and pointing here, if the
file:

- contains `/admin/api`, which is the browser's route and has no session in a host;
- reads `document.cookie`;
- uses a remote origin (`http(s):` or `//`; `ws(s):` for sockets) that
  `defineAdmin({ mcp: { csp } })` does not declare in the list that use needs.

The check is best effort: it reads the built text, so it catches only what it can
see as a string. It catches `src` and `poster` attributes and props, `<iframe src>`
(against `frameDomains`), every URL of a `srcset` and of a CSS `image-set()`, `url()`
and `@import`, a `<link href>`, `setAttribute("src" | "href", "https://…")`, and a
remote string literal given to `fetch()`, `new WebSocket()`, `new EventSource()` or
`import()` (against `connectDomains`). It does not treat `href` on a link
(`<a>`, `<AdminLink>`) as a load: that is navigation, which opens through the host.
A URL put together at run time is not seen; the generated compatibility test, which
loads the App under the spec's default CSP and fails on any network request, is
the backstop at run time. `document.cookie` in Mantle's own library code (the kit's
sidebar remembers its state in one) does not fail the build; in yours it does.

`window.open` and `target="_blank"` in your own code only warn. The whole selected
MCP entry graph is checked, not only the slots a host renders. By default it is
the Admin entry, so browser-only code (a `Shell`, a `Home`, a page) imported there
must avoid direct `/admin/api` fetches and cookies too. Shared components read
through the hooks, which use the browser route in the browser and host tools in
a host. For integrations that need browser APIs, select a separate entry below.
The build prints the App's size.

### Isolate browser-only integrations

`pages[].mcp` opts a page into rendering; it does not remove other imports from
the build. To isolate browser-only integrations, add `admin.mcp.tsx` beside the
Worker entry and `admin.tsx`. `mantle bundle` discovers this optional file and
uses it for `mcp-app.html`; the browser SPA and preview keep `admin.tsx`. With the
build API, pass `buildAdmin({ entry: "src/admin.tsx", mcpEntry: "src/admin.mcp.tsx", outDir: "dist/client/admin" })`.
Without the optional file/option, the shared-entry behavior is unchanged.

Keep a single host-safe config and components module, composed through the same
`defineAdmin` contract in both roots. For example, with an admin View `queue`:

```tsx
// src/admin-shared.tsx
import type { AdminConfig } from "@aotter/mantle-admin/app";
import type { AppAdminTypes } from "../generated/admin-client.js";
import { QueuePage } from "./queue-page.js"; // native hooks, host-safe components
import "./shared.css";
export const shared = {
  pages: [{ path: "queue", title: "Queue", element: <QueuePage />, mcp: { renders: "queue" } }],
} satisfies AdminConfig<AppAdminTypes>;
```

```tsx
// src/admin.tsx: only the browser root imports this integration
import { defineAdmin } from "@aotter/mantle-admin/app";
import { admin } from "../generated/admin-client.js";
import { shared } from "./admin-shared.js";
import { BrowserReport } from "./browser-report.js";
export default defineAdmin(admin, {
  ...shared,
  pages: [...shared.pages, { path: "browser-report", title: "Browser report", element: <BrowserReport /> }],
});
```

```tsx
// src/admin.mcp.tsx: no import of admin.tsx or browser-report.js
import { defineAdmin } from "@aotter/mantle-admin/app";
import { admin } from "../generated/admin-client.js";
import { shared } from "./admin-shared.js";
export default defineAdmin(admin, shared);
```

Only code excluded from the MCP graph may use browser-only integrations. The
selected MCP entry is still read in Node to obtain its definition: do not access
`window` or `document` at module initialization there. An explicit entry that
fails to load fails the build; it does not fall back to the browser entry.
The MCP guard, declared CSP, catalogue, resource ownership and built-HTML cache
identity apply to the selected graph exactly as before. Entry selection changes
no server permissions and adds no provider or transport.

### Run the compatibility test

For an interactive test in another official host, load the HTML returned by an
authenticated MCP `resources/read`, discovered through `resources/list` or the
tool's UI resource link. Do not serve the raw built `mcp-app.html` directly: the
server embeds the caller-filtered catalogue when reading the resource, and
without that catalogue native row actions are absent. The generated test below
supplies its own synthetic catalogue and checks rendering, not a real host's
authorization flow or a completed action dialog.

The build check reads text; this test runs the App. `mantle generate --admin` writes
`generated/admin-mcp-app.check.mjs`. After `npm run build`, run
`node --test generated/admin-mcp-app.check.mjs` (the examples name it `npm test`;
`MANTLE_MCP_APP_HTML` points it at another built file). It loads the built
`mcp-app.html` in a host page built on the official `AppBridge`. The App is in a
sandboxed iframe from its own origin, under the spec's default CSP, so it cannot
reach the host page. For each View whose `cell:view:` slot you override and each
`pages[].mcp` page it sends sample rows made from the catalogue's column schemas
(three full rows and one with every nullable column null), in a light and a dark
host. When the file records nothing customised it runs the first View of the
catalogue; when the file has no record at all, every View. It fails on:

- a network request that leaves the frame (the failure names the URL; origins you
  declared in `mcp.csp`, for the kind of use they were declared for, are answered
  empty, since the test has no network);
- a console error, including a CSP refusal, or an uncaught exception;
- an App that does not show the result (it still waits, or is empty), that does not
  take the host's dark theme, or that never reports a size.

After the result it waits until the App has made no request and logged nothing for
400 ms, at most 5 s. The test checks the slots a host renders today: `cell:view:` and
pages. `input:`, `record.aside:`, `record.actions:`, `cell:<schema>.<field>` and
`RecordView` are browser-only, so the generated compatibility check does not
claim to test them. A Procedure action form does not mount these slots.

It needs `playwright-core` (`npm install -D playwright-core`) and Chrome or Chromium:
run `npx playwright-core install chromium`, or set `MANTLE_TEST_CHROMIUM` to a Chrome or
Chromium executable. With no browser the test fails, saying so; it never skips. Import
`checkMcpApp` from `@aotter/mantle-admin/testing` to call it yourself. For a real host
(Claude's custom connector, ChatGPT), follow the manual checks under
[The Admin App in a host](#the-admin-app-in-a-host).

### Hosts without MCP Apps

A host that does not advertise the MCP Apps extension gets no `ui://` resource
and no `_meta.ui` on the tools. Its tool results are the same complete JSON
(`content` text and `structuredContent`); the App only shows them. Nothing an
application customises changes what a tool returns.

### Upgrading from the prebuilt App

Earlier versions shipped the App prebuilt as `@aotter/mantle-admin/mcp-app`
(`mantleAppHtml`), which ignored your Admin entry. That export is gone. Remove
the import and the `html:` option from `adminMcpApps({ catalogue })`, run
`mantle generate` again (the generated `admin-client.ts` now records which Views are admin
MCP tools) and `mantle bundle`; the App is in `<assets>/admin/mcp-app.html`, and
your entry's CSS, components and pages are now in it. The Worker's assets
binding must serve `/admin/mcp-app.html` (it does for the Admin build's output
directory); on Bun, `dist/client/admin/mcp-app.html` must exist at run time.
