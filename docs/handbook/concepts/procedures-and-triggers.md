# Writes: Procedures and Triggers

Writes use Store or declared Procedures. Raw SQL writes bypass scope, TTL, publishing and system-column rules.

SQL Procedures compile to native statements and return `{ results }`, one row array per statement. Row operations must affect exactly one row; a stale explicit version lock or unique clash is `CONFLICT`. Multi-statement Procedures run atomically; single-statement writes use native autocommit. See [native execution](../guides/native-execution.md) for uncertain outcomes. Never retry an `OUTCOME_UNKNOWN` write automatically.

A ref Procedure generates a typed `Handlers` key. Its handler receives `(ctx, input)` with `{ caller, db, store }` bound to the same Caller and transaction. Generated `requires` runs first. Handlers own side effects and their transaction boundaries.

HTTP and MCP Triggers expose a declared Procedure with its existing authorization. Lifecycle and schedule Triggers are rejected by generation. Put side effects in app-owned handlers, and wire scheduled system maintenance with the host's scheduler. See [Procedure](../reference/procedure.md), [Trigger](../reference/trigger.md) and [Store](../guides/typed-queries.md).
