# Independently accept a user-facing workflow

Before reporting any user-facing deliverable as done, exercise it from the
user's position with a fresh end-user agent. This applies to Admin pages and
customisations, application pages and web routes, REST APIs used by clients,
MCP tools and MCP Apps. Generation, typechecking, scripted smoke tests and an
author's replay remain useful; they do not establish independent acceptance. A
fresh context is not enough if the author still chooses a workflow that mirrors
the implementation. Every acceptance round gives the evaluator only a
role and the entry points that role uses; it derives realistic tasks itself
and the author scores them against a private rubric.
If independent acceptance is not run, report `UNVERIFIED`; if a fresh evaluator
or authorized test transport is unavailable, report `BLOCKED`; neither outcome
is done.

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
4. **One fresh agent per role, every surface.** For the default two roles, run
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
   the product.
6. **Repair outside the evaluator's context, then start over.** The author keeps
   the findings ledger, makes the smallest in-scope repair, adds focused
   regressions (authorization, OCC, atomicity), and freezes a new revision.
   The next round uses new agents and new fixtures and passes them nothing
   from earlier rounds.
7. **Converge or stop.** A round converges when it has no P0 or P1 and the
   evaluators' observed results cover every rubric item visible to their roles;
   items outside any role's view (another caller's isolation, hidden state)
   need author regressions, reported under that label. Run at most three
   rounds. If the third still has a P0 or P1 or an uncovered rubric item, report
   BLOCKED with the remaining ledger, not acceptance. Setup cleans fixtures in
   `finally` after every round, including aborted ones.

If a fresh agent or authorized test transport is unavailable, record independent
acceptance as BLOCKED and report the scripted checks separately. Do not invent
an independent result. Do not deploy or publish merely to obtain acceptance.

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
> helped. Report what you covered and what you could not reach; finding nothing
> wrong is acceptable.

The author separately verifies isolation between callers, stale-version
refusal, unknown-outcome handling and effects hidden from the evaluator's role
through authorized test fixtures. Do not grant the evaluator extra authority
just to observe hidden state. Keep author regressions distinct from what the
fresh agent actually observed.

## Record evidence in the existing issue or handoff

Use ordinary Markdown; no new receipt schema or framework is required:

- Original brief, the private rubric, roles, environment, per-round budgets
  and round cap.
- Setup assistance and what each agent could access; identify distinct rounds.
- Per round: revision, each evaluator's derived goals (first list and
  refinements) and criteria, the gaps between them and the rubric, per-goal
  PASS/FAIL/BLOCKED, actual readbacks and interaction references,
  request/page/tool counts
  and negative/recovery attempts, with their differing scope stated.
- Findings ledger with P0–P3, owner, disposition, minimal repair and
  regression commands/results.
- Coverage of each rubric item (evaluator-observed, author regression only, or
  UNVERIFIED); the final CONVERGED / BLOCKED / UNVERIFIED verdict and rounds
  used. Retain every failed report.
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
