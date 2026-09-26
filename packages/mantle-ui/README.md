# @aotter/mantle-ui

Shared interaction UI for the Mantle Admin and MCP Apps (ADR-0029). The
`/controller` subpath is framework-free; the root adds React components on top
of it (React 19 is an optional peer, needed only for the root).

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
