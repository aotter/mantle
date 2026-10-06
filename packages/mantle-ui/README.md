# @aotter/mantle-ui

Shared interaction UI for the Mantle Admin and MCP Apps (ADR-0029). The
`/controller` subpath is framework-free; the root adds React components on top
of it (React 19 is an optional peer, needed only for the root and `/kit`).

## Admin

The full SPA has a separate opt-in iframe artifact at
`@aotter/mantle-ui/admin/preview.html`. Resolve that exported file, copy its
adjacent assets, and use `adminPreviewDocument` from `/admin-preview` to prepare
the document for the host's mount and asset paths. It installs the exported
`admin/host-bridge.js` synchronously before Admin starts. Mount the document at
`/builder/admin/dev` to open the complete Developer workspace's system flow.
The canonical `admin/index.html` continues to refuse framing.

The immediate parent must be same-origin. The host accepts only that iframe's
`mantle:host-api:request` messages (protocolVersion 1), validates each envelope
with `readAdminPreviewRequest`, and replies on the supplied MessagePort with
`{ ok: true, status, headers, body }` or `{ ok: false, error }`. No unknown
request falls through to native HTTP, authentication, OAuth, or another origin.
Remount on project/revision changes; do not let an old frame address a new target.

For an authoring draft, pass `design: true`: the same full Admin SPA opens its
Developer pages, with data and account actions unavailable until a service is
built. Core's public `developerConsole(plan)` and `createAdminDesignSurface`
(`@aotter/mantle/admin`) project a compiled plan without creating a runtime,
database, authenticated caller, or role grant. A compiler host must bind the
snapshot to the exact source hash and revision. This does not relax the running
Admin API's owner-only developer-console route. Runtime preview hosts instead
dispatch through the real authorized Admin surface.

`dist/admin/` is the built Admin console (a static SPA with base `/admin/`).
Nothing imports it: `mantle generate`'s Cloudflare preset binds
`node_modules/@aotter/mantle-ui/dist/admin` as the Worker's static assets (the
Bun preset resolves `@aotter/mantle-ui/admin/index.html` and serves its
directory with `bunAdminAssets`), and
`createAdminSurface` (`@aotter/mantle/admin`) serves it at `/admin`. It is
built for that path, so `createAdminSurface` refuses `assets` under any other
`basePath`. Its source is `admin/`.

## MCP App

`/mcp-app` exports `mantleAppHtml`, one self-contained HTML document. Give it
to `planApp` from `@aotter/mantle/mcp`, which embeds the plan's catalog of
Views and row operations and renders every View tool of a surface:

```ts
apps: { resources: [planApp(runtime.plan, { surface: "staff", html: mantleAppHtml })] }
```

The App shows a View's rows with Admin's value renderers and opens one row
operation at a time through the controller and `OperationPanel`. Every read
and write is a tool call through the host; it holds no credentials.

An App of your own reuses the same pieces from the root: `readCatalog`,
`toolOf`, `outputOf`, `rowsOf`, `invokeTool` and `actionsFor` read the catalog
and tool results as Mantle's App does (the `develop` skill's MCP App recipe).

## Controller

The `/controller` subpath takes one operation opened from one
row, the version the person reviewed, and one submit. It imports nothing at
all, not even Mantle types. The shapes it expects (`InteractionBinding`,
`InteractionDiagnostic`, `EntrySnapshot`) are structural, so a runtime
`ViewRowAction` and `Diagnostic` fit them as they are.

```ts
import { createInteractionController } from "@aotter/mantle-ui/controller";

const controller = createInteractionController({
  interaction: rowAction,               // from a View capability's rowActions
  row,                                  // the row as the person saw it
  read: (signal) => readEntry(row.id, signal),
  invoke: (input, signal) => callTool(rowAction.capability, input, signal),
  initialInput: currentValues,          // optional prefill
});
await controller.open();
controller.edit("reviewerNote", "Within budget.");
await controller.submit();
```

The host injects `read` and `invoke`. Admin uses the staff MCP client, an MCP
App uses `App.callServerTool`, and an application can use its own HTTP
client. `subscribe` and `getSnapshot` plug straight into React's
`useSyncExternalStore`, or into any other store. A listener that throws is
reported asynchronously; it cannot interrupt a transition.

| Phase | Meaning |
|---|---|
| `unreadable` | The target could not be read, or a different entry came back. Nothing is confirmed, so submit waits for a successful `reread()` or `refresh()`. |
| `changedSinceList` | A read found a newer version than the one reviewed. `latestChanges()` shows what moved and `review()` adopts it; nothing is swapped silently. |
| `conflict` | The runtime answered `CONFLICT` to an operation that locks a version. The input is kept; `reread()`, then review again. Without a `read`, the components ask the person to reopen the action from a refreshed list instead. |
| `uncertain` | The write may have landed, so it is never retried. This covers a submit that threw, timed out or was cancelled, and a runtime `OUTCOME_UNKNOWN`, `PARTIAL_FAILURE` or `failure.outcome` of `unknown` or `partial`. `reread()` first; a host without `read` calls `acknowledgeUncertain()` after checking elsewhere. |
| `failed` | The runtime refused, and `diagnostics` holds its answer. A `CONFLICT` on an operation that locks no version (a unique key, a state rule) is a refusal too: the person fixes the input and submits again. A conflict whose reread finds the same version also lands here, because the refusal was not about the version. |

Behaviour to rely on:

- A background `refresh()` never replaces the draft or the reviewed version. Its failure is recorded in `error` without blocking submit, and `reading` is true while any read is in flight.
- Prefilled fields the person has not touched follow the newer entry on `review()`, so a prefill never reverts someone else's change.
- `contested` lists touched fields that someone else also changed.
- Bound inputs and the version input are not editable. A binding to a field the row lacks is refused at construction, and so is a locking operation with neither a `read` nor a row carrying `id` and `version`.
- `changes()` lists the draft fields that differ from the reviewed entry, and `dirty` is true while the person's edits are unsaved.
- A success that arrives after `cancel()` is ignored: the phase stays `uncertain` until a reread shows it.

## Components

```tsx
import { OperationPanel, createInteractionController } from "@aotter/mantle-ui";

<OperationPanel controller={controller} title="Review requisition" labels={labels} fieldLabel={label}>
  {/* the host's own inputs, wired to controller.edit */}
</OperationPanel>
```

`OperationPanel` composes the parts for a page, a dialog or a chat surface:

- `EntityPreview`: the reviewed entry.
- `ChangeDiff`: the person's own changes, or what someone else changed.
- `OperationStatus`: the next step for each phase, with its one action.
- `OperationOutcome`: the result.

Each part reads only the controller snapshot (`useInteraction`) and calls only
controller actions. None of them reads a router, a query cache, a transport or
host globals.

The host supplies:

- **Inputs:** the editable fields, rendered as `children` and wired to
  `controller.edit`.
- **Strings:** every string, as `labels` (English defaults in
  `defaultInteractionLabels`).
- **Field labels:** a `fieldLabel` function.

Styling uses Tailwind token classes (`bg-muted`, `border`, `text-destructive`,
`bg-primary`, …) resolved from the host's CSS variables. Add
`@source "../node_modules/@aotter/mantle-ui/dist/**/*.js"` (adjusted to your
stylesheet's location) so Tailwind generates the classes.

## Fields and values

Admin's own value and field code is shared, so an MCP App renders a field
exactly as the console does:

- `SchemaFields` (from `/kit`, since its controls are kit components): a form over a JSON Schema (option lists from `enum` or a
  `oneOf` of titled `const`s, money and date previews, arrays, nested objects).
  Strings come from `labels`; a control only one host has (Admin's media
  library and rich text editors) comes through `renderField`, and without it
  markdown and HTML are a textarea. `propertyLabel` overrides how a label reads.
- `renderDataValue` (root, React only), `optionLabel`, `propertyLabel`, `resolveLocalizedText` and
  the money and date formatters: how a value reads in a cell or a card.

## Kit

`@aotter/mantle-ui/kit` is Admin's domain-neutral React/shadcn visual
language, for applications that do not embed the Admin product: the
primitives, the email sign-in flow and the compiled theme. Its libraries are
optional peers, so `/controller` and `/mcp-app` consumers install none of them.
Install them with the kit:

```sh
pnpm add @aotter/mantle-ui react react-dom radix-ui lucide-react class-variance-authority clsx tailwind-merge sonner input-otp react-day-picker
```

Then:

```tsx
import { Button, Card, CardContent, Input } from "@aotter/mantle-ui/kit";
import "@aotter/mantle-ui/kit.css";
```

`SignInFlow` exports Admin's own two-step email-OTP form (email screen, then
six-digit code screen). The host injects transport (`onSendCode`,
`onVerifyCode`), whatever navigation follows a successful verify, and all copy;
the component owns only the step, busy, and error state. A verify that resolves
without an error is terminal: the form stays busy and locked so the consumed
code cannot be resubmitted, and the host must navigate or unmount it (Admin
does `window.location.assign`). Admin renders the same component, so a host's
sign-in cannot drift from it.

Use `@aotter/mantle-ui/tokens.css` when an application only needs the
Mantle color, radius, background, and sidebar variables. The kit intentionally
does not export `AdminApp`, authenticated layouts, routes, queries, or feature
views; use the static Admin SPA or sandbox preview for the complete product.

Applications that compile Tailwind themselves import `tokens.css` and add
`@source` for `node_modules/@aotter/mantle-ui/dist/kit` instead of `kit.css`.

Developer overview URLs accept `?diagram=system` or `?diagram=business`. The mode switch updates the URL, preserving other query parameters; without a recognized mode the existing graph heuristic applies. Hosts choose their initial iframe URL. Preview documents require an explicit local `basePath` through `adminPreviewDocument`; the SDK does not choose a host mount or deployment destination.

An opt-in same-origin preview host can publish a header menu with `postMessage({ type: "mantle:host-ui:menu", protocolVersion: 1, menu: { label, description, items: [{ id, label }] } }, origin)`. Publish after iframe load and when configuration changes. Admin renders text labels and sends `mantle:host-ui:action` with `protocolVersion: 1` and the selected `id`; the host validates origin/source and calls the exported `readAdminPreviewAction`, then accepts only its declared command IDs. Items may optionally set `disabled: true`. Canonical Admin has no host menu. Host behavior, project controls and deployment choices remain outside the UI package.
