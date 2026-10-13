# The four atoms

The manifest grammar is closed: Schema, View, Procedure and Trigger.

| Atom | Declares | Native output |
| --- | --- | --- |
| Schema | Fields, indexes, scope, TTL, lifecycle and Admin presentation | Initial DDL and typed Store collection |
| View | One SQL SELECT with input, authorization and surface | Typed query; optional paging and exposure |
| Procedure | SQL statements or a ref handler contract | Typed operation with declared authorization |
| Trigger | HTTP or MCP exposure of a Procedure | Selected route/tool binding |

Generation rejects lifecycle and schedule Triggers, although they exist in the v2 grammar. Application code owns scheduling and side effects. Unknown manifest keys fail validation; a new runtime capability does not open the grammar.

SQL is authored in PostgreSQL syntax and rendered for exactly postgres or sqlite. Generation applies row policy; the app supplies its own native handle and verified Caller. See [manifest reference](../reference/manifest.md) and [supported declarations](../reference/features.md).
