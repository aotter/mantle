# Procedure

A Procedure requires `input`, `output` JSON Schemas and a `handler` containing SQL or a ref name. Optional fields include title, description, requires, target, MCP annotations and Admin uiSchema. See [manifest envelope](manifest.md).

SQL uses declared Schemas, `input.<name>`, `auth.uid()` and native expressions accepted by the selected compiler dialect. Compiler policy supplies scope and system fields. Do not assign scope, version, status, published_at, timestamps or author columns yourself. Publishing writes use generated transitions. `restrict` narrows the rows the statements read and write, as on a [View](view.md#restrict); it is refused on ref handlers.

A row-classified INSERT/UPDATE/DELETE (one that targets a single row, e.g. `WHERE id = input.id`) must affect one row. Use `WHERE id = input.id AND version = input.expectedVersion` for explicit OCC. Set operations, including UPDATE with a subquery and `INSERT ... SELECT`, may affect zero rows without an error: check the returned rows when zero means failure. A unique clash or failed row assertion is `CONFLICT`; statements run atomically. Results are raw `{ results }`, not runtime-validated authored outputs. RETURNING uses SQL output names; quote an explicit alias to preserve declared case (`RETURNING reqStatus AS "reqStatus"`). Generation warns about unaliased direct fields whose declared name differs from storage.

A row-classified UPDATE/DELETE on an excluded or missing id affects zero rows and returns HTTP 409 (`CONFLICT`), just like a stale version; reads return not found. Native Admin's visible-row pre-read returns 404 for excluded/missing ids.

A ref handler is application code called as `(ctx, input)`. Generation prints required `Handlers` keys; typecheck and implement them. Wire them at `store(db, caller, { handlers })` and selected surfaces. The context has Caller, native db and Store bound to the same transaction. It is not a sandbox; the app owns external side effects and input/output handling. The context has no `env`: on Workers read bindings and secrets with `import { env } from "cloudflare:workers"`. The Caller carries no email; for a session caller use `sessionUserOf(caller)` from `@aotter/mantle/auth`, and in scheduled work read Better Auth's `user` table.

`target: { schema, id, version? }` binds an Admin operation to a row. SQL targets can be inferred for a single locked row operation; declare a target for a ref operation when needed. Input fields must have the required shapes.

Generated requires checks gate calls. Boundary input validators are generated separately; direct queries accept driver-ready, app-validated input. Dynamic guards and lifecycle hooks are rejected. See [native execution](../guides/native-execution.md) and [surface contracts](surface.md).

SQL INSERT/upsert into a user-field scoped Schema is system-only. For a verified user, insert through `ctx.store` so membership and single-partition autofill run before the native write. SET cannot change a field-scope column, including ON CONFLICT DO UPDATE. Scoped unique conflict targets gain the owner/field prefix automatically.
