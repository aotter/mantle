# Independently accept a user-facing workflow

Before reporting any user-facing deliverable as done, exercise it from the
user's position with a fresh end-user agent. This applies to Admin pages and
customisations, application pages and web routes, REST APIs used by clients,
MCP tools and MCP Apps. Generation, typechecking, scripted smoke tests and an
author's replay remain useful; they do not establish independent acceptance. A
fresh context is not enough if the author still chooses a workflow that mirrors
the implementation. Every acceptance round gives the evaluator only a
role and the entry points that role uses; it derives realistic tasks itself
and the author scores them against a private rubric. The first delivery gets
full acceptance; after a repair, the change decides what
[re-runs](#re-verify-what-a-repair-touches).
If independent acceptance is not run, report `UNVERIFIED`; if a fresh evaluator
or authorized test transport is unavailable, report `BLOCKED`; neither outcome
is done. Either way, report the evidence you do have in the
[layered handoff](#report-done-ness-in-layers).

Use the surface the intended user actually uses: a real browser session for
Admin and application pages; for REST, an HTTP client plus the public API
reference and base URL a real client developer receives; an MCP client for
tools; and the real MCP App host/AppBridge flow for Apps. This is an
application-authoring practice, not an SDK runtime service or a new test runner.
Use the project's existing local setup, normal authorized sign-in and isolated
fixtures. Setup hands over the role's established browser session or client
token; the evaluator never acquires or widens credentials. Give it only its
authorized surface. Do not enable extra routes, roles or generic writes to make
the exercise pass.

## Audit MCP tool design before implementation

Start with the original user brief, business role and explicit requirements,
not a list of CRUD endpoints or a task derived from what you implemented.
Before writing manifests or handlers, record the intended jobs and assumptions
in the existing design note. The capability map feeds the private rubric
(below); an evaluator receives only its role and chooses its own tasks and
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
atomicity and other relevant regressions. Follow the independent acceptance
rounds below before claiming the user-facing work is done. Keep the author's
capability map and worked call sequence out of the fresh agent's prompt: an MCP
evaluator must discover the workflow from public tool descriptions and results.

## Run role-only acceptance rounds until they converge

The evaluator gets a role, not a task list. It works out what that role needs
to get done from the interface itself; what it derives, and what it misses, is
the evidence.

1. **Write a private rubric first.** From the original brief, the author lists
   what each role must be able to do on each surface (Admin, application
   pages, REST, MCP), with observable success criteria, explicit exclusions
   and the authority each role must not have. The rubric stays with the author;
   no evaluator ever sees it, its wording or its order.
2. **Hand each evaluator only its role.** Supply the business role and context
   in one or two sentences, the entry points that role really uses (Admin URL,
   site URL, REST base URL and API reference, MCP endpoint), a signed-in browser
   session or client token from setup, the interaction/time/write budget,
   permitted fake-data actions and what is forbidden (source, SQL, internal
   docs, the database, other roles' credentials, blind retries of uncertain
   writes). Withhold the brief's requirement list, capability maps, tool names,
   precomputed IDs and earlier reports. Seed realistic fixtures: other owners'
   records, several states and more than one page of results. Run the evaluator
   outside the project directory, without Mantle skills or project instruction
   files, and record that isolation.
3. **Let it derive the work, then do it.** Before any interaction the evaluator
   writes down what this role would need to accomplish and how it would know
   each one succeeded. It then refines that list as it discovers the interface
   (at least once after a first look, again after its first attempts), executes
   it, and reports PASS/FAIL/BLOCKED per goal with readbacks, rejected writes,
   recovery attempts and interaction counts. Zero findings is a valid result.
4. **One fresh agent per role, every surface.** In the first round, and in any
   round the [re-verification rule](#re-verify-what-a-repair-touches) widens
   to all of them, cover every role and surface. For the default two roles, run
   an `admin` evaluator and a `user` evaluator in the same round on shared live
   data, in the brief's natural order. Between them they cover every surface
   the app exposes to each role: Admin for `admin`, pages for visitors and
   members, REST for client developers, MCP for both roles' AI clients. A
   surface no evaluator reached stays UNVERIFIED.
5. **Score against the rubric outside the evaluator.** The author compares the
   evaluator's derived goals and results with the rubric. A rubric item the
   evaluator never thought of is itself a finding: the interface did not make
   that job discoverable. Classify every finding P0 (data loss, authority or
   integrity defect, uncertain write), P1 (a rubric item FAIL, BLOCKED or not
   discoverable), P2 (friction) or P3 (suggestion), with evidence and the
   smallest repair. Separate a violated explicit requirement, a demonstrated
   defect and a newly inferred product wish; a wish is not permission to grow
   the product. A goal the evaluator's own environment stopped (its tool
   approval, sandbox or network, not an app refusal) is not a finding: record
   it as an [environment block](#report-done-ness-in-layers) and rerun that
   role once it is lifted.
6. **Repair outside the evaluator's context, then re-verify what it touches.**
   The author keeps the findings ledger, makes the smallest in-scope repair,
   adds focused regressions (authorization, OCC, atomicity), and freezes a new
   revision. The next round re-runs the roles and surfaces the
   [re-verification rule](#re-verify-what-a-repair-touches) names, with new
   agents and new fixtures, and passes them nothing from earlier rounds.
7. **Converge or stop.** A round converges when it has no P0 or P1 and
   evaluator-observed results cover every rubric item visible to their roles:
   from this round, or reused from an earlier round under the
   re-verification rule. Items outside any role's view (another caller's
   isolation, hidden state) need author regressions, reported under that
   label. Run at most three
   rounds. If the third still has a P0 or P1 or an uncovered rubric item, report
   BLOCKED with the remaining ledger, not acceptance. Setup cleans fixtures in
   `finally` after every round, including aborted ones.

If a fresh agent or authorized test transport is unavailable, record independent
acceptance as BLOCKED and report the scripted checks on their own
[layers](#report-done-ness-in-layers). Do not invent
an independent result. Do not deploy or publish merely to obtain acceptance.

Acceptance proves the behavior, not its speed. For every role and surface a
round reports CONVERGED, the [performance pass](performance.md)
decides which performance checks apply and holds them to their targets. BLOCKED
or UNVERIFIED parts are reported as they are, never optimized. A performance
repair that changes what a role sees or can do returns here, scoped by the
[re-verification rule](#re-verify-what-a-repair-touches).

## Re-verify what a repair touches

The first delivery always gets full acceptance: every role, every surface.
After a repair, the change itself decides what runs again, not the finding
that prompted it. Rounds before convergence are not accepted, so diff against
evidence, not rounds: for each item you want to reuse, diff the current
revision against the revision it was observed at, and pick the widest row that
diff matches. A chain of repairs adds up; a page-only repair followed by a
handler repair has to re-run what the handler repair reaches.

| The repair changes | Re-run with fresh evaluators | May reuse |
| --- | --- | --- |
| Only presentation: page or Admin layout, CSS, copy, client-side display | Blind acceptance of the affected UI, for each role that uses it. A shared component or layout affects every page that renders it. | REST and MCP evidence from the same business-rule version |
| A public contract: a tool or route description, input, output or error shape; the generated client or other `generated/` output it changes | That surface for each role that uses it, plus every UI that consumes it | Other surfaces at the same business-rule version |
| Authentication, sessions, roles, `requires`, row or tenant scope | Every surface that the changed rule guards, for every affected role | Nothing those surfaces depend on |
| A SQL Procedure or View, a `uniqueIndexes` entry, a check or lock, a migration that changes results, a handler's business rule | Every surface that reads or writes that data | Nothing those surfaces depend on |
| A shared transport: the service entry, routing, the HTTP or MCP mount, a shared error envelope | Every surface on that transport | Nothing on that transport |

The business-rule version is the revision of the manifests, SQL, migrations,
handlers, authorization and service entry. A repair that changes none of
them keeps that version, so evidence collected at it still stands for
surfaces the repair did not reach. A repair that changes any of them
starts a new business-rule version, and looking at the UI alone is not
enough. One exception: a repair that only adds or drops a non-unique Schema
`indexes` entry and its migration keeps the version. It changes speed, not
which rows a read returns or which writes are refused. A `uniqueIndexes`
entry, a check or a lock does change which writes succeed, so it falls in the
SQL row. When the diff is unclear, widen.

Every row still runs the author's regressions on the new revision (layers 1
and 2 of the [layered report](#report-done-ness-in-layers)): `pnpm check`,
`pnpm smoke`, `pnpm test` and the focused regressions for the repair.

A re-run evaluator is as fresh as the first: a new agent, new fixtures, only
its role and the entry points under re-test. Do not tell it what was
repaired, what to check or what an earlier evaluator did. No previous
answers, rubric or precomputed steps.

For every rubric item that was not re-run, record the round and revision its
evidence comes from and why the changes since that revision could not affect
it. Never report a
reused item as observed in a later round.

## Hand each role to its evaluator

Setup signs each role in; the evaluator receives the role's access, never a credential it could reuse or widen.
This is the authorized test transport the BLOCKED rule above refers to.

- **Local session URL (the app shell's default).** `pnpm accept` in an app written by `mantle init` starts the app
  on a fresh local D1, signs the admin in, runs an optional fixtures module, signs the user in and prints one local
  URL per role. Each URL forwards every request with that role's session and refuses `/api/auth/*`. Give the
  evaluator only its URL: MCP at `<url>/mcp` (user) or `<url>/mcp/admin` (admin) for any streamable HTTP MCP client,
  Admin at `<url>/admin` and member pages at `<url>/` in a browser, REST at `<url>/` with no credential. An evaluator
  without an MCP client uses `node accept.mjs mcp <endpoint> [tool [json]]`, which prints the raw result including
  `isError`. The app README's "Independent acceptance" section shows the fixtures module.
- **An external MCP host over OAuth.** To accept the connection a real client uses (Claude, ChatGPT or another host
  that supports MCP OAuth), deploy or tunnel the app as you would for that host, add `<origin>/mcp` or
  `<origin>/mcp/admin` to the host in setup, and complete sign-in and consent as the role's fictional identity. The
  evaluator then works in that already-connected host. Its token stays in the host; the evaluator neither sees nor
  requests it. Record this as OAuth evidence, separate from the local session URL (see
  [OAuth](oauth.md)).

Either way, the evaluator's prompt names the URL or the connected host, never a cookie, token or sign-in step.

If you cannot start a fresh agent yourself (for example, you are a subagent without that tool), prepare everything
else: the rubric, the fixtures module, `pnpm accept` running, and one filled-in role prompt per role (below) naming
its URL. Hand the prompts to whoever can start agents (the person or the orchestrating agent), keep the app running,
and report acceptance as BLOCKED with the prompts attached until their reports come back. Score those reports as
usual.

## Give the agent a role

Fill this in per role. It names the role and the doors, never the jobs:

> You are [role, for example "a purchasing manager"] at [business context in
> one sentence]. You use [entry points for this role from `pnpm accept`: Admin
> URL, site URL, REST base URL and reference, MCP endpoint]; setup has already
> signed you in as [fictional identity]. Budget: [interactions/time/writes]. You may create and
> change fictional records; [owner] cleans up. Do not read source, internal docs
> or a database, use anyone else's access, or retry a write whose outcome you
> do not know.
> First, write down what someone in this role needs to get done with this
> service and how you would tell each one worked. Refine that list after a
> first look at the interface and again after your first attempts. Then do the
> work and report each goal as PASS/FAIL/BLOCKED with what you read back,
> what was refused, what it cost you, and the smallest change that would have
> helped. For BLOCKED, say whether the service refused you or your own tools
> or permissions stopped you. Report what you covered and what you could not reach; finding nothing
> wrong is acceptable.

The author separately verifies isolation between callers, stale-version
refusal, unknown-outcome handling and effects hidden from the evaluator's role
through authorized test fixtures. Do not grant the evaluator extra authority
just to observe hidden state. Keep author regressions distinct from what the
fresh agent actually observed.

## Report done-ness in layers

Report a handoff in four layers, in this order, each for the exact commit. Each
layer proves something the others do not; a passing layer neither replaces nor
is invalidated by another layer's result.

| Layer | What it proves | Evidence |
| --- | --- | --- |
| 1. Generation and types | Manifests compile, `generated/` is current, the app typechecks and builds. No handler runs. | `pnpm check` (includes `generate --check`), `pnpm build` |
| 2. Business rules and permissions | Handlers on a fresh local D1 over HTTP: each operation at its edges, refusals, caller isolation, visitor pages, MCP discovery, the Admin MCP App loading. Author's evidence. | `pnpm smoke`, `pnpm test`; [Local HTTP checks](local-testing.md) |
| 3. Independent acceptance, per role | A fresh agent given only its role and entry points finds and finishes that role's work on each surface it uses. | Per role: the [rounds](#run-role-only-acceptance-rounds-until-they-converge) verdict and surfaces covered, naming the round and revision of any [reused](#re-verify-what-a-repair-touches) evidence |
| 4. External platform | A real MCP host connects over OAuth; the production origin serves the deployed app. Local cookie sessions prove neither. | Host and version, identity, origin, observed result |

Give each layer, and each role on layer 3, one status:

- **verified**: the evidence above, with its command or host and result.
- **failed**: the product is wrong. Name the failing check or finding.
- **BLOCKED**: the layer could not run. Give the reason, what refused or is
  missing, and what would unblock it.
- **not applicable**: with the reason. Layer 4 is not applicable unless the
  requested work includes an external host connection or a deployment.

A layer nobody attempted is UNVERIFIED, as above. A block from the execution
environment (an agent's approval policy refusing fictional writes, no browser,
no network, a sandbox) is BLOCKED on that layer only. It is never a failed
layer or a product finding, and it does not invalidate the evidence on other
layers. Do not work around it by widening the evaluator's authority, faking a
result or deploying; ask whoever controls the environment and rerun only that
layer on the same revision.

The work is done only when layers 1 to 3 are verified for every role and
surface, and layer 4 is verified or not applicable. Partial evidence is still
reported, layer by layer; it is not done:

```markdown
| Layer | Status | Evidence |
| --- | --- | --- |
| 1. Generation and types | verified | `pnpm check`, `pnpm build` at <commit> |
| 2. Business rules and permissions | verified | `pnpm smoke` (<n> checks), `pnpm test` |
| 3. Acceptance: admin | BLOCKED: evaluator's approval policy refused to create fictional records; needs <permission> | round 1 stopped at goal <n> |
| 3. Acceptance: user | verified: CONVERGED in round <n> | member pages in round <n>; MCP reused from round <m> at <revision> (page-only repair) |
| 4. External platform | not applicable: no deployment or external host requested | |
```

## Record evidence in the existing issue or handoff

Use ordinary Markdown; no new receipt schema or framework is required:

- Original brief, the private rubric, roles, environment, per-round budgets
  and round cap.
- Setup assistance and what each agent could access; identify distinct rounds.
- Per round: revision, business-rule version, the roles and surfaces re-run
  and why (the [re-verification rule](#re-verify-what-a-repair-touches) row),
  each evaluator's derived goals (first list and
  refinements) and criteria, the gaps between them and the rubric, per-goal
  PASS/FAIL/BLOCKED, actual readbacks and interaction references,
  request/page/tool counts
  and negative/recovery attempts, with their differing scope stated.
- Findings ledger with P0–P3, owner, disposition, minimal repair and
  regression commands/results.
- Coverage of each rubric item (evaluator-observed in this round,
  evaluator-observed and reused from round `<n>` at `<revision>` with the reason,
  author regression only, or UNVERIFIED); the final CONVERGED / BLOCKED / UNVERIFIED verdict and rounds
  used, which is layer 3 of the [layered report](#report-done-ness-in-layers).
  Retain every failed report.
- Fixture cleanup result and every remaining limitation.

Keep credentials, raw auth logs, full resource HTML and private operational
details local/private; publish only sanitized contract evidence. Do not claim a
call-cost improvement when rounds exercise different negative/discovery cases.
Version fields usually describe an entity row, not all related aggregates;
state money units and the denominator of any budget or margin calculation.

## Keep surface evidence distinct

Evidence from one surface does not prove another. Tool metadata and protocol
discovery do not prove that an MCP App rendered in its real host through
AppBridge; a REST response does not prove the Admin or application page; and a
browser rendering does not prove an external client can use the REST contract.
Record the actual browser, client or host version, identity, observed interface
and behavior for the deliverable under acceptance. Keep data results available
without Apps; descriptions cannot force a host's generative UI layout. Local
cookie-session acceptance, OAuth client integration and long-term renewal
likewise require their own evidence when they are part of the requested work.
