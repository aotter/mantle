# ADR-lite: request-scoped Cloudflare diagnostics

Status: implemented diagnostic record for #803; real-auth controls and measured
comparison acceptance belong to the #812 harness. This does not close the
separate starter provisioning/Smart Placement portion of #803.

Use native AsyncLocalStorage and a small versioned testing entry point instead of
a global current-request counter or a configurable production telemetry system.
Production mounts only check for an existing test context. With none, there are
no diagnostic clock reads, binding wrappers, records, observers or response headers.
Runtime, auth, role, catalog, dispatcher-build and dispatch retain their ownership
and authorization order. The ordinary runtime-ready promise keeps its identity.

Native D1 instrumentation sits beneath both Auth and Runtime and is idempotent.
It preserves receivers, bind chains, first-column behavior and native objects in
batches; no second driver observer is added for counting. Provider failures and
unknown metadata remain visible. Request context is captured when an operation
starts, so shared work belongs to its initiator. Catalog waiters inherit source
classification and wait time without inheriting the owner's binding counts.

The record freezes at response creation. Inclusive spans can overlap, and partial
metadata or deferred work must not be presented as a full total. A test-only cloned
MCP response supplies the JSON-RPC outcome without exposing its content; that
inspection is outside totalMs but remains instrumentation overhead for HTTP timing.
Observer errors never replace application results. D1/KV/R2 operations emit only
counts, sizes with their source/coverage, and durations; object keys, SQL, caller
identities and credentials never enter the record.

R2 GET bodies stay native. Successful direct stream-to-PUT completion confirms
payload bytes; canceled, incomplete and unconsumed reads remain unknown. This
avoids losing R2's known-length stream property or hiding buffering overhead.

Checks deliberately overlap MCP requests and share KV hit/failure loads, then
retry after failure. Native I/O is counted once per owner, and denied requests
leave unreached phases null. Additional checks preserve native D1 private receiver
and batch semantics, sync/async observer failure, immutable deferred snapshots,
R2 stream identity and partial-transfer uncertainty. The collector fixture labels
its deterministic auth explicitly; it is not evidence of native-auth parity.
