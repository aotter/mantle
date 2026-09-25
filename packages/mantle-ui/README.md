# @aotter/mantle-ui

Framework-free interaction logic shared by the Mantle Admin and MCP Apps
(ADR-0029). The `/controller` subpath takes one operation opened from one
row, the version the person reviewed, and one submit. It imports no UI
framework, router or host global, and ships no Mantle runtime code: its
imports of `@aotter/mantle-runtime` and `@aotter/mantle-spec` are type-only.

```ts
import { createInteractionController } from "@aotter/mantle-ui/controller";

const controller = createInteractionController({
  interaction: rowAction,               // from a View capability's rowActions
  row,                                  // the row as the person saw it
  read: (signal) => readEntry(row.id, signal),
  invoke: (input, signal) => callTool(rowAction.capability, input, signal),
});
await controller.open();
controller.edit("reviewerNote", "Within budget.");
await controller.submit();
```

The host injects `read` and `invoke`. Admin uses the staff MCP client, an MCP
App uses `App.callServerTool`, and an application can use its own HTTP
client. `subscribe` and `getSnapshot` plug straight into React's
`useSyncExternalStore`, or into any other store.

| Phase | Meaning |
|---|---|
| `changedSinceList` | A read found a newer version than the one reviewed. `review()` adopts it; nothing is swapped silently. |
| `conflict` | The runtime answered `CONFLICT`. The input is kept; `reread()`, then review again. |
| `uncertain` | The submit threw, timed out or was cancelled, so the write may have landed. It is never retried; `reread()` first. |
| `failed` | The runtime refused, and `diagnostics` holds its answer, or a read failed and `error` holds it. |

Behaviour to rely on:

- A background `refresh()` never replaces the draft or the reviewed version.
- Bound inputs and the version input are not editable.
- `changes()` lists the draft fields that differ from the reviewed entry.
