# Next development acceptance

Read the accepted responsibility decision in `../../docs/next/contract.md`.
The only artifact is a bare native query; the checked boundary was removed on
2026-10-11 (see the contract). Do not reintroduce validators, codecs or row
decoders into generated queries.

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
   and selected boundary separately. Existing exploratory intervals are not an
   automated equivalence gate; current startup watchdog is a local diagnostic.
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
