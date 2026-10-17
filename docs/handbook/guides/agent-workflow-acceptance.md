# Design and accept an MCP business workflow

Before implementing a new MCP service or changing a workflow, audit how its
public capabilities let the intended user reach the business goal. After
implementation, exercise that contract from the user's position. Generation, discovery and a
scripted smoke test remain necessary; they do not establish that the tool
design supports the user's work. A fresh context is not enough if the author
still chooses a workflow that mirrors the implementation. Every acceptance
round gives a new end-user agent responsibility for choosing realistic tasks
and judging the design, not just finding the calls for a prescribed sequence.

Use the design audit and acceptance loop for a new or changed MCP workflow. It is an
application-authoring practice, not an SDK runtime service or a new test runner.
Use the project's existing local smoke setup, normal authorized sign-in and
isolated fixtures. Keep credentials inside setup; give the agent only its
authorized transport. Do not enable extra routes, roles or generic writes to
make the exercise pass.

## Audit the design before implementation

Start with the original user brief, business role and explicit requirements,
not a list of CRUD endpoints or a task derived from what you implemented.
Before writing manifests or handlers, record the intended jobs and assumptions
in the existing design note. Keep the author's capability map separate from
the brief an evaluator receives: the evaluator chooses its own tasks and
observable success criteria. Do not expand application scope or authority
merely to satisfy an evaluator's newly inferred product wish.

In the application's existing design note or issue, map each goal step to its
proposed public capability: discovery inputs, returned IDs and evidence, allowed
caller, write/transaction boundary and recovery. Mark missing capabilities or
unresolved contracts as gaps before writing manifests or handlers. Review the
following rubric against that map:

| Design question | Required contract or explicit gap |
| --- | --- |
| Can the agent locate the right record? | Bounded search/filter inputs, stable IDs, deterministic cursor paging and sensible limits. It must not scan every list or guess an ID from a display label. |
| Can it choose an eligible relation? | Finding an ID is not proof of business eligibility: verify the role, state and ownership required by the relationship. Return enough labels to distinguish same-name choices before writing. |
| Can it correct an ordinary mistake? | State how to amend, clear or replace optional fields and relations, and how duplicate records are detected or reconciled. Test omitted, null and empty inputs against that contract; existence and type checks alone do not establish business validity. Express conditional-required inputs with the supported [input rules](../reference/surface.md) before writing handler checks. |
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
The audit is a design review, not execution evidence. Record intentional
exclusions, but keep an unmet explicit user requirement unresolved until the
user changes its scope; do not redefine it as optional to make a round pass.
Reuse the installed version's Views,
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
atomicity and other relevant regressions. Follow the independent acceptance rounds below
before claiming independent business acceptance. Keep the author's capability
map and worked call sequence out of the fresh agent's prompt: that agent must
be able to discover the workflow from public tool descriptions and results.

## Run independent acceptance rounds until they converge

1. **Freeze scope and revision, not the evaluator's itinerary.** Supply the
   original user brief, business role, explicit requirements and exclusions,
   exact application/SDK revision, authorized transport, permitted fake-data
   actions, per-round tool/time/write budgets, a user-set total round cap of at
   least three (default four) and a fixture cleanup owner. Seed fixtures with
   realistic volume and variety: other owners' records, several states and more
   than one page of results, so evaluators' own goals reach discovery, paging
   and authority. Explicitly authorize synthetic writes only where the user has
   authorized testing. Production writes and external side effects need their
   own authorization.
2. **Use a new end-user subagent in every round.** Start without inherited
   implementation history. Withhold source, SQL, internal docs, capability maps,
   precomputed IDs, tool names, call order and previous reports or fixes. Ask
   the agent to state its own realistic goals and observable success criteria
   before execution, discover the tools and assess whether their design
   supports its work. Ask whether it can make the decisions needed for its
   goals, not merely issue successful calls. Do not prescribe the author's
   happy path or require a minimum number of defects. Zero findings is a valid
   observation. Run the evaluator outside the project directory, without Mantle
   skills or project instruction files, with only the MCP transport configured,
   and record that isolation in the evidence. For a multi-role workflow, run one
   fresh agent per role in the same round on shared live data in the brief's
   natural order; the later role finds earlier records through the service, and
   the first agent may take a resumed turn to observe the outcome. Each agent
   still chooses its own goals.
3. **Keep evidence and scope judgments.** Require PASS/FAIL/BLOCKED per chosen
   goal, actual readbacks, rejected writes, recovery, interaction costs and
   design findings with materiality, evidence and the smallest suggested repair.
   Separate a violated explicit requirement, a demonstrated defect and a newly
   inferred product need. Missing capability is a finding, not permission to
   invent tools or automatically expand the product. HTTP 200 and a creation
   ID alone do not prove a complete business result. Preserve setup assistance
   and label any coached attempt; do not count it as a clean independent round.
4. **Repair outside the evaluator's context.** The author retains the full
   findings ledger, classifies application design, SDK/runtime, docs, transport
   setup and host issues separately, then makes the smallest in-scope repair.
   Turn reproduced failures into focused regression checks and run them with
   relevant authorization, OCC and atomicity checks. Keep native guards; do not
   shim away errors or retry uncertain writes. A runtime change needs a minimal
   supported-contract reproduction. Record optional product suggestions and
   unresolved scope questions rather than silently dropping findings.
5. **Repeat the whole evaluation with a fresh agent.** Freeze the new revision
   and supply the same original brief and authority, with new fixtures. Let
   this evaluator choose its own goals again; do not pass the ledger or steer
   it toward the previous repair. Replaying a known failure remains an author's
   regression check and does not replace independent design evaluation.
6. **Judge convergence across rounds.** Converge only after two consecutive
   unassisted fresh rounds on the same revision with no new material in-scope
   finding and no unresolved material defect. A finding is material when it
   violates an explicit requirement, makes an evaluator's goal FAIL or BLOCKED,
   or exposes an authority, data-integrity or uncertain-write defect; record
   why any finding was judged non-material. Every repair creates a new revision
   and resets the streak, so hold non-material repairs until after the verdict.
   Each explicit requirement observable from the evaluator's role needs
   evaluator-observed evidence; requirements outside that role's view (another
   caller's isolation or hidden state) are verified by author regressions and
   reported under that label. A role-observable requirement no evaluator reached
   is UNVERIFIED and blocks CONVERGED. If fresh evaluators never reach a required
   path, vary the fixtures, not the brief or the steps, or report that path as
   UNVERIFIED. Repeated success on one narrow path cannot establish broader
   readiness. Keep optional wishes, non-material suggestions and external
   BLOCKED gates visible; no finding count proves absence of defects. When the
   round cap or an external blocker stops the loop, report NOT CONVERGED or
   BLOCKED with the remaining work, not acceptance. Setup cleans isolated
   fixtures in `finally` after every round, including failed/aborted rounds.

If a fresh agent or authorized test transport is unavailable, record independent
acceptance as BLOCKED and report the scripted checks separately. Do not invent
an independent result. Do not deploy or publish merely to obtain acceptance.

## Give the agent a role and the user's brief

Fill in a brief like this using the actual user's request and authorized
scope. Do not replace it with a sequence tailored to existing tools:

> You are a [business role] working in [business context]. The user requested:
> [original brief, explicit requirements and exclusions]. You are authorized
> to test with fictional data through [transport] within [allowed actions and
> tool/time/write budgets]; [owner] will clean up the fixtures.
> Independently define realistic acceptance goals and observable success
> criteria before testing. Discover the MCP tools and assess whether their
> design lets you make the decisions your goals require, not merely issue
> successful calls. Report per-goal PASS/FAIL/BLOCKED with readback
> evidence, design shortcomings, interaction costs and minimal improvements.
> Distinguish failures within the requested scope from newly inferred product
> needs; do not invent unsupported tools or change the product. Do not inspect
> source, internal docs or a database, blindly retry uncertain writes, or act
> outside the supplied authority. Finding no defects is acceptable; report
> what you actually covered and what remains unverified.

The author separately verifies isolation between callers, stale-version
refusal, unknown-outcome handling and effects hidden from the evaluator's role
through authorized test fixtures. Do not grant the evaluator extra authority
just to observe hidden state. Keep author regressions distinct from what the
fresh agent actually observed.

## Record evidence in the existing issue or handoff

Use ordinary Markdown; no new receipt schema or framework is required:

- Original brief, explicit requirements and exclusions, role, environment,
  per-round budgets and round cap.
- Setup assistance and what each agent could access; identify distinct rounds.
- Per round: revision, the evaluator's own goals and criteria, per-goal
  PASS/FAIL/BLOCKED, actual readbacks and call references, tool/page counts
  and negative/recovery attempts, with their differing scope stated.
- Findings ledger with materiality, owner, disposition, minimal repair and
  regression commands/results.
- Streak and reset history; coverage of each explicit requirement
  (evaluator-observed, author regression only, or UNVERIFIED); the final
  CONVERGED / NOT CONVERGED / BLOCKED verdict and rounds used. Retain every
  failed report.
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
