# MCP Apps

Generated `mcp()` accepts app-owned UI resources on either endpoint. Each
endpoint accepts one contributor or an array; Admin uses the same public hook:

```ts
import type { McpApps } from "@aotter/mantle/mcp";
import { adminMcpApps } from "@aotter/mantle-admin/mcp";
import { mcp } from "./generated/mcp.js";
import { mcpAppCatalogues } from "./generated/admin-descriptors.js";

declare const db: (env: Env) => D1Database; // as in service composition
declare const caller: Parameters<typeof mcp>[0]["caller"];
declare function loadAppHtml(): string;

const app: McpApps = {
  resources: [
    {
      uri: "ui://my-app/records/build-1",
      name: "my-app-records",
      html: () => loadAppHtml(),
      renders: ["records"],
    },
  ],
};
const handler = mcp({
  db,
  caller,
  apps: {
    public: app,
    admin: adminMcpApps({ catalogue: mcpAppCatalogues.admin }), // or an array with your own contributors
  },
});
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

When one App is served at several server URLs and the host derives `domain`
from the server URL, pass a function source and set `domain` from `request.url`,
the URL of the request being answered. Core does not compute host-specific
values; apply the formula the host documents, for Claude
[Set `ui.domain` for Claude](https://claude.com/docs/connectors/building/mcp-apps/getting-started#set-ui-domain-for-claude):

```ts
import type { McpAppsSource } from "@aotter/mantle/mcp";

declare function loadAppHtml(): string;
declare function hostDomain(serverUrl: string): string; // the formula your host documents

const app: McpAppsSource = ({ request }) => ({
  resources: [
    {
      uri: "ui://my-app/records/build-1",
      name: "my-app-records",
      html: () => loadAppHtml(),
      renders: ["records"],
      domain: hostDomain(request.url),
    },
  ],
});
```

A resource's `meta` adds host-defined keys to the `_meta` of the
`resources/read` content item, merged as a tool's `meta` is: the top level
shallowly, `ui` one key deep. The typed fields (`csp` or a loader's `csp`,
`permissions`, `domain`, `prefersBorder`) are applied after it and win over
`meta.ui` keys of the same name. `meta` is not sent on `resources/list` or in
tool `_meta`. For example, `meta: { ui: { preferredDisplayMode: 'fullscreen' } }`
asks Claude to open the App in its side panel, where available, without a click.
This is a Claude extension outside the MCP Apps specification, as Claude's
[display modes](https://claude.com/docs/connectors/building/mcp-apps/display-modes)
page describes it; other hosts may ignore it.

### Tool metadata and result `_meta`

A hand-built kernel `Tool` may set `meta`, merged into its `_meta` in
`tools/list` with what App links produce: the top level shallowly, `ui` one key
deep. Use it for keys such as `ui.visibility`, `ui.resourceUri` with
`openai/outputTemplate`, or `openai/fileParams`. A value that contradicts an App
link (another `ui.resourceUri` than the `renders` resource, or a visibility other
than `["app"]` on an `appOnly` tool) fails when `mcp()` is constructed.
`meta: { ui: { visibility: ["app"] } }` hides any tool, a Procedure included,
from clients that declare no MCP Apps support, as `appOnly` does for Views. It
is a listing hint only: `tools/call` still runs every identity, scope, `check`
and `authorize` decision, so an App-only write is authorized like any other.
It is not an access boundary either: any client holding the same credential can
call an App-only tool directly. An action that needs the person present is
enforced on the server, for example by a Procedure that accepts only a
single-use value which a person-present check in the browser produces and
which no MCP result ever returns.

A `run` may return `withResultMeta(data, meta)` from `@aotter/mantle/mcp`. The
result's text and `structuredContent` are built from `data` exactly as before;
`meta` goes only into the result `_meta`, beside `net.aotter.mantle/tool`, which
it cannot replace. Hosts give result `_meta` to the App, not the model, so a
signed upload URL belongs there:

```ts
import { withResultMeta, type Tool } from "@aotter/mantle/mcp";

declare function signUpload(
  caller: unknown,
): Promise<{ id: string; url: string; headers: Record<string, string> }>;

const uploadTarget: Tool<unknown> = {
  name: "upload_target",
  surface: "public",
  description: "Prepare an upload.",
  closed: true,
  meta: { ui: { visibility: ["app"] } },
  inputSchema: { type: "object", additionalProperties: false },
  validate: (raw) => raw as Record<string, unknown>,
  run: async (_db, caller) => {
    const upload = await signUpload(caller);
    return withResultMeta(
      { id: upload.id },
      { uploadUrl: upload.url, requiredHeaders: upload.headers },
    );
  },
};
```

`run` also receives `{ apps }` after `handlers`: `apps` is true when the
`tools/call` request declares MCP Apps support and an App resource renders the
tool, so a tool can keep a secret in
the result `_meta` for an App and return it in the data for a client that has
none (`upload_media` does this with its targets). `callTool` and `callToolLazy`
take it as an optional last argument (default `{ apps: false }`).

`callTool` and `callToolLazy` return the wrapper itself, `{ data, _meta }`.
A caller that forwards a result to a model, such as an application's own agent,
must forward only `data` and drop `_meta`, or the signed URL leaks through that
path. A thrown error still produces the standard diagnostics result.

### Open an App from a host's entry point

Claude can list an App on its Artifacts page, so people open it without asking
for it, when one of its tools is marked as a global entry point: the tool's
`_meta` keeps `ui.resourceUri` and adds `"openai/ui": { entrypoints: [{ type: "global" }] }`.
That key is a host extension, outside the MCP Apps specification; other hosts may
ignore it. The host offers entry points only to some organizations and only for
remote Verified directory or custom connectors, so the App must still work when
it is opened from a conversation. Core adds no entry-point API: the generated
tools are plain objects, so give one of them `meta` before calling the generated
`mcp()`:

```ts
import { mcp, tools } from "./generated/mcp.js";

declare const db: (env: Env) => D1Database; // as in service composition
declare const caller: Parameters<typeof mcp>[0]["caller"];
declare function loadAppHtml(): string;

const entry = tools.find((tool) => tool.name === "my_tasks")!;
Object.assign(entry, {
  meta: { ...entry.meta, "openai/ui": { entrypoints: [{ type: "global" }] } },
});
const handler = mcp({
  db,
  caller,
  apps: {
    public: {
      resources: [
        {
          uri: "ui://my-tasks/build-1",
          name: "my-tasks",
          html: () => loadAppHtml(),
          renders: ["my_tasks"],
        },
      ],
    },
  },
});
```

Mark the tool in place rather than passing a copied array to the kernel `mcp()`
from `@aotter/mantle/mcp`: the generated `mcp()` also passes the access targets
that gateway pins and dry runs check, the manifest's access user fields, and the
read catalogue that lets a cookie-session read count as read-only, and a kernel
composition would have to supply each of them again.

`renders` still produces `ui.resourceUri`; the two keys merge. The mark is a
listing hint and grants nothing: every call of the tool still runs its
`requires`, scope and `authorize` decisions. A client that declares no MCP Apps support
sees the tool without `ui.resourceUri` and reads its result as text. The
[frontend example](../../examples/frontend-mcp-app/README.md) is tested this way.

The host's requirements for the marked tool are on Claude's
[entry points](https://claude.com/docs/connectors/building/mcp-apps/entry-points)
page; check them there. In short: every input optional, with a useful first
view for `{}` (a View tool's `limit` and `cursor` are optional, so a View with
no required input opens on its first page), and since the model may fill an
optional input, a value is no proof of the user's choice; `ui.visibility` omitted or
containing `"model"` (not an `appOnly` View); a `title` of at most 60
characters that leaves out Claude's and Anthropic's names; and a `name` with no
two underscores in a row, no two dots in a row and no dot next to an underscore.
Core derives a tool name from the manifest name, lower-cased with `-` turned
into `_`, and adds no prefix, so a manifest name can break the name rule:
`my--tasks`, `my_-tasks` and `my__tasks` all become `my__tasks`, and `a..b` and
`a._b` stay as they are. Rename such a View or Procedure before marking it.

## Package and application ownership

Core (`@aotter/mantle`) owns tools, resources, endpoint links and server authorization,
validation, scope and OCC. It has no React, DOM or Admin dependency. The optional
`@aotter/mantle-ui` owns reusable presentation and interaction controllers: pass it
data and invocation callbacks; it knows no MCP connection, cookie, role or Admin API.
`@aotter/mantle-admin` owns the Admin product, its existing hooks/surface transport
and the thin adapter to the pinned official ext-apps client. The official client
owns protocol negotiation, messages and connection lifecycle; the separate browser
source/origin guard is not a protocol implementation. That guard keeps the host's
origin after the handshake only when the App is framed; without a distinct parent
(`window.parent === window`, as in a native WebView) it pins nothing and leaves the
official transport's own checks. That unframed case is not yet confirmed on a mobile host.

Applications own domain components and build entries. A frontend MCP App uses its
own React entry, official ext-apps and optionally mantle-ui, registered through
Core's generic resources. It needs no Admin package or Admin session. Build it
with `App` from `@modelcontextprotocol/ext-apps`: register `ontoolinput`/`ontoolresult` before `connect()` and use
`callServerTool` for host-proxied calls; never write a second `postMessage` bridge beside the official client. See the
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
  adminMcpApps({
    catalogue: mcpAppCatalogues.admin,
    renders: ["pending_requests"],
  }),
  {
    resources: [
      {
        uri: "ui://my-app/details/build-2",
        name: "my-details",
        html: () => loadAppHtml(),
        renders: ["request_details"],
      },
    ],
  },
];
```

Register the array on `apps.admin`. Leaving Admin's default ownership of all Views
while another resource claims one is an error, independent of registration order.

`renders` names catalogue Views. To have the Admin App also render a Procedure's result, or
a tool of your own, list it in `tools`: `adminMcpApps({ catalogue, tools: ['approve_request'] })`.
The App shows the page that declares it (`pages: [{ ..., mcp: { renders: 'approve-request' } }]`
in `defineAdmin`), or the result's rows when it has any. The endpoint refuses a name it does
not serve.

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

Resource URIs are stable identities. The MCP Apps specification lets a host prefetch
and cache a UI resource by its URI, so by default Admin links its tools to the fixed
`ui://mantle-admin/admin`: after a deploy a host keeps the link it saved, and a new read
returns the new build. After the request passes the origin/identity/Admin gates, Admin
reads its built asset and also serves it at `ui://mantle-admin/admin/<digest>`, a hash of
the HTML, full static catalogue and material resource metadata, for conversations that
hold that URI. Workers cache only the raw asset and its identity per contributor and
ASSETS binding; caller-filtered catalogues are embedded per read. Bun rereads the file,
so a rebuild in the same process serves the new build. Run `mantle bundle` and deploy its
assets with the server; missing assets can fail discovery.

Change the URI only when saved conversations must not load the new App, because its
contract with its tools changed incompatibly: pass an explicit `uri` such as
`ui://mantle-admin/admin/v2`. A custom `html` function has no build identity to hash: it
is served at the fixed URI or an explicit `uri`.

### Keep old conversations working after an upgrade

With the fixed default, conversations keep rendering across deploys without retention.
A conversation that holds a content-hash URI from an earlier build (one started before
this default, or before an explicit `uri` change) needs that page
retained: a new URI does not invalidate a host's saved tool definitions or old
conversation cards. Keep previously deployed pages with `adminMcpApps({ catalogue, previous })`.
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
import { mcpAppCatalogues } from "../generated/admin-descriptors.ts";
export const appDefinition = { catalogue: mcpAppCatalogues.admin };
```

Keep a committed `mcp-app-previous.json` at the project root (initially `[]`). Load
it only inside the service's MCP branch, before constructing the handler, so other
routes do not parse archived full-page HTML at startup:

```ts
const { default: previous } = await import("../mcp-app-previous.json", {
  with: { type: "json" },
});
serveMcpHandler ??= serveMcp(tools, {
  ...options,
  apps: {
    admin: adminMcpApps({ ...appDefinition, previous }),
  },
});
```

Keep custom `renders`, catalogue extensions, `domain` and `title` in the shared
definition too. Node 22.18+ can read these generated `.ts` modules; a TypeScript
app using `.ts` import paths enables `allowImportingTsExtensions` with `noEmit`.
Keep snapshots outside the directory containing `admin.tsx`: Tailwind scans that
directory, and compiled HTML/JavaScript inside a snapshot can be mistaken for
utility class names and change subsequent CSS builds.

After a successful deployment, archive the **exact asset just deployed** with
this application-owned `scripts/archive-mcp-app.mjs`, then commit the snapshot
for the next build. Run it in the deployment script, not as a manual cache fix:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { resolveMcpApps } from "@aotter/mantle/mcp/apps";
import { adminMcpApps } from "@aotter/mantle-admin/mcp";
import { appDefinition } from "../src/mcp-app-definition.ts";

const path = "mcp-app-previous.json";
const previous = JSON.parse(readFileSync(path, "utf8"));
const context = {
  env: {},
  request: new Request("https://archive.invalid/mcp"),
};
const { resources } = await resolveMcpApps(
  adminMcpApps({
    ...appDefinition,
    html: readFileSync("dist/client/admin/mcp-app.html", "utf8"),
  }),
  context,
);
// The build's own content-hash URI (an explicit `uri` contributes only that URI).
const resource =
  resources.find((r) => /\/admin\/[a-f0-9]{64}$/.test(r.uri)) ?? resources[0];
const tools = new Set([
  ...Object.keys(appDefinition.catalogue.views),
  ...Object.keys(appDefinition.catalogue.actions),
]);
const page = await resource.html({ ...context, tools });
const snapshot = {
  uri: resource.uri,
  title: resource.title,
  ...page,
  ...(resource.domain === undefined ? {} : { domain: resource.domain }),
};
// This application's policy: retain the last two deployed pages for future builds.
writeFileSync(
  path,
  JSON.stringify(
    [...previous.filter((p) => p.uri !== snapshot.uri), snapshot].slice(-2),
  ) + "\n",
);
```

To observe every page as a host reads it (to audit reads, or to store the page a
deployment actually served), wrap the contributor. `resolveMcpApps` returns it in normal
form, so the wrapper needs no option on `adminMcpApps` and no shape checks:

```ts
import { resolveMcpApps } from "@aotter/mantle/mcp/apps";
import { adminMcpApps, type AdminMcpSnapshot } from "@aotter/mantle-admin/mcp";
import { appDefinition } from "./mcp-app-definition.ts";

declare const keep: (snapshot: AdminMcpSnapshot) => Promise<void>;

const admin = adminMcpApps(appDefinition);
export const observedAdmin = async (context: {
  env: unknown;
  request: Request;
}) => ({
  resources: (await resolveMcpApps(admin, context)).resources.map(
    (resource) => ({
      ...resource,
      html: async (render: Parameters<typeof resource.html>[0]) => {
        const page = await resource.html(render);
        await keep({
          uri: resource.uri,
          ...page,
          ...(resource.title === undefined ? {} : { title: resource.title }),
          ...(resource.domain === undefined ? {} : { domain: resource.domain }),
        });
        return page;
      },
    }),
  ),
});
```

Pass `observedAdmin` as `apps.admin`. A page read this way embeds the catalogue of the
caller who read it; keep it for `previous` only when that caller sees every tool, and
otherwise archive with the script above.

This archives static UI/catalogue metadata, never rows, cookies or OAuth tokens.
Custom loaders must archive their actual immutable resource, including CSP/domain,
instead of using this default-asset recipe. Compare the archived URI with deployed
`tools/list`/`resources/read`; a mismatching declaration or stale local build is
not deployment evidence.

Contributors are convenient to write and uniform to read. What you pass may be a static
`McpApps` or a function of `{ env, request }`, and a resource's `html` may be a string, a
loader, or a loader returning a string or `{ html, csp }`. What comes back is in one normal
form: `resolveMcpApps(sources, { env, request })` from `@aotter/mantle/mcp/apps` returns
`NormalMcpApps`, whose every `html` is an async loader resolving to `{ html, csp? }`. The
endpoint reads its Apps through the same function, and `adminMcpApps` and `mediaUploadCard`
return resources already in that form. Wrap a contributor by resolving it and returning
the changed resources; do not test for functions or strings yourself.

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

> **Verification status:** automated AppBridge coverage exists, but the compatibility claims in this section have not yet been verified manually in real ChatGPT or Claude hosts.

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
- When the host offers `downloadFile`, a View with rows shows "Export CSV". It
  saves the rows the App holds, "Load more" pages included, in the columns
  shown, as one `text/csv` resource named `<tool>.csv` through
  `ui/download-file`, laid out as Admin's browser export. It makes no server
  call. The person confirms the download in the host, so the App waits up to
  ten minutes. An error answer shows that the download did not finish (the
  host's answer does not tell a refusal from a cancellation). When no answer
  comes (a timeout, a lost connection) the host's dialog may still save the
  file, so the App says the download could not be confirmed, not that it
  failed. An answer without an error shows nothing: it says the host took the
  request, not that the file was saved.
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

### App tools: the model reads the open View

The App declares the `tools` capability (`{ listChanged: true }`) and registers
three tools of its own ("app tools"), which a host may let the model call while
the App is open. Host-to-App `tools/list` and `tools/call` are in the MCP Apps
draft specification, not in the stable `2026-01-26` text, which only names the
capability:

| Tool         | Input    | What it does                                                                                                                                 |
| ------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `view_state` | none     | Returns the View tool, its input, the ids of the rows the App holds, the row count and whether more rows exist, as JSON text.                |
| `view_more`  | none     | Does what "Load more" does: calls the same View tool with the same input and the next cursor, appends the rows, and answers as `view_state`. |
| `view_focus` | `{ id }` | Scrolls to the shown row with that id and highlights it.                                                                                     |

They are view-only. They read what the App already holds or make the same
read "Load more" makes, under the person's own authorization, so they show the
model nothing the person could not see in the App. No app tool writes, runs a
row action or Procedure, or leaves the View; writes stay server tools that the
model calls under the host's approval. While no View's rows are on screen
(waiting for a result, a `pages[].mcp` page, an open row action) every tool
answers that, and does nothing. A host may hand the model an error result
without its text, so whatever the model can act on is a normal answer that says
what was not done and what to call instead: no rows shown, an id `view_focus`
does not find, no next page, a page already loading, a list replaced while a
page loaded, a host without server tools. Only an unknown tool, a `view_state`
whose View input alone is over the limit and a page read that failed are
`isError` results. `view_more` gives up on its read after 40 seconds, inside
the 45 seconds Claude waits (other hosts may differ), so it answers instead of leaving the host to time
out. The definitions are fixed and marked `readOnlyHint`, and an answer is at most
100,000 characters: `view_state` lists as many ids as fit and adds
`truncated: true`.

Host support varies. Some hosts offer app tools only to some accounts or
surfaces, and some never call them. A host that does not is unaffected: it
sees the capability in `ui/initialize` and nothing else changes; the App sends
`notifications/tools/list_changed` only when a page registers or removes tools
of its own ([below](#a-pages-own-app-tools)), and a host that does not handle it
ignores it.

### A page's own app tools

A [`pages[].mcp` page](#a-page-for-an-mcp-app-view-pagesmcp), or any component it
renders, may register app tools of its own over the App's connection with
`useHost()?.registerTools(tools)`. Each tool is a name, a description, an
optional title and annotations, a plain JSON Schema `inputSchema` (no schema
library) and a `handler` the page supplies:

```tsx
function QueuePage() {
  const host = useHost();
  const [only, setOnly] = useState<string | null>(null);
  // registered while the page is shown; the returned function removes them on unmount
  useEffect(
    () =>
      host?.registerTools([
        {
          name: "queue_only",
          title: "Show one item",
          description:
            "Shows only the queue item with this name on the open Queue page.",
          inputSchema: {
            type: "object",
            properties: { item: { type: "string" } },
            required: ["item"],
          },
          annotations: { readOnlyHint: true },
          handler: ({ item }) => {
            if (typeof item !== "string" || !item)
              throw new Error("Name an item.");
            setOnly(item);
            return `Showing ${item}.`;
          },
        },
      ]),
    [host],
  );
  // …
}
```

- **What the App lists.** `tools/list` always starts with `view_state`,
  `view_more` and `view_focus`, so a host's approval of them holds; while a page
  is shown they answer, as a normal result, that no View's rows are on screen. The page's tools follow,
  by name, while they are registered. Back on a View, the list is the three again.
- **Lifecycle.** Each `registerTools` call adds its tools to those registered
  before, so the page and a component it renders can each register their own;
  the function it returns removes only that call's tools and aborts their
  handlers' `signal`. Return it from the `useEffect`, so the tools go with the
  component that registered them. A call is looked up when it arrives: a
  removed tool's handler is never called, and the host gets an error result.
  Each change of the listed definitions sends
  `notifications/tools/list_changed`; registering the same definitions again
  (an effect re-run, a new handler) sends nothing. Register again when what a
  handler reads changes, or have it read state through a ref.
- **Names.** Letters, digits, `.`, `_` and `-`, up to 128. `view_` names belong
  to the App, so a page's tool never collides with a built-in one;
  `registerTools` throws on such a name and on one already registered, by this
  call or another, and the tools registered before stay.
- **Results.** The handler returns the text the model reads. A throw is an
  `isError` result carrying its message, but a host may not pass the message to
  the model; for a mistake the model can fix, return a normal answer that says
  what to change. The App does not check arguments against `inputSchema`: the
  handler does. `signal` aborts when the host cancels the call or the tool is
  removed.
- **Limits.** `registerTools` throws when, with the App's own three and those
  already registered, the tools break a limit Claude documents: at most 64 tools, 1 MiB of definitions as
  JSON, an `inputSchema` with `type: "object"` at its root, at most 64 KiB and 32
  levels deep. A host reads 100,000 characters of result text and waits 45
  seconds, not counting the person's approval: keep answers short, and start
  longer work and report it from a second tool.
- **Keep definitions constant.** A host may ask the person to approve a tool
  again when its name, title, description or input schema changes. Put what
  changes in the result.
- **View-layer only.** A handler runs the page's own code in the App. Anything
  it does on the server goes through the page's hooks (`useView`,
  `useOperation`), as the signed-in caller and under the host's server-tool
  rules; it is not a way around them, and the host's approval of the app tool
  is not the server's authorization.

A frontend App that is not Admin's (your own `ui://` entry) uses the official
`@modelcontextprotocol/ext-apps` `App` directly: `app.registerTool` with a
schema library, or `onlisttools` and `oncalltool` with your own JSON Schema.

Checks against real hosts need an account and a public HTTPS endpoint, so
they are manual: add the endpoint as a custom connector in each host, call a
View tool with an App, and check light and dark themes, a narrow window,
full screen, a row action, and a link. Check too that the host advertises
`hostCapabilities.serverTools`; without it the App is read-only. The automated interoperability test
uses the official `AppBridge`; your app runs its generated version ([Run the compatibility test](#run-the-compatibility-test)).

## The upload card

`upload_media` on `/mcp/admin` can open an upload card, an MCP App Admin ships
prebuilt. Register it beside the Admin App, with the same `media` function you
pass `mcp(...)`:

```ts
import { adminMcpApps, mediaUploadCard } from "@aotter/mantle-admin/mcp";
import type { MediaStorage } from "@aotter/mantle/site";
import { mcp } from "./generated/mcp.js";
import { mcpAppCatalogues } from "./generated/admin-descriptors.js";

declare const options: Parameters<typeof mcp>[0];
declare function storage(env: unknown): MediaStorage; // e.g. r2MediaStorage(...)

const handler = mcp({
  ...options,
  media: storage,
  apps: {
    admin: [
      adminMcpApps({ catalogue: mcpAppCatalogues.admin }),
      mediaUploadCard({ media: storage }),
    ],
  },
});
```

The card is `ui://mantle-admin/upload` and renders `upload_media`. The person
picks an image (and may type alt text); the card reads the purposes with
`upload_media`, calls it with the file's metadata, PUTs the file straight to the
target with progress, calls `upload_media` again with the `uploadId`, and sends
`ui/message` with the asset id, and also `ui/update-model-context` unless the
host accepted the message. The bytes never pass through MCP or the host. The card uploads the
original file as the single variant a purpose takes
([ADR-0017](../../adr/0017-media-multi-variant-agent-side-optimization.md)); a
purpose with several variant slots needs an agent that prepares them, and the
card says so. It needs the host's `serverTools`. It shows no View, so it declares
no `tools` capability and lists none of the App's `view_*` tools.

A host that serves several servers' media under one endpoint registers one card
per server with its own `uri`, a `tool` it names itself (taking `upload_media`'s
arguments) and `forward`, the input arguments the card repeats on every call:
`mediaUploadCard({ media, uri: "ui://mantle-admin/upload/shop", tool: "open_upload", forward: ["server"] })`.

The targets reach the card in the result `_meta` (`net.aotter.mantle/upload`)
when the request declares MCP Apps support and the card is registered;
otherwise they are in the result,
for an agent that PUTs them itself. The card reads either.

On `resources/read` the card declares the storage origin as
`_meta.ui.csp.connectDomains`. It is the storage's `uploadOrigin`:
`r2MediaStorage` sets it to the origin of its `endpoint`; a custom
`MediaStorage` sets it to the origin its `uploadUrl`s PUT to. Without it the
read fails with a logged error.

The bucket must answer the card's CORS preflight. Allow `PUT` with the
`Content-Type` header from the origin the host serves Apps from, and key the
rule on `Origin`: the request carries no cookies, and some clients (iOS) send no
`Referer`. A sandboxed frame without its own origin sends `Origin: null`. For
example, as R2 CORS JSON:

```json
[
  {
    "AllowedOrigins": ["https://your-host-sandbox.example"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

Use the sandbox origin each host documents for its Apps (a host that honours
`_meta.ui.domain` serves the App from that origin; `mediaUploadCard` passes
`domain` through).

## Customising Admin for MCP hosts

`mantle bundle` builds the Admin MCP App from the same entry as the browser Admin
(`src/admin.tsx`, or the built-in one) into one self-contained file,
`<assets>/admin/mcp-app.html`, which `adminMcpApps` serves as
`ui://mantle-admin/admin` by default. Shared View cells and opted-in pages reach the host, with application plugins,
Tailwind classes and CSS. Browser-only record/input overrides do not mount there.

### Which slots render where

| Slot                                                                                                                | Browser | MCP host                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `Shell`, `Sidebar`, `Header`, `Brand`, `Home`, `CollectionList`, `SignIn`, `list.actions:<schema>`                  | yes     | never: the App has no shell, sidebar or router                                                            |
| `cell:view:<view>.<column>`                                                                                         | yes     | yes: each column of the rows the host's View tool returned                                                |
| `cell:<schema>.<field>`, `input:<schema>.<field>`, `record.aside:<schema>`, `record.actions:<schema>`, `RecordView` | yes     | never: browser-only record/collection slots; their `surface` is `"browser"` (`mantle bundle` reminds you) |
| `pages[]`, `nav`, `home`, nav badges                                                                                | yes     | only a page that declares `mcp` (below)                                                                   |

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
  return (
    <>
      <button
        disabled={!run || pending}
        onClick={() => {
          void run?.({ id }).then(
            () => setMessage("Done"),
            () => setMessage("Not available"),
          );
        }}
      >
        Approve
      </button>
      <p role="status">{message}</p>
    </>
  );
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
   `<AdminLink>` shows it as text. `useOpenLink()` resolves `false` when the
   host cannot or refuses, or does not answer in time; a link the person
   confirms late can still open.
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
6. **Read a message's outcome as the host gives it.** `useHost()?.sendMessage(text)`
   sends `ui/message` when the person acts, and resolves to one of three
   outcomes. `"accepted"`: the host answered without an error, which is not
   proof of delivery (a host may answer before the person agrees to send it).
   `"refused"`: the host answered with an error or offers no messages, so it was
   not sent. `"unknown"`: no answer came (a timeout, a lost connection); the host
   may still deliver it, so do not say it failed or resend it in code, and keep
   the control usable for the person to try again. The text is kept within what
   Claude documents it accepts: invisible characters such as soft hyphens and
   zero-width spaces are dropped (zero-width joiners and variation selectors,
   which emoji and scripts use, stay), and runs of more than three line breaks
   (a `\r\n` counts as one) or 64 spaces or tabs are shortened. A blank text
   (nothing visible, joiners and selectors included), or one over 8,000
   characters after that, is `"refused"` without asking the host; it is never
   cut, so shorten a long message yourself.
7. **Downloads through the host.** The sandbox starts no download from
   `<a download>`, `blob:` or `data:` URLs. When `useHost()?.capabilities.downloadFile`
   is set, `useHost().downloadFile(name, text, mimeType)` asks the host to save a
   text file named `name` (with its extension; the type defaults to
   `text/plain`) after the person confirms it. The name is the last segment of a
   `file:///` URI: spaces stay, and `/`, `?`, `#`, which would change that
   segment, and `%`, `:`, `"`, `*`, `<`, `>`, `|`, `~`, `\`, which Claude
   replaces anyway, become `_`; an empty name, `.` or `..` is `"refused"`. It
   resolves to the same three outcomes: `"refused"` covers a refusal, a
   cancellation and a host that offers no downloads; `"unknown"` means the host's dialog may still save the file.
   Send one when the person asks, and one at a time. Hosts refuse some
   extensions, such as `.exe` or `.js`.

### Theme

The App's colours come from three layers, later over earlier:

1. Admin's default tokens (`@aotter/mantle-ui/tokens.css`: the shadcn variables
   `--background`, `--primary`, `--chart-1` and the rest).
2. Your own CSS, which your entry imports: your `--primary` or `.dark {}`
   overrides apply in the App as they do in the browser Admin.
3. The host's style variables, for neutral colours, radii, text sizes and the
   font only, laid over the tokens. The table lists, for each host variable the
   App reads, the Tailwind theme variable it feeds.

| Host variable                  | App theme variable                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--color-background-primary`   | `--color-background`, `--color-card`, `--color-popover`                                                                                    |
| `--color-text-primary`         | `--color-foreground`, `--color-card-foreground`, `--color-popover-foreground`, `--color-secondary-foreground`, `--color-accent-foreground` |
| `--color-background-secondary` | `--color-muted`, `--color-secondary`, `--color-accent`                                                                                     |
| `--color-text-secondary`       | `--color-muted-foreground`                                                                                                                 |
| `--color-border-primary`       | `--color-border`, `--color-input`                                                                                                          |
| `--color-ring-primary`         | `--color-ring`                                                                                                                             |
| `--color-text-danger`          | `--color-destructive`                                                                                                                      |
| `--border-radius-sm`           | `--radius-sm`                                                                                                                              |
| `--border-radius-md`           | `--radius-md`                                                                                                                              |
| `--border-radius-lg`           | `--radius-lg`                                                                                                                              |
| `--font-text-xs-size`          | `--text-xs`                                                                                                                                |
| `--font-text-xs-line-height`   | `--text-xs--line-height`                                                                                                                   |
| `--font-text-sm-size`          | `--text-sm`                                                                                                                                |
| `--font-text-sm-line-height`   | `--text-sm--line-height`                                                                                                                   |
| `--font-text-md-size`          | `--text-base`                                                                                                                              |
| `--font-text-md-line-height`   | `--text-base--line-height`                                                                                                                 |
| `--font-sans`                  | `--font-app` (the App's font)                                                                                                              |

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
  pages: [
    {
      path: "queue",
      title: "Queue",
      element: <QueuePage />,
      header: {
        description: "Items awaiting review",
        actions: <QueueActions />,
      },
      mcp: { renders: "pending-requests" },
    },
  ],
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
  pages: [
    {
      path: "queue",
      title: "Queue",
      element: <QueuePage />,
      mcp: { renders: "queue" },
    },
  ],
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
  pages: [
    ...shared.pages,
    {
      path: "browser-report",
      title: "Browser report",
      element: <BrowserReport />,
    },
  ],
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
