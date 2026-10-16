# MCP Apps

Generated `mcp()` accepts app-owned UI resources on either endpoint. Each
endpoint accepts one contributor or an array; Admin uses the same public hook:

```ts
import type { McpApps } from '@aotter/mantle/mcp';
import { adminMcpApps } from '@aotter/mantle-admin/mcp';
import { mcp } from './generated/mcp.js';

const app: McpApps = { resources: [{
  uri: 'ui://my-app/records', name: 'my-app-records',
  html: () => loadAppHtml(), renders: ['records'],
}] };
const handler = mcp({ db, caller, apps: {
  public: app, admin: [adminMcpApps(adminOptions), adminApp],
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

An HTML loader receives `{ tools, env, request }`: `tools` is the same tool names this caller's
`tools/list` returns on the endpoint (with `authorize` configured, only those
it allows), so the HTML it renders names no tool the caller cannot see; `env` is
the environment the handler was called with (a Worker's bindings, such as
`ASSETS`) and `request` the `resources/read` request, for its origin. Loaders
that take less, or nothing, keep working. `adminMcpApps` uses it: the catalogue
it embeds holds only the Views and row actions in `tools`. A host that caches
the resource across callers may hold an older catalogue; a View it does not
describe still shows its rows, with no action to open.

`adminMcpApps({ catalogue })` needs no `html`: its default loader reads the file
`mantle bundle` built, `/admin/mcp-app.html`, through `env.ASSETS.fetch` on a
Worker, and from `dist/client/admin/mcp-app.html` on Bun (`file` names another
path). Pass `html` (a string or a loader) to serve the App from elsewhere. `csp`
is passed through as the resource's `_meta.ui.csp`; give it the object you gave
`defineAdmin({ mcp: { csp } })`, which the build checked the App against.

For static tool tables, construction checks contributors. Request-bound tool tables check on the first matching request and recheck changed tool names. Duplicate
resource URIs or names, conflicting tool ownership, and absent or foreign-endpoint
tools throw `ContractError` with code `MCP_APP_CONFLICT`. HTML loaders never run during import or handler construction. Treat descriptors as
immutable after construction. HTML loads only on `resources/read`; failures
return a redacted internal error.

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

Host context is validated before it is applied. A presentational field the
App cannot use (an unknown display mode, insets missing a side, a negative
size) is dropped and the rest of the context still applies; display modes the
App does not know are filtered out of `availableDisplayModes`. `locale` and
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
uses the official `AppBridge` (`pnpm --filter @aotter/mantle-admin test:browser`).


## Customising Admin for MCP hosts

`mantle bundle` builds the Admin MCP App from the same entry as the browser Admin
(`src/admin.tsx`, or the built-in one) into one self-contained file,
`<assets>/admin/mcp-app.html`, which `adminMcpApps` serves as
`ui://mantle-admin/admin`. So what `defineAdmin` customises reaches a host too:
your components, your plugins, your Tailwind classes, your CSS, your pages. Each
one must work in both places, and the build and the types hold you to it.

### Which slots render where

| Slot | Browser | MCP host |
| --- | --- | --- |
| `Shell`, `Sidebar`, `Header`, `Brand`, `Home`, `CollectionList`, `list.actions:<schema>` | yes | never: the App has no shell, sidebar or router |
| `cell:view:<view>.<column>` | yes | yes: each column of the rows the host's View tool returned |
| `cell:<schema>.<field>`, `input:<schema>.<field>`, `record.aside:<schema>`, `record.actions:<schema>`, `RecordView` | yes | typed `both`, so they receive `surface` and must work in a host; the App does not show a record yet, so they run in the browser today |
| `pages[]`, `nav`, `home`, nav badges | yes | only a page that declares `mcp` (below) |

A component for a `both` slot gets `surface` (`"browser"` or `"mcp-app"`). The
types decide: a `both` slot's props carry `surface`, a browser slot's do not.

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
4. **Remote assets only from origins you declare.** An image, font, stylesheet or
   script from another origin loads only if `defineAdmin({ mcp: { csp } })` names
   it: `{ resourceDomains: ["https://cdn.example.com"] }` (also `connectDomains`,
   `frameDomains`, `baseUriDomains`). Pass the same object to
   `adminMcpApps({ catalogue, csp })`, so the host's CSP allows what the build
   checked. Prefer assets bundled into your entry: they are inlined.
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
`dark:` classes follow it; a host that sends no theme gets the light tokens.
The variables a host does not send fall back to the tokens.

### A page for an MCP App view: `pages[].mcp`

A custom page may also be an App view. Name a View that has an admin MCP tool:

```tsx
export default defineAdmin(admin, {
  pages: [{
    path: "queue", title: "Queue", element: <QueuePage />,
    mcp: { renders: "pending-requests" },
  }],
});
```

When the host's tool is that View's tool, the App shows `<QueuePage />` instead
of the default rows table, in the host's frame and theme. The page reads its own data
through the hooks (`useView("pending-requests", input)` calls the View's tool through
the host), so use only `both` hooks and components, and render something sensible
when a hook reads `unavailable`.
The generated `admin-client.ts` records each View's tool name or `null`; `tsc`
refuses a `renders` that is misspelt, names a collection, or names a View with no
admin MCP tool. When several pages name one View, the first is shown.

### What `mantle bundle` checks

`buildAdmin`, which `mantle bundle` runs, builds the App and then refuses it,
naming the module (and the slot, when it can tell) and pointing here, if the
file:

- contains `/admin/api`, which is the browser's route and has no session in a host;
- reads `document.cookie`;
- loads a `src`, `href`, `url()` or `@import` from a remote origin (`http(s):` or
  `//`) that `defineAdmin({ mcp: { csp } })` does not declare.

`window.open` and `target="_blank"` in your own code only warn. The check reads
every module your entry imports, not only the slots a host renders, so a
browser-only component that calls `/admin/api` fails it too: reach for the
hooks, or move that code out of the entry's import graph. The build prints the
App's size.

### Hosts without MCP Apps

A host that does not advertise the MCP Apps extension gets no `ui://` resource
and no `_meta.ui` on the tools. Its tool results are the same complete JSON
(`content` text and `structuredContent`); the App only shows them. Nothing an
application customises changes what a tool returns.

### Upgrading from the prebuilt App

Earlier versions shipped the App prebuilt as `@aotter/mantle-admin/mcp-app`
(`mantleAppHtml`), which ignored your Admin entry. That export is gone. Remove
the import and the `html:` option from `adminMcpApps({ catalogue })`, run
`mantle generate` again (the generated `admin-client.ts` now records each View's
MCP tool) and `mantle bundle`; the App is in `<assets>/admin/mcp-app.html`, and
your entry's CSS, components and pages are now in it. The Worker's assets
binding must serve `/admin/mcp-app.html` (it does for the Admin build's output
directory); on Bun, `dist/client/admin/mcp-app.html` must exist at run time.
