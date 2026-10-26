# Diagnostics and errors

Generation returns diagnostics with `code`, `path` and `message`. Grammar/SQL errors retain compiler codes and source locations. `GENERATE_UNSUPPORTED` identifies declarations or boundary features the native generator cannot honor; it must not silently omit behavior.

Bare queries preserve native errors except required conflict/uncertain-write classifications. At a JSON boundary, `wire(error)` or `surfaceFailure(error)` from `@aotter/mantle/contracts` redacts unclassified native failures. Selected generated REST/MCP/Admin boundaries apply their own error envelopes.

| Core code | HTTP | Meaning |
| --- | --- | --- |
| INPUT_VALIDATION_FAILED | 400 | Invalid external input, paging or Store operation |
| UNAUTHENTICATED | 401 | Caller lacks required authenticated authority |
| AUTH_DENIED | 403 | Predicate, role or session-origin refusal; a generic Admin write to a read-only Schema |
| NOT_FOUND | 404 | Missing or excluded resource |
| METHOD_NOT_ALLOWED | 405 | Path exists for another method |
| CONFLICT | 409 | Unique clash, stale lock or failed row/state guard |
| OUTCOME_UNKNOWN | 503 | Write may have committed; reconcile without automatic retry |

A `CONFLICT` carries `kind`: `"row"` when a row statement, or a statement a Procedure lists in `handler.mustWrite`, changed no row (missing or not visible, a stale version, or a
state its WHERE no longer allows; one message covers all three, so it never reveals whether the row exists), `"unique"`
for a unique-index clash, `"check"` for a Schema check (with `schema` and `check`) and `"lock"` when a [Schema lock](schema.md#locks)
holds the row (with `schema`, `verb`, `lock` and `message`, the lock's static text; the row is visible to the caller, so
naming the lock reveals nothing new). Match `kind`, not the message. A `"lock"` refusal never succeeds on retry: change the
state that locks the row first (for a live revision, switch the post to another revision).
To recover from `"row"`, read the record again and decide from its current state: retry with its current version only when the change still applies, and never retry blindly. A Procedure can name a precise reason itself (a ref handler that reads the row first, or a RETURNING the caller checks).

Unknown errors map to redacted `INTERNAL_ERROR` (500). A custom `ContractError` outside the core set must carry an explicit status. Media uses its selected `mediaError` contract. Never expose SQL errors, tokens or credentials.

The runtime runs no DDL or schema checks. Schema installation and failures belong to [the native migration tool](../concepts/runtime-and-adapters.md#schema-installation-and-migrations), not a boot diagnostic.

`Schema.spec.publishing` that is malformed or on a Schema that is not `lifecycle: publishing` is `SCHEMA_PUBLISHING_INVALID`. A Store update that would leave a published row without data `publish` requires is `INPUT_VALIDATION_FAILED`, for every caller. A malformed `Schema.spec.lock` entry is `SCHEMA_LOCK_INVALID`; a lock `when` outside the [lock subset](schema.md#locks) is `SQL_SHAPE` (or the SQL compiler's own code), and an `EXISTS` no declared index serves is `LOCK_INDEX_MISSING`, whose message names the index to declare.

User-field generation diagnostics are `AUTH_ROLE_REMOVED` (`auth.role` / `auth.hasRole`), `USER_REF_SCOPE_ONLY` (`auth.user` outside `scope` / `restrict`), `USER_FIELD_INVALID` (literal name/value or template grammar), `USER_FIELD_POSITION` (SET of a partition) and `USER_FIELD_CONFLICT` (column type/enum disagreement, or a reference to a field-scoped Schema without its scope terms). Warnings are `USER_FIELD_VALUES_UNENUMERATED` (no enum list), `USER_SCOPE_PUBLIC_ANON_EMPTY` (anonymous public reads are refused), `USER_SCOPE_ADMIN_VALUES` (an admin target reads field-scoped rows) and `USER_SCOPE_JOIN_DROPS` (a join of Schemas scoped by different fields). A generated app supplies the literal USER_REFS_V1 bind capability version; a mismatch throws `USER_REFS_VERSION` before native SQL.
