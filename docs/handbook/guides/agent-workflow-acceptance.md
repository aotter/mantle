# Design and accept an MCP business workflow

Before implementing a new MCP service or changing a workflow, audit how its
public capabilities let the intended user reach the business goal. After
implementation, exercise that contract from the user's position. Generation, discovery and a
scripted smoke test remain necessary; they do not establish that a new agent
can discover and use the workflow without the author's recipe.

Use the design audit and acceptance loop for a new or changed MCP workflow. It is an
application-authoring practice, not an SDK runtime service or a new test runner.
Use the project's existing local smoke setup, normal authorized sign-in and
isolated fixtures. Keep credentials inside setup; give the agent only its
authorized transport. Do not enable extra routes, roles or generic writes to
make the exercise pass.

## Audit the design before implementation

Start with a user's goal, role and observable completion criteria, not a list
of CRUD endpoints. For example: “find an available item within budget, order
it, verify what was purchased, then cancel it and verify the outcome.” Identify
every entity, relation, state, version and amount the user must observe. Select
only capabilities needed for this goal; do not expand the service into generic
CRUD or grant extra authority for the audit.

In the application's existing design note or issue, map each goal step to its
proposed public capability: discovery inputs, returned IDs and evidence, allowed
caller, write/transaction boundary and recovery. Mark missing capabilities or
unresolved contracts as gaps before writing manifests or handlers. Review the
following rubric against that map:

| Design question | Required contract or explicit gap |
| --- | --- |
| Can the agent locate the right record? | Bounded search/filter inputs, stable IDs, deterministic cursor paging and sensible limits. It must not scan every list or guess an ID from a display label. |
| Can it read a complete business result? | ID-based detail/readback under the intended caller, including every relation the goal creates or changes. A parent list is not proof of its child/contact/state details. Distinguish absent/inaccessible from incomplete evidence. |
| Can it verify a create or update? | Return the backend entity ID, actual committed version where applicable, and a safe result summary or a documented authorized readback. State the exact result nesting. Echoed input or the submitted `expectedVersion` is not proof of committed state. Specify PATCH versus full replacement and omitted/null-field semantics so an update cannot erase unseen fields. |
| What does a version protect? | Name its entity/snapshot scope; a parent version does not imply child rows or aggregates are unchanged. Use the reviewed observed version for OCC, define conflict behavior and preserve the user's proposed changes without silently rebinding/retrying. |
| Can it complete a business transition? | Name permitted source/destination states, preconditions, related effects and final readback. Prefer an outcome-oriented operation when arbitrary field updates would leave the workflow unfinished. |
| What commits together? | Define the native Procedure/Store atomic boundary. Separate tool calls are independent; describe partial success and deliberate compensation. Do not imply that an agent can roll back earlier calls or that compensation is always possible. |
| Can it interpret refusal and failure? | Document success and structured diagnostic/error envelopes, including MCP `isError`; HTTP 200 or a wrapper's transport success is insufficient. Inspect raw MCP diagnostics separately from host-visible wrapper errors; a wrapper label alone does not locate a runtime defect or require global error normalization. Missing relations, stale versions and denied callers need meaningful refusals without leaking another caller's records or native internals. |
| What happens after a duplicate or uncertain write? | State whether idempotency exists, its key/scope/lifetime when supported, or that repeated successful calls may repeat effects. Provide an authorized reconciliation route for timeout/unknown outcomes; never automatically retry an uncertain write. |
| Can it explain amounts correctly? | Declare currency, stored/wire units, exact-value representation, rounding and whether null means unknown. Label every ratio's numerator and denominator: cost/budget, sales/budget and gross/sales are different measures. |
| Does data remain usable without an App? | Keep ordinary reads data-only; attach a renderer deliberately for interactive inspection, with structured/text fallback. Rendering must not write or imply approval. Host catalog refresh, OAuth and real client/UI behavior have separate acceptance; descriptions cannot force generative UI layout. |
| Does every step respect the user's authority? | Verify least privilege, tenant/owner scope, allowed fields, relation access and negative cases on the server. Tool visibility, annotations, descriptions and UI confirmation never grant permission. Use authorized disposable fixtures and a cleanup owner without widening production writes/deletes. |

A design passes this audit only when each required goal step has a supported
capability and verifiable output/recovery; preserve unresolved gaps and owners.
The audit is a design review, not execution evidence. If a required capability
is intentionally excluded, narrow the claimed goal explicitly rather than
calling the original goal complete. Reuse the installed version's Views,
Procedures, Store and surface contracts; a missing business tool is not by
itself an SDK runtime defect.

For simple creates/partial updates, prefer a declared Store-backed `ref`
Procedure: await the caller-bound Store write, return a safe allowlist with its
actual returned ID/version, and keep `requires` plus generated input validation
at invocation. A transaction-bound write result remains provisional until the
outer transaction commits; publish success only after that boundary completes. Store row policy alone is not Procedure authorization. Define
omitted versus null patch semantics; never fill unseen fields with defaults.
Keep SQL Procedures for atomic stock changes, conditional state transitions and
related writes. A TypeScript pre-read does not replace an atomic WHERE/CHECK;
D1 supports batch, not an interactive transaction or consuming an earlier batch
result. See the [Store write guide](typed-queries.md#prefer-store-backed-ref-procedures-for-simple-writes).

Then implement the minimum contract and run generated/type, authorization,
atomicity and other relevant regressions. Follow the fresh-agent loop below
before claiming independent business acceptance. Keep the author's capability
map and worked call sequence out of the fresh agent's prompt: that agent must
be able to discover the workflow from public tool descriptions and results.

## Run, repair and repeat

1. **Freeze the goal.** Write a natural-language business task and observable
   acceptance criteria before the run: required relations, states, versions,
   totals and units, pagination bounds and error recovery. Select the user role,
   exact application/SDK revision, environment, tool/time/write budgets and
   fixture cleanup owner. Production writes and external side effects need
   their own existing authorization; prefer disposable local data.
2. **Start a fresh end-user subagent.** Supply the goal, setup/transport and
   allowed actions. Withhold source, SQL, internal docs, authoring history,
   precomputed record IDs, tool names, call order and earlier findings. Let it
   discover public tools and interpret their descriptions/results. Do not give
   it the reference's worked tool sequence. Record setup assistance explicitly.
3. **Retain the actual result.** Require steps, readbacks and design findings
   with severity, evidence and the smallest suggested repair. Record tool/page
   costs, rejected writes and recovery. A creation ID confirms a write response,
   not a full relation readback; HTTP200 alone is not MCP success. If hints are
   necessary, retain the original failure and label the later attempt assisted.
4. **Repair the contract.** Classify application tool design, reference/docs,
   SDK runtime and host behavior separately. Fix the smallest supported-contract
   gap and run relevant authorization, OCC, atomicity and regression checks.
   Keep native guards; never bypass them with a response shim or automatic
   retry. A runtime change needs a minimal supported-contract reproduction.
5. **Retest independently.** Freeze the repaired revision. Give the same goal
   to a different fresh agent, with new fixtures and no earlier findings or
   repair hints. Preserve both reports. The author's script or a coached retry
   by the original agent does not substitute for this round.
6. **Stop with an honest result.** Accept only when every required business
   step/readback passes and no application P0/P1 remains. A missing required
   step blocks the goal regardless of its assigned severity. Retain nonblocking
   suggestions and external BLOCKED gates. Default to at most three rounds,
   within the declared per-round budgets; unresolved cases stay BLOCKED rather
   than weakening the goal or running indefinitely. Setup always cleans up its
   isolated fixture in `finally`, including failed/aborted runs.

If a fresh agent or authorized test transport is unavailable, record independent
acceptance as BLOCKED and report the scripted checks separately. Do not invent
an independent result. Do not deploy or publish merely to obtain acceptance.

## Give the agent a business task

For a shop workflow, supply a business goal like this instead of a worked API
sequence:

> As a buyer, find an available tea and buy one within the stated budget.
> Verify the returned order's item, quantity, price, state and current version.
> Cancel that order and verify its final state. Explain any refused operation
> and what remains unverified. Use only the supplied public MCP transport and
> public tool results; do not inspect source or a database, invent IDs, or
> blindly retry uncertain writes. Keep to the supplied call/time/write budget.

The author separately verifies stock restoration, another buyer's isolation,
stale-version refusal and unknown-outcome handling through authorized test
fixtures. Do not grant a buyer admin access just to prove hidden stock values.
Keep author regressions distinct from what the fresh agent actually observed.

## Record evidence in the existing issue or handoff

Use ordinary Markdown; no new receipt schema or framework is required:

- Goal/criteria, role, exact revision/SDK version, environment and budgets.
- Setup assistance and what the agent could access; identify distinct rounds.
- Each step's PASS/FAIL/BLOCKED, actual readback and call references; tool/page
  counts and negative/recovery attempts, with their differing scope stated.
- Findings, severity/owner, minimal repair and regression commands/results.
- New revision and the fresh retest; retain the initial failed report.
- Fixture cleanup result and every remaining limitation.

Keep credentials, raw auth logs, full resource HTML and private operational
details local/private; publish only sanitized contract evidence. Do not claim a
call-cost improvement when rounds exercise different negative/discovery cases.
Version fields usually describe an entity row, not all related aggregates;
state money units and the denominator of any budget or margin calculation.

## Keep host acceptance separate

Tool metadata and a passing AppBridge replay do not prove a native host rendered
an App. After a tool change, fresh protocol discovery also does not prove an
existing host connection adopted its new catalogue. Record actual host/client
version, observed tool snapshot and rendered behavior separately. Keep data
results available without Apps; descriptions cannot force a host's generative
UI layout. Local cookie-session acceptance, real OAuth client integration and
long-term renewal likewise require separate evidence.
