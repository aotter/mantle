# Diagnostics and errors

Generation returns diagnostics with `code`, `path` and `message`. Grammar/SQL errors retain compiler codes and source locations. `GENERATE_UNSUPPORTED` identifies declarations or boundary features the native generator cannot honor; it must not silently omit behavior.

Bare queries preserve native errors except required conflict/uncertain-write classifications. At a JSON boundary, `wire(error)` or `surfaceFailure(error)` from `@aotter/mantle/contracts` redacts unclassified native failures. Selected generated REST/MCP/Admin boundaries apply their own error envelopes.

| Core code | HTTP | Meaning |
| --- | --- | --- |
| INPUT_VALIDATION_FAILED | 400 | Invalid external input, paging or Store operation |
| UNAUTHENTICATED | 401 | Caller lacks required authenticated authority |
| AUTH_DENIED | 403 | Predicate, role or session-origin refusal |
| NOT_FOUND | 404 | Missing or excluded resource |
| METHOD_NOT_ALLOWED | 405 | Path exists for another method |
| CONFLICT | 409 | Unique clash, stale lock or failed row/state guard |
| OUTCOME_UNKNOWN | 503 | Write may have committed; reconcile without automatic retry |

Unknown errors map to redacted `INTERNAL_ERROR` (500). A custom `ContractError` outside the core set must carry an explicit status. Media uses its selected `mediaError` contract. Never expose SQL errors, tokens or credentials.

The runtime runs no DDL or schema checks. Schema installation and failures belong to [the native migration tool](../concepts/runtime-and-adapters.md#schema-installation-and-migrations), not a boot diagnostic.
