# Next development acceptance

Read the accepted responsibility decision in `../../docs/handbook/guides/native-execution.md`.
Bare native queries keep their native contract. Selected REST/MCP/Admin boundaries
use generated validators and explicit legacy wire conversion; do not add those
to bare queries. Read the [Native Admin contract](../../docs/handbook/guides/native-admin.md)
before changing its app-generated whitelist, shared View templates or Procedure fragments.
The SDK never imports Admin runtime/assets; the selected application does.
Keep caller/scope/TTL/parent correlation, private-field projection, complete View
cursors, nullable entry ordering, microseconds, exact OCC and native outcome
guards. Ref handlers retain typed caller-bound ctx.store at request time.

Use native primitives and generation before adding request-time work. Bare typed
queries accept application-validated inputs and a verified Caller. External
validation, transport errors and legacy conversions belong to selected boundary
entries. Scope/auth/OCC and native transaction outcome protection remain required.
Keep `kernel <- domain <- usecase <- infrastructure` and the four-target matrix.

For changes to generation, request helpers or dependencies:

1. Run focused correctness/type checks and real native host tests as relevant.
2. Run deterministic package/bundle checks; these belong in normal CI.
3. For performance acceptance, reserve a quiet local slot, use a clean committed
   artifact, predeclare rounds/order/margins, retain all raw samples and hashes,
   and compare matching native work with native A/A controls. Measure bare query
   and selected boundary separately. Exploratory intervals are not an
   automated equivalence gate.
4. Record pass, regression or inconclusive explicitly. Do not relax budgets,
   discard outliers or repeat until a favorable result. Native equivalence and
   pure module CPU remain open until appropriate evidence exists.

Latency/CPU measurements are an agent development acceptance step, not a normal
shared-runner CI timing assertion. Do not add them to `test` or CI without an
explicit runner/protocol decision. Do not provision/upload cloud resources for
these checks: this task is authorized for local Wrangler only.

Exemption (granted 2026-10-11): production Workers startup and first-request
latency (`startup_time_ms`, cold isolates on the real edge) cannot be measured
locally. Such measurements may deploy temporary `spike-` Workers/D1 on the
maintainer's Cloudflare account. Record what was deployed, and delete every
`spike-` resource when the measurement ends.
