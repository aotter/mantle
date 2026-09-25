# @aotter/mantle-ui

Framework-free interaction logic shared by the Mantle Admin and MCP Apps
(ADR-0029). The `/controller` subpath takes one operation opened from one
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
| `conflict` | The runtime answered `CONFLICT`. The input is kept; `reread()`, then review again. |
| `uncertain` | The write may have landed, so it is never retried. This covers a submit that threw, timed out or was cancelled, and a runtime `OUTCOME_UNKNOWN`, `PARTIAL_FAILURE` or `failure.outcome` of `unknown` or `partial`. `reread()` first; a host without `read` calls `acknowledgeUncertain()` after checking elsewhere. |
| `failed` | The runtime refused, and `diagnostics` holds its answer. A conflict whose reread finds the same version also lands here, because the refusal was not about the version. |

Behaviour to rely on:

- A background `refresh()` never replaces the draft or the reviewed version. Its failure is recorded in `error` without blocking submit, and `reading` is true while any read is in flight.
- Prefilled fields the person has not touched follow the newer entry on `review()`, so a prefill never reverts someone else's change.
- `contested` lists touched fields that someone else also changed.
- Bound inputs and the version input are not editable. A binding to a field the row lacks is refused at construction, and so is a locking operation with neither a `read` nor a row carrying `id` and `version`.
- `changes()` lists the draft fields that differ from the reviewed entry, and `dirty` is true while the person's edits are unsaved.
- A success that arrives after `cancel()` is ignored: the phase stays `uncertain` until a reread shows it.
