# ADR-0023: Storage and service failure contracts

Status: Accepted for alpha.17 under #857 (amends ADR-0008 and media deletion behavior).

This is the diagnostic grammar-revise record: add RESOURCE_EXHAUSTED (507),
RESOURCE_UNAVAILABLE (503), RATE_LIMITED (429), OUTCOME_UNKNOWN (503),
PARTIAL_FAILURE (503), PRECONDITION_FAILED (412), and optional safe `failure`
facts to Diagnostic. No Manifest keys, new ports, or parallel wire format.
Existing codes and envelopes remain compatible. DiagnosticError accepts internal
ErrorOptions.cause; causes never enter Diagnostic. Unexpected exceptions must not
be copied into public messages. Core owns no tenant, plan or provider quota policy.

## Contract

A port rejects with DiagnosticError for recognized failures. The diagnostic
contains stable code, safe message and optional failure facts: outcome is
not-applied/partial/unknown; retry is never/after-change/safe/reconcile; resource
is an optional non-sensitive logical resource name, not credentials or SQL.
A provider adapter or host policy owns classification. Unknown errors stay
unexpected; never guess quota from arbitrary exception prose. Existing specific
validation, not-found and atomic OCC diagnostics remain authoritative.

`safe` requires idempotence of the same operation against the same resource.
It does not request automatic retry. Timeouts after write/send default to unknown
outcome and reconciliation, not unconditional retry. Do not downgrade unknown
outcome to not-applied merely because no reply arrived. Not-found on an
idempotent object delete is success. Read absence may be null per the port.

## Operation matrix (public contracts)

| Contract | Success | Failure / effect / retry |
| --- | --- | --- |
| EntryReader / ViewQueryExecutor | documented rows/null/page | denied/unavailable/rate limit; reads have no business mutation; explicit retry after transient failure |
| EntryRepository | semantic mutation with atomic expectedVersion | existing NOT_FOUND/CONFLICT; host capacity/denial; unknown write requires readback by stable id/version, never latest-version substitution |
| SiteConfigRepository | validated settings/locale | reads as above; writes same conditional and uncertain-effect rules as entries |
| MediaAssetRepository / PendingUploadRepository | metadata persisted/deleted | capacity/availability/unknown write; reconcile by asset/upload id; removal of missing metadata is idempotent where specified |
| MantleStorageAdapter.prepare / migrations | ready prepared storage | invalid plan/readiness; completed migration steps may persist; journal/readback before retry, no cross-provider rollback promise |
| DatabaseDriver | driver rows/batch result | constraint/precondition or recognized provider failure; transaction guarantees remain driver-specific; ambiguous writes require readback, SQL is never public |
| MediaStorage.createUpload | authorized capabilities, not uploaded bytes | policy/size/denied/unavailable; adapter must state any reservations created; no general single-use guarantee |
| MediaStorage.commitUpload | verified asset, then use case stores metadata | missing/type/size/precondition or partial/unknown provider effect; reconcile same upload group and objects before retry |
| MediaStorage.deleteObject | object absent | idempotent same-key retry; unavailable/unknown; use case retains metadata if any variant fails and returns PARTIAL_FAILURE |
| EmailSender | provider accepted, not guaranteed recipient delivery | known rejection not-applied; lost acknowledgement unknown/reconcile; do not resend automatically without provider idempotency/readback |
| DeferredHookDispatcher | accepted for at-least-once delivery | ambiguous enqueue may duplicate; existing fallback preserves eventId + trigger idempotency identity; consumers must deduplicate |
| HandlerRegistry / custom handler | application output | DiagnosticError/InvokeFailure preserved; unknown exceptions internal only; handler owns side-effect semantics |
| Clock / IdGenerator | timestamp / unpredictable unique id | unexpected environmental/programming errors; never silently substitute insecure ids |
| selected Auth contract (outside Runtime) | authentication/session/admin operation | preserve supported validation/denial; provider/email/storage failure handled at Auth adapter boundary; no assumption that Procedure catches Auth errors |

HTTP and Admin use the existing central mapping; MCP retains the diagnostic
code/failure facts rather than deriving application recovery from HTTP status.
Admin OCC recovery applies to structured CONFLICT only, not all 409 responses.
Unknown provider bodies, SQL and causes remain internal. Host-supplied messages
and resource labels are explicitly public and must not include sensitive data.

## Media partial deletion change

Previously object errors were logged and the asset row removed. Now every
variant deletion is attempted; any failure retains the row and returns partial
failure. A retry deletes the same keys (including already absent objects), then
removes metadata. If metadata deletion itself has an uncertain result, reconcile
by asset id; no new object identities are created. No cross-store transaction is
implied. Remaining metadata may reference already removed bytes during recovery.

## Compatibility / verification

New failure fields are additive; old consumers still have code/message. Media
partial-delete clients now receive failure rather than misleading success.
Focused tests cover diagnostic serialization, transport redaction, host rejection
and retry of partial deletion. Concrete adapter conformance must preserve
provider constraints and no automatic retry of uncertain writes/sends.
