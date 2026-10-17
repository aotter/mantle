# Accept an MCP business workflow with a fresh end-user agent

Before claiming that an agent can complete a business workflow, exercise the
public tool contract from that user's position. Generation, discovery and a
scripted smoke test remain necessary; they do not establish that a new agent
can discover and use the workflow without the author's recipe.

Use this loop when accepting a new or changed MCP business workflow. It is an
application-authoring practice, not an SDK runtime service or a new test runner.
Use the project's existing local smoke setup, normal authorized sign-in and
isolated fixtures. Keep credentials inside setup; give the agent only its
authorized transport. Do not enable extra routes, roles or generic writes to
make the exercise pass.

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
