# Procedure

A Procedure requires `input`, `output` JSON Schemas and a `handler` containing SQL or a ref name. Optional fields include title, description, requires, target, MCP annotations and Admin uiSchema. See [manifest envelope](manifest.md).

SQL uses declared Schemas, `input.<name>`, `auth.uid()`, `auth.role()` and native expressions accepted by the selected compiler dialect. Compiler policy supplies scope and system fields. Do not assign scope, version, status, published_at, timestamps or author columns yourself. Publishing writes use generated transitions.

A row-classified INSERT/UPDATE/DELETE must affect one row. Use `WHERE id = input.id AND version = input.expectedVersion` for explicit OCC. Set operations may affect zero rows. A unique clash or failed row assertion is `CONFLICT`; statements run atomically. Results are raw `{ results }`, not runtime-validated authored outputs. RETURNING uses SQL output names; quote an explicit alias to preserve declared case (`RETURNING reqStatus AS "reqStatus"`). Generation warns about unaliased direct fields whose declared name differs from storage.

A ref handler is application code called as `(ctx, input)`. Generation prints required `Handlers` keys; typecheck and implement them. Wire them at `store(db, caller, { handlers })` and selected surfaces. The context has Caller, native db and Store bound to the same transaction. It is not a sandbox; the app owns external side effects and input/output handling.

`target: { schema, id, version? }` binds an Admin operation to a row. SQL targets can be inferred for a single locked row operation; declare a target for a ref operation when needed. Input fields must have the required shapes.

Generated requires checks gate calls. Boundary input validators are generated separately; direct queries accept driver-ready, app-validated input. Dynamic guards and lifecycle hooks are rejected. See [native execution](../guides/native-execution.md) and [surface contracts](surface.md).
