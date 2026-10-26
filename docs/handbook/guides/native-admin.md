# Native Admin

Select Admin explicitly; use the exact installed SDK/Admin versions.

## Packages and generation

There are three packages, pinned to matching versions:

| Package | Owns |
| --- | --- |
| `@aotter/mantle` | One native Core SDK: compiler, generator, query kernel and optional auth/surface primitives. |
| `@aotter/mantle-admin` | Optional Admin server, the library an application builds its Admin SPA and MCP App from, design preview and `adminMcpApps`. |
| `@aotter/mantle-ui` | Shared UI kit and generic interaction controller. |

The SDK does not import Admin or its assets. Selecting Admin emits application
code that imports its small public server helpers. The SPA retains all 22
languages, rich editors and the developer workspace; language, editor and
workspace chunks load on demand. It is not part of the SDK query bundle.

Select Admin explicitly:

```sh
pnpm exec mantle generate cloudflare-d1 generated manifests/*.yaml --admin
pnpm exec tsc --noEmit
```

Targets are `bun-sqlite`, `bun-postgres`, `cloudflare-d1` and
`cloudflare-postgres`. Programmatic generation accepts `admin: true` with the
same target/source options. Optional `--auth` and `--site`
modules follow their [generation contracts](../cloudflare/service-entry.md).
Generate, typecheck, implement every printed `Handlers` key, then typecheck
again. Commit generated TypeScript, SQL and Wrangler edits. Never edit the
output by hand; regenerate after merging authored inputs. Use the matching
CLI's `--check` with the same selected options in CI.

Apply initial `schema.sql` and selected auth/site DDL only during explicit
setup of a new database. Existing data needs reviewed migrations. Imports and
metadata factories do no storage work. Requests run no DDL or storage checks;
the only request-time write outside app operations is the configured OAuth
resource row (see [OAuth](oauth.md)).

## Mount the API and console

```ts
import { admin } from '@aotter/mantle-admin/server';
import { entries } from '@aotter/mantle-admin/server/entries';
import { adminBindings } from './generated/admin-bindings.js';
import { handlers } from './handlers.js';
import { resolveRequestCaller } from './identity.js'; // application-owned

const bindings = adminBindings({ handlers });
const api = admin(bindings.metadata, bindings.views, bindings.operations, {
  db: (env: Env) => env.DB,
  caller: resolveRequestCaller,
  routes: entries(bindings.schemas, bindings.adapter),
  developerViews: bindings.developerViews,
});
// In app-owned fetch: await api(request, env); undefined means fall through.
```

Ref operations run with the handlers given to `adminBindings({ handlers })`; `admin()` needs no second copy. Without ref Procedures, omit `handlers` and use `adminBindings()`. The app's
resolver verifies the caller; Admin accepts an admin cookie session classified from
Better Auth’s admin plugin `adminRoles` (default `["admin"]`), and cookie writes
retain the shared same-origin check. Comma-separated roles are supported.
Do not manufacture an admin/system Caller from request input. Views and operations
also retain their own generated `requires` checks. Share one request-local
resolver with auth, consent, MCP and REST; preserve its response cookie headers.

The API handles `/admin/api/*`. The app separately serves the Admin that
`mantle bundle` builds into `<assets>/admin` (default `dist/client/admin`, on Workers
and on Bun, where it builds only Admin) at `/admin`, including
client routes such as `/admin/sign-in`; missing assets stay 404. Do not serve
that directory bare: `adminShell(request, assets)` from
`@aotter/mantle-admin/server` returns the shell for every `/admin` page with
`frame-ancestors 'none'`, `X-Frame-Options: DENY`, `no-store` and `nosniff`, and
refuses traversal, encoded separators and control characters (`assets` fetches one built file
by its path within that directory; a 404 means missing; it returns `undefined` for other requests). `@aotter/mantle-ui` continues to supply the shared kit. See
[service composition](../cloudflare/service-entry.md) for the complete Fetch/Bun wiring.

Browser pages: a collection at `/admin/c/<schema>`, an admin View at `/admin/views/<view>` (its input as query parameters), a custom page at `/admin/p/<path>`.

## HTTP routes

All paths below start with `/admin/api` and require an admin session; mutations
also require the shared same-origin check. Mount `entries(...)` for collection
routes. Send JSON with `Content-Type: application/json`.

These routes serve Admin's console with its session cookie; they are not a client API. A REST client reads back what it
wrote through the app's own Views with HTTP Triggers (`mantle help trigger`).

| Method and path | Request / response |
| --- | --- |
| `POST /entries` | Body `{ collection, data }`; creates an entry. |
| `GET /entries/{id}?collection=<schema>` | Reads an entry and its current `entry.version`. |
| `PATCH /entries/{id}?collection=<schema>` | Body `{ data, expectedVersion }`; sends the observed version, not the next one. Publishing entries must be drafts. |
| `POST /entries/{id}/publish?collection=<schema>` | Body `{ expectedVersion }`; validates required data before publishing. |
| `POST /entries/{id}/unpublish?collection=<schema>` | Body `{ expectedVersion }`; returns the entry to draft. |
| `POST /operations/{name}` | Body is the Procedure's input; runs an Admin operation (a Procedure with `requires: ctx.admin` or a `target`). Returns `{ ok: true, output }`, where `output` is what REST and MCP return (`{ results }` for a SQL Procedure). |
| `GET /views/{name}` | Generated admin View query parameters plus `limit`/`cursor`; returns `{ rows, nextCursor? }`. |
| `GET /view-batch?names=a,b` | One to 20 comma-separated admin View names, deduplicated; reads the first row of each as the caller, with the single route's checks (`requires`, scope, TTL, `authorize`), and returns `{ views: { <name>: { rows } \| { unavailable: true } \| { error: true } } }`. A refused View and a missing one are the same `{ unavailable: true }`; a View that cannot answer with no input is `{ error: true }`. Neither fails the batch. Empty or more than 20 names is a 400, before the database is acquired. |
| `GET /me` | Returns `{ userId, role, admin, login, image }` for the signed-in caller. |
| `GET /admin` | Administrators and pending invitations, plus `adminRoles` (mounted with `identity`). |
| `GET /members?search=&limit=&cursor=&direction=` | Pages members (1–100), searching id, name and email. |
| `PATCH /admin/{id}/role` | Body `{ role }`: an admin role name grants Admin, `null` removes it. You cannot change your own role. |
| `POST /admin/invitations` | Body `{ email, role }`; invites an administrator by email. Returns `{ ok, userId, emailSent }`. |
| `DELETE /admin/invitations/{id}` | Revokes an invitation nobody has signed in to yet (otherwise 409). |

Entry create/read/patch/transitions return
`{ collection, entry, parentEntryId, parentEntryTitle, related }`; the entry has
`{ id, collection, locale, status, version, data, created_at, updated_at }`.
Transitions accept `{}` to use the current version; tests should send the
observed `expectedVersion` to catch stale writes. Generic writes reject native
columns inside `data`. See [publishing](../concepts/lifecycle-and-locales.md).

## Typed data hooks

`--admin` emits `generated/admin-client.ts`: the type of each admin View's input and row, of each collection's entry
`data` (declared field names, no scope field; every field optional for a `publishing` collection, as a draft is only partly
validated), and of each admin operation's input and output, and the hooks bound to those types. A View's row has the column
names the browser route gives it (declared case, where the SQL output name is lowercased). An entry such as `src/admin.tsx`
passes `admin`, which lists those renames, to `defineAdmin(admin)` so that an MCP App's rows match, and its components read
data through the hooks:

```tsx
import { useOperation, useView } from "../generated/admin-client.js";

function Queue() {
  const { rows, status, hasMore, loadMore, loadingMore } = useView("pending-requests", {});   // names, input and rows are checked by tsc
  const approve = useOperation("approve");
  if (status === "unavailable") return null;
  return (
    <>
      {rows.map(row => <button key={String(row.id)} onClick={() => approve.run?.({ id: String(row.id) })}>{row.title}</button>)}
      {hasMore ? <button disabled={loadingMore} onClick={loadMore}>Load more</button> : null}
    </>
  );
}
```

The hooks read only the routes above, with the Admin session cookie and Admin's own query cache, so every route still checks
the caller, `requires`, scope and TTL; a hook has no caller, role or system argument. A 403 and a 404 both read as
`status: "unavailable"` (an operation's `run` rejects with `AdminUnavailableError`), so the front end cannot tell a
refused View or collection from a missing one. Showing or hiding a component grants or denies nothing.

| Hook | Route | Surface |
| --- | --- | --- |
| `useView(name, input, { limit? })` -> `{ rows, status, hasMore, loadMore, loadingMore }` | `GET /views/{name}` | browser and MCP App |
| `useOperation(name)` -> `{ run, pending }`; success refreshes Views, entries, entry editors and totals | `POST /operations/{name}` | browser and MCP App |
| `useEntries(collection, { filter?, search?, limit? })` -> `{ items, status, hasMore, loadMore, loadingMore }` | `GET /entries` (one `filter_field`/`filter_value`) | browser only |
| `useEntry(collection, id)` | `GET /entries/{id}` | browser only |
| `useCollectionTotal(collection)` | `GET /collections/{name}/statistics`, its `total` | browser only |
| `useMe()` | `GET /me` | browser only |
| `useBadges(refs)` -> one `{ count, status }` per `{ view, field }`, in order; [freshness below](#sidebar-badges) | `GET /view-batch` | browser only |

`useView` and `useEntries` accumulate: `rows` (`items`) holds every page loaded so far, in order, and `loadMore()` fetches the next
page and appends it while `hasMore` is true. There are no page numbers and no "previous page"; changing the input (or the
options) starts again from the first page. A failed `loadMore()` leaves `status` at `error` with the rows already loaded kept, and
calling `loadMore()` again retries. Admin's own lists work the same way, under a "Load more" button, and so does the MCP App, which
shows the button only when the host has `serverTools` (it calls the View's tool again with the same input and the `cursor`).

In an MCP host, `useView` and `useOperation` call the View's or operation's admin MCP tool (its name lowercased, kebab to snake) through the host (`tools/call`),
under the caller's MCP authorization; the browser-only hooks read `unavailable` there, so declare the data an App needs as an
admin View. Without the host's `serverTools`, `run` is `undefined`. `useHost()` is `null` in the browser and the host's API
(context, capabilities, `openLink`, `sendMessage`, `updateModelContext`, `requestDisplayMode`) in a host; `useAdminSurface()`
says which. `@aotter/mantle-admin/hooks` also exports the same hooks untyped, for code without generated types.

`@aotter/mantle-admin/app` and `/hooks`, and so `generated/admin-client.ts`, which imports them, run in the browser only:
`mantle bundle` refuses them in the Worker's startup graph.

## Customising Admin

An application replaces or wraps regions of Admin from `src/admin.tsx`. The entry passes the generated metadata and, beside it,
what to change; the built-in entry needs none of this.

If browser-only integrations need APIs that an MCP host forbids, keep their implementations outside the host graph: add a sibling `src/admin.mcp.tsx`, also default-exporting `defineAdmin(...)`, and share the host-safe config and components between the two entries. `mantle bundle` selects it automatically for the MCP asset; the SPA and preview still use `admin.tsx`. The direct build API accepts `mcpEntry`. See [isolate browser-only integrations](mcp-apps.md#isolate-browser-only-integrations).

```tsx
import { defineAdmin } from "@aotter/mantle-admin/app";
import { admin } from "../generated/admin-client.js";

export default defineAdmin(admin, {
  pages: [{ path: "budget", title: "Budget", element: <BudgetPage />, nav: { group: "reports" } }],
  components: {
    // wrap: the built-in page below your own section
    Home: (props) => <><MyQueue />{props.renderDefault(props)}</>,
    // change a prop: the sidebar with a footer
    Sidebar: (props) => props.renderDefault({ ...props, footer: <HelpLink /> }),
    // replace: one value in the requests list, and the control of one field in its record form
    "cell:requests.amount": ({ value }) => <Money cents={value} />,
    "input:products.color": ({ value, onChange }) => <ColorPicker value={value} onChange={onChange} />,
    "record.aside:requests": ({ entry }) => <RequestTimeline id={entry.id} />,
  },
  plugins: [auditTrail()],
});
```

Every component receives the props of the built-in one and `renderDefault(props)`, which renders what it replaces: pass the
props you were given (spread them to change some), or ignore it to replace the region. A slot is named by a key that `tsc`
derives from the generated metadata, so a misspelt collection, field or View column is a type error. In a key `<schema>` is a
collection's name, `<field>` one of its fields and `<column>` a column of an admin View (names contain no `.`).

| Slot | Surface | Props (besides `renderDefault`) |
| --- | --- | --- |
| `Shell` | browser | `children`, `nav` (sidebar groups), `brand` |
| `Sidebar` | browser | `groups`, `brand`, `footer?` (above the signed-in user) |
| `Header` | browser | `title?`, `actions?` (before the built-in controls) |
| `Brand` | browser | `title`, `image?`, `href?` |
| `Home` | browser | `collections`, `site` (what the page shows; the built-in page loads its own data) |
| `CollectionList` | browser | `collection` (filters come from the page's location) |
| `RecordView` | browser | `collection`, `entryId`, `surface` |
| `record.aside:<schema>` | browser | `collection`, `entry`, `surface` |
| `record.actions:<schema>` | browser | `collection`, `entry`, `surface` |
| `list.actions:<schema>` | browser | `collection`, `selection` (empty in the toolbar, the selected ids in the bulk bar) |
| `cell:<schema>.<field>` | browser | `value`, `row` (the list's columns only, `null` when empty), `property`, `surface` |
| `cell:view:<view>.<column>` | both | `value`, `row`, `property`, `surface` |
| `input:<schema>.<field>` | browser | `value`, `onChange`, `readOnly`, `property`, `surface` |

`record.aside:` and `record.actions:` render beside Admin's own side cards and actions, which they do not replace. A
record form's top-level fields go through `input:`; a View's parameters and a Procedure's inputs do not. A field the Schema
does not require is `T | null` in the generated types, and so is every field of a publishing collection, whose draft may lack a
required one: it reads `null` when unset, and `onChange(null)` clears it (Save sends `null`, which the entry PATCH stores as
NULL; a field left out keeps its value). The built-in controls clear the same way, and an emptied required field is `null` too:
an operational record refuses it with a validation error, and a draft keeps it empty until Publish, which refuses it. A read-only field
(a bound or `readOnly` property) has no `input:` component, and `readOnly` tells yours that the caller cannot edit the
record. In the browser Admin, a View column that reads a Schema field also goes through that field's `cell:` component, with the column's own
`cell:view:` component outside it; the MCP App renders only `cell:view:`. The developer workspace (`/admin/dev`) is Admin's own tool and does not go through any slot. A record with folded child collections opens on a workbench at `/admin/c/<schema>/<id>`, which is not `RecordView`; the record form (and so `RecordView`, `record.aside:`, `record.actions:` and `input:`) is its `/edit` page. A `Shell` that does not call `renderDefault` has no status bar: the record form's Save and Publish bar then stays in the page.

`plugins` are fragments of `components`, applied in order: each one's `renderDefault` is the plugin before it, the first
plugin's is the built-in component, and the application's own `components` are outermost. A plugin is
`{ components: { ... } }`, so one can be written once and shared.

`mcp: { csp: { connectDomains, resourceDomains, frameDomains, baseUriDomains } }` names the remote origins Admin's MCP App may
load. `mantle bundle` builds that App from this same entry (`<assets>/admin/mcp-app.html`) and fails it on an origin that is not
declared. The build writes the declaration into the file, and `adminMcpApps` sends it to the host as `_meta.ui.csp` on `resources/read`.
A page may also be an MCP App view: `pages: [{ path, title, element, mcp: { renders: "<view>" } }]`, where `renders` is an admin
View that has an MCP tool (`tsc` checks it against the generated `admin-client.ts`).

Authorization is unchanged by any of this. A component that shows or hides something grants or denies nothing; the server
checks every route, View and Procedure.

### Components that also render in an MCP host

Record/collection slots carry `surface: "browser"` and do not mount in an MCP
Procedure action form. A slot marked both renders in Admin's browser page and in an MCP host (`surface` is `"browser"` or `"mcp-app"`). A component
for one of these slots must:

1. read and write data only through the hooks, not `fetch`, and keep no login state in `document.cookie` or `localStorage`;
2. link with `<AdminLink href>` or open URLs with `useOpenLink()` (from `@aotter/mantle-admin/app` and `/hooks`),
   never `window.open` or `target="_blank"`, which a host's sandbox blocks. In a host `<AdminLink>` opens an http(s) URL
   through `ui/open-link` and shows any other href, such as an `/admin/...` path, as plain text, as it has no origin there;
3. assume no width: a host sets it;
4. render something on both surfaces when it branches on `surface` or `useAdminSurface()`.

`useOpenLink()` resolves `false` for anything but an http(s) URL, and when a host cannot or refuses to open it.

`mantle bundle` enforces 1 and 2 on the built App (no `/admin/api`, no `document.cookie`, no undeclared remote origin; `window.open`
and `target="_blank"` warn), and your CSS and Tailwind classes reach the App. The surface table, the theme mapping and the full
rules are in [Customising Admin for MCP hosts](mcp-apps.md#customising-admin-for-mcp-hosts).

### Hot reload while you work on `src/admin.tsx`

By default `wrangler dev` rebuilds Admin with `mantle bundle` when its sources change; reload the page. For hot module
replacement, add a Vite config yourself; nothing in a template enables it:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { adminVitePlugin } from "@aotter/mantle-admin/build";
export default defineConfig({ plugins: [adminVitePlugin({ entry: "src/admin.tsx" })] });
```

Run `vite` beside `wrangler dev` and open `http://localhost:5173/admin/`. The plugin proxies `/admin/api` and `/api/auth` to
`http://localhost:8787` (`target` changes it; `authBasePath` names the auth path when the service's is not `/api/auth`). The proxy keeps
the dev server's `Host`, so the browser's `Origin` and the service's own origin agree and session writes pass the same-origin check.
The service may still need to trust `http://localhost:5173` as an auth origin for sign-in.

## Generated reads and writes

`adminBindings()` returns static metadata, schemas, views, operations and the
selected native adapter. Metadata-only endpoints add no storage read of their
own; authentication, optional user enrichment or site loading may still query.
The shared get/page/statistics functions select quoted tables and columns only
from generated whitelists. Search/filter/cursor/range values are binds, never
SQL identifiers. Core compiles scope, TTL, publishing and parent predicates;
there is no request-time manifest/schema/SQL AST interpreter.

Scoped rows remain private even from other admin. Translation reads merge at
most one visible parent with the matching join key; scoped parents correlate
scope in every mode, including trusted reads. Child declarations win over parent
fields, and a parent's public same-named field cannot replace a child's private
scope. Unrelated scoped Schemas cannot hide an ordinary public field. Scope and
storage-only fields are absent from entry data and generated CSV export fields.
Geo remains experimental: existing native outputs are readable, not generically
editable. Metadata derives child relationships from `allCollections`.

Entry queries validate indexed sort fields, directions, filters and limits
1–500. `filter_field` and JSON `filter_values` are paired; each batch has at most
50 scalar values. Search reuses native SQLite/D1 FTS and PostgreSQL behavior.
Pages keep native NULL ordering, id ties, microsecond timestamp keys and an
opaque cursor bound to caller, input, filters and ordering. Malformed/foreign
cursors and unknown selectors fail before acquiring the route's DB handle;
the app's authentication may already have used its own database. Admin manifest
Views retain their complete proved key tuple, not a two-key approximation. A View without a key is accepted only as a proved
singleton, such as an aggregate without `GROUP BY` (`SELECT COUNT(*) AS count FROM requests WHERE status = 'submitted'`): it
returns its one row on one page and has no cursor.

Generated full/partial input checks validate creates, edits, operations and
filters. Plain titled string `oneOf` choices use the same enum checks; general
or constrained alternatives remain refused. Draft creates can be incomplete;
publish checks required data. Publishing edits apply only to drafts. Read-only
collections refuse generic creates, edits, deletes and transitions with 403 `AUTH_DENIED`
("This record is read-only; use its operations.") before any read or write, while
their declared Procedures can still run.

Writes use compiler-printed native Procedure frames, bind recipes and only the
supplied field fragments. They do not update omitted columns or run a schema
interpreter. PATCH retains its visible-row read and exact OCC check; the mutation
returns its row. Missing/excluded rows are 404; stale locks or failed state guards
are 409. Safe versions are numbers; exact native int64 strings can be bound
without rounding, while unsafe numbers are rejected. The console keeps versions
outside its supported safe range read-only rather than casting them to numbers.
Full cross-target int64 output parity remains incomplete; bare driver values
are unchanged.

Publishing/custom Admin operations load existing generated Procedure modules
when invoked. Ref handlers retain the original typed `{ caller, db, store }`
context and authorization. Ordinary SDK/REST/MCP emission and the synchronous
public Store API are unchanged. Selected JSON boundaries preserve declared JSON/boolean conversions and safe
cross-target integer normalization from SQL text; exact unsafe values are not rounded. Bare
Views, Store and SQL Procedures keep their driver-native contract. Native
unique/OCC errors and uncertain transaction outcomes keep their contracts. A 503 outcome may mean a write committed: do not
retry automatically or turn it into a success by reading afterward. Core
`statusOf` maps core codes only. App media/site/partial errors use `mediaError`
from `@aotter/mantle/media`; other custom ContractErrors must carry an explicit
status, otherwise the boundary returns a redacted 500. Do not leak native
error messages, tokens or credentials to clients.

## Statistics

`GET /admin/api/collections/{name}/statistics?range=7d` supports primary or
standalone collections; folded children/translations are not primary routes.
Ranges are `1h`, `24h`, `7d` (default) and `20d`. It returns
`{ total, buckets, from, to, bucketMs }` in one native aggregate query. `total`
counts currently caller-visible retained rows, including rows outside the
requested window; expired rows are excluded. Buckets use `[from, to)` and the
same generated scope/TTL/parent policy. The shared native function accepts at
most 20 days and 480 buckets, with safe microsecond arithmetic. Temporal enum
subtypes return original metadata keys; equivalent offset spellings count once
under the first key, and separate microseconds remain distinct.

Site/media/identity, WebMCP, design preview and MCP Apps are selected
through the public Admin modules, not added to the SDK kernel. A route with
`rawBody` receives the original Request without pre-reading, cloning or
rebuilding it; its custom `bodyLimit` checks Content-Length before DB access,
and the app must bound reads of unknown-length raw streams. Built-in JSON routes use the shared bounded reader
(default 1,000,000 bytes) after caller/origin checks and before DB acquisition.
The API advertises capabilities for actually mounted routes, including statistics.

## Acceptance

Before reporting Admin pages or customisations as done, follow the [independent
acceptance guide](agent-workflow-acceptance.md) with a fresh evaluator in the
real Admin browser session.

Use a disposable database for native tests, then exercise actual OTP sign-in,
the Admin console and member frontend. Check invalid input, another tenant's
rows, expired rows, publishing transitions, related/translated entries, paging,
statistics, CSV, operations/ref effects, stale OCC and persisted state after a
restart. Recheck custom components, previews, all supported UI languages and the
complete developer workspace. A generated file, typecheck or HTTP 200 alone
does not verify these flows.

Native adapter evidence covers all four targets; local D1 uses real workerd.
Initial Admin module imports perform no DB work. Startup graphs, uploaded total,
SDK package bytes and query/write/cold timing are separate checks. Extra selected
Admin indexes add write/storage maintenance; an indexed SELECT plan does not
prove unchanged write latency. Report remaining gates honestly; this guide does not promise measured performance.

Entry lists and editor reads/writes return translation badges and related
sections in one authorized HTTP response.
Reference fields show titles, not only IDs: a list of an operational collection (for its `list.columns`) and an entry
read return `ref_titles` / `refTitles`, the title of each record that a displayed `x-mantle-ref` field points at, keyed by
field and stored value. The server resolves them for the caller with one page query per referenced collection and field
(at most 50 distinct values), exactly as the parent entry's title is resolved, so visibility and `authorize` apply to the
target. A missing, deleted or unreadable target is absent, so the three look the same: Admin shows the exact ID with copy.
A resolved title links to the related record. Admin Views and the MCP App have no such step, since their rows come from the
View itself; a View that wants a title selects it (join the referenced table, within its own `requires`). `/bootstrap?collection=...` can include
the first requested list page.
In the entry editor and every operation form (including a `collectionAction` create), a string field with
`x-mantle-ref` to another Admin collection is a searchable picker: it lists the target through the same `/entries` route
(20 records per search, read as the caller), shows each record's title and stores the referenced value (`id`, or the
ref's unique field). A target the caller cannot list (403/404) or that is not an Admin collection keeps the plain text
input. The picker is a convenience; the server still validates the value. CSV exports use `/entries/export` and
`/views/{name}/export`; native browser downloads stream paged server output.
A failure after headers aborts the stream, so a download can fail after partial
bytes have arrived. Existing databases need an app-owned migration for the
Admin-selected `created_at` statistics indexes emitted in initial `schema.sql`.

## Migrating from Admin extensions

The extension mechanism is gone: Admin is an application-built React library, and the application's own code replaces
what an extension contributed. Alpha applications that used it change as follows.

| Removed | Use instead |
| --- | --- |
| `--admin-extensions <module>`, `adminExtensions`, `src/admin.ts`, generated `admin-extensions.ts` | Drop the flag from `generate` and `check` scripts and delete the module. `generate` now rejects the option and removes the generated `admin-extensions.ts` (it is SDK-owned). |
| `navGroups` in that module | `defineAdmin(admin, { nav: { groups } })` in `src/admin.tsx`, an object keyed by group id instead of an array: `{ id: "approvals", title, order }` becomes `approvals: { title, order }`. `tsc` refuses a group the manifest uses and `groups` omits. See [Sidebar](#sidebar). |
| `defineAdminExtension`, `@aotter/mantle-admin/extension` | React components in `defineAdmin`: `components` for the regions below, `pages` for whole pages; see [Customising Admin](#customising-admin) and [Sidebar](#sidebar). |
| Field widget `widget: <extension>/<contribution>` and `options` | `"input:<schema>.<field>"` in `components`. `widget: textarea` stays. |
| `list.cells` on a Schema or View | `"cell:<schema>.<field>"` or `"cell:view:<view>.<column>"` in `components`. |
| `uiSchema.panels`, `record.sidebar/v1` and `home/v1` panels | `"record.aside:<schema>"` and the `Home` component. |
| `record/v1`, `list.selection/v1` and `list.toolbar/v1` actions | `"record.actions:<schema>"` and `"list.actions:<schema>"`; call a Procedure with `useOperation`. |
| Handlers `api`, `settings` and `actions.run`, and the `/admin/api/x/<extension>/*` routes | Server work is a Procedure (writes), a View (reads) or an application route. Authorization stays on the server: a Procedure or View carries its own `requires`. |
| `extensionBindings`, `extensionOptions`, `@aotter/mantle-admin/server/extensions`, the `extensions` and `navGroups` options of `admin()` and the `extensions` field of `/admin/api/site` | Delete them. |
| The import map and `shared/*.js` shims in the built Admin | None: the application's bundle holds the one React there is. Drop any CSP hash for the import map. |
| Extension pages (`/admin/x/<extension>/<page>`) | `defineAdmin({ pages: [{ path, title, element, nav }] })` at `/admin/p/<path>`; `nav: { group, order? }` replaces the page's `nav`, in a built-in group or one the manifest uses (an extension's own `navGroups` entry that no Schema or View uses cannot hold a page). A page has no `role`: every member sees it, so gate inside the element with `useMe()`; the `requires` of the View or Procedure it calls still decides what works. |
| Extension settings pages (declared form, `settings` handlers) | A page in `pages` whose element reads and saves through a View and a Procedure that hold the settings, or an application route. |

A manifest that still names a removed key fails `mantle generate` with `SCHEMA_UI_INVALID` or `VIEW_UI_INVALID` at the
key's path. The `UI_EXTENSION_*` diagnostics no longer exist.

## Collection list template today

The compiler derives display/filter metadata from Schema `uiSchema`, searchable fields from `searchableFields`, and sortable fields from indexes plus required/non-null fields and selected system columns. It emits per-collection quoted fragments, row policies and bind recipes; Admin uses one shared `nativeEntryPage` implementation, not Store `find`, `search` or `count` for these lists.

Requests select only generated fields and append only supplied predicates. Absent filters are omitted, rather than expressed as `(? IS NULL OR …)`. Sorts and scalar values are checked before the route acquires its DB handle. In 0.2.0 there is no generated Cartesian set of filter variants or variant cap: runtime SQL shapes depend on selected filters, bounded IN lists, search, cursor and order. Only sortable fields are checked for indexes; there is no per-filter-combination index proof. Inspect EXPLAIN for the actual workload.

Store keeps `find({ search })`, `first({ search })` and `count(where?)`. See [Store search and count costs](typed-queries.md#store-reads-and-writes): Admin shares the dialect search, and a View does not make PostgreSQL ILIKE faster.

## Collection navigation and operation placement

A Schema with a required `x-mantle-ref` folds under its parent collection: it
opens from the parent entry's workbench and stays out of the sidebar, while
`/admin/c/<schema>` still lists it; translation children remain on language
tabs. The parent is the reference named by `Schema.spec.uiSchema.nav.parentField` (a required
`x-mantle-ref` field, by `id` or by a unique field), else the only required `id` reference, else
the first required unique-field reference. A Schema with two or more required `id` references to
existing Schemas (translations excluded) and no `parentField`, with or without `standalone`, is refused by `mantle generate` with `SCHEMA_UI_INVALID`; the diagnostic lists the
candidates and the `nav: { parentField: <field> }` line that keeps the first one that is not a parent cycle. This applies to every build, with or without Admin, so a join table with two required `id` references needs it too. `parentField` is
refused on a translation child and when its parent chain leads back to the Schema. Choosing the
parent changes Admin navigation only: storage and authorization are unchanged.

Set `nav.standalone: true` to put a child with a required `id` reference at the top level instead;
a child folded only by a unique-field reference stays in its parent's workbench. With
`standalone`, `parentField` must name a required `id` reference.

### Sidebar

By default the sidebar lists publishing Schemas under Content, operational Schemas under Records (`operations`) and
admin Views under Reports, in manifest declaration order (source files in the order given to `mantle generate`, then
document order), with Admin's own pages under More. A project arranges it for how its
staff work, in the same manifest change that adds a Schema or View. Placement is presentation only: permissions,
REST, MCP and storage are unchanged, entries a caller cannot see stay hidden, and an empty group is not shown.

- `Schema.spec.uiSchema.nav` and admin `View.spec.uiSchema.nav` take `group` (a group id), `order` (an integer;
  ascending; entries without one follow in that default order, collections before Views) and
  `hidden: true` (out of the sidebar, still at its URL).
- Built-in groups need no declaration: `content`, `operations`, `reports`, `more`. A project declares every other
  group once, in `src/admin.tsx`: `defineAdmin(admin, { nav: { groups } })`, each with a title (text or
  `{ locale: text }`) and an `order` among the built-in groups' content 10, operations 20 and reports 30 (default 50);
  More always stays last. Declaring a built-in id is a type error (and ignored at runtime). `generated/admin-client.ts` exports `ManifestNavGroup`, every group the manifest uses, and types
  `nav.groups` so that `tsc` refuses an entry that leaves one out (`mantle generate` no longer checks it). Without an
  `src/admin.tsx` (the built-in entry) nothing refuses it, so an undeclared group still shows its items, titled by its id.
- `nav.items` adds entries beside the ones `uiSchema.nav` produces: `{ group, title, icon?, order?, to }`, where `title` is
  text or `{ locale: text }`, `icon` is any React icon component, and `to` is `{ collection, filter? }` (the list, preset
  to the value of one field) or `{ view, input? }` (an admin View with its input). Names, the filter field and value and the
  View input are typed from the generated manifest, so a misspelling or a wrong preset fails `tsc`. Several items may lead to
  one resource with different presets. An item whose collection or View the caller cannot see is not shown; showing or
  hiding one changes no permission, because the target's own route still decides.
- <a id="sidebar-badges"></a>`badge: { view, field }` on an item shows a count after its title: `field` of the one row an aggregate admin View
  returns, typically one with `uiSchema.nav.hidden: true` so it stays out of Reports. The View is typed from the generated manifest
  and runs for the current caller through its own `requires`, scope and TTL, with no system fallback. Admin reads every badge of the
  sidebar in one `GET /view-batch` (the first 20 distinct Views; `defineAdmin` logs the rest and they show nothing). Zero shows a muted
  `0`, loading a placeholder and an unreadable count `!`. A refused or missing View shows nothing, so a badge never reveals a queue
  the caller cannot read, and no state blocks the link. Counts are cached for 30 seconds, read again when the window regains
  focus, and refreshed after a mutation through Admin's shared query cache (`useOperation` or any Admin write); there is no polling.
  The cache is keyed by the signed-in user. A replacement `Sidebar` reads the same counts with `useBadges`. Badges are browser only.
- `pages` adds a page of the application's own inside Admin's shell: `{ path, title, element, icon?, nav? }`. `path` is one
  segment of lowercase letters, digits and hyphens, and the page is at `/admin/p/<path>`. `nav: { group, order? }` places it in
  the sidebar with the other entries of that group (the same group ids as `nav.items`: a built-in group, or one that a manifest
  `uiSchema.nav.group` uses; `tsc` refuses any other); without `nav` it keeps its route and stays out of the sidebar. A page has
  no `role`: every Admin member sees it, so hide a part of it with `useMe()` and rely on the `requires` of what it calls. A page's `element` reads through the [data hooks](#typed-data-hooks) and writes through
  Procedures; showing a page grants nothing, because each View or Procedure it calls authorizes on the server.
- `home` names where `/admin` leads: `{ collection, filter? }`, `{ view, input? }` (typed like `nav.items[].to`) or `{ page: "<path>" }`
  for one of `pages`. When the caller can see the target, `/admin` redirects to it and Admin's own home (setup and connector
  content, or your `Home` override) moves to `/admin/setup`, listed first under More. When the caller cannot see the target, or without
  `home`, `/admin` stays the built-in home. Choosing a landing page grants and denies nothing; the target's own route still decides.
  The landing is browser only.

`pages[].header` composes actions beside the native page title without replacing
Admin's shell or targeting its internal DOM:

```tsx
pages: [{ path: "queue", title: { en: "Queue", "zh-TW": "待辦" },
  header: { description: "Items awaiting review", actions: <QueueActions /> },
  element: <QueuePage />, mcp: { renders: "pending-requests" } }]
```

The explicit object renders the same native heading on both surfaces. `title`
and `description` resolve using the browser preference or MCP host locale;
`actions` is React content, so its component may use the existing hooks and
host-aware links. Keep action controls disabled or provide a fallback when the
host lacks a capability. Do not add another h1 to `element` with this header.
Use `header: false` if the element owns its heading. Omitted preserves existing
behavior: native title in the browser, element alone in MCP. This option does
not customize the global application `Header` slot.


`src/admin.tsx` is JSX and runs in the browser, so `tsconfig.json` needs `"jsx": "react-jsx"` and `"lib": ["ES2023", "DOM"]` beside the Worker's `types` (`@cloudflare/workers-types`, `node`) and must include `src/**/*.tsx`; `node_modules/@aotter/mantle/docs/examples/app-shell/tsconfig.json` is the working file. The app also depends on `react`, `react-dom` and `@types/react` (see the example's `package.json`). The app owns `react` and `react-dom` (Admin and the kit take them as peers), so pin both to the same exact version: `react-dom` refuses to run beside a different `react`. `mantle bundle` stops with a message when they differ; add `lucide-react` (or another icon package) yourself if you use icons.

```tsx
// src/admin.tsx
import { Inbox } from "lucide-react";
import { defineAdmin } from "@aotter/mantle-admin/app";
import { admin } from "../generated/admin-client.js";

export default defineAdmin(admin, {
  nav: {
    groups: { approvals: { title: { en: "Approvals", "zh-TW": "簽核" }, order: 5 } },
    items: [
      { group: "approvals", title: "Waiting for me", icon: Inbox, to: { view: "pending-requests" } },
      { group: "approvals", title: "Rejected", to: { collection: "requests", filter: { status: "rejected" } } },
    ],
  },
});
```

```yaml
# a Schema or an admin View
uiSchema: { nav: { group: approvals, order: 1 } }
```

`mantle generate` refuses a non-integer `order` and
placement on a Schema without a sidebar entry of its own: a translation, or a folded child that is not
[`standalone`](#collection-navigation-and-operation-placement).
The purchasing example (`node_modules/@aotter/mantle/docs/examples/purchasing/`) puts its approval queue and requests in an Approvals group.

Operational collections have no generic create or draft: officers add records through a Procedure placed with `collectionAction` (the list header shows its button and input form), so every write is a declared, validated program. For a user-field scoped Schema the Procedure can stay SQL; see [field scope](../reference/schema.md#field-scope) for the partition input.

Admin operations are Procedures exposed by an admin MCP Trigger. Declare
`Procedure.spec.uiSchema.collectionAction: <schema-name>` to show the operation
in that collection's list header. Row operations are chosen by the Procedure's
explicit `target: { schema, id, version? }`: `id` names the input bound to the
row id, and optional `version` names the input bound to its reviewed OCC version.
Names such as `approve` never determine placement. An operation without a row
target or collection action appears on the Operations page, whose sidebar link
appears whenever such operations exist.

A collection action of a folded child (one with a parent; see above) also shows in that child's panel of the parent's
workbench. Run from there, the input named exactly like the child's `nav.parentField` (the child's field holding the
parent's value) is filled with this parent's value and locked, shown as bound like a row operation's `id`. The name
is the rule because it is unambiguous (one input at most, the same name as the column the action writes); an input
with that name whose `x-mantle-ref` names another Schema or key is left to the person, and so is every input
outside a workbench. With `nav.parentField: post`, `new-revision { post }` placed with
`collectionAction: post_revisions` runs on the open post.

A record's page shows its row operations as labeled buttons in the header (more than three: two buttons and a
"More actions" menu); list rows keep them in an "Actions for …" menu.
Generated row metadata includes simple AND-ed equality/IN literal conditions
from the target-row UPDATE/DELETE WHERE, and an operation whose conditions the
row does not meet is hidden: with `WHERE … AND orderStatus = 'approved'`, "Mark
fulfilled" appears only once the order is approved. Missing preview values and
unsupported predicates leave actions available. These are
presentation hints: the Procedure still enforces its WHERE and authorization.
Conflicts show a localized refresh message with the technical diagnostic in
Details. Successful actions show a short summary and changes, with raw output
in a collapsed Details disclosure. CSV exports retain UTC wire timestamps.

Developer Model and Logic pages share an object sidebar on wide containers
and an object-list drawer on narrow containers.
Schema Live data previews use collection routes even for folded children.
Pass `bindings.developerViews` as the Admin `developerViews` option for
public and admin View previews; ordinary Admin View routes and exports use
only `bindings.views` (admin Views). View previews use the read-only `/admin/api/developer/views/<view>` route,
with the signed-in admin caller and the same authorization, scope, TTL and
publishing policy as REST. Public Views retain public visibility; internal or
disallowed Views show an unavailable explanation. Previews never use a system
caller or bypass a View's `requires`.
