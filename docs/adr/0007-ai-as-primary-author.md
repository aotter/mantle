# ADR-0007: AI-as-primary-author — three feedback loops, two role surfaces

**Status:** Carried over from POC v0.0.x; refreshed and folded for v0.1.0 (incorporates POC ADR-0013).

**Date**: 2026-05-03

**Deciders**: phsu

**Related**: ADR-0001 (the manifest the contract operates on), ADR-0008 (the structured diagnostic shape this contract emits)

---

## Context

This ADR is the local statement of an Aotter-wide thesis. mantle is
one half of **Mantle** (**C**onfig **L**anguage for **A**pps &
**M**odeling) — the other half is the OLAP / data-warehouse work in
[`aotter-mantle`](https://github.com/aotter/aotter-mantle). Both share a
single design grammar:

> **Agents write config; the runtime carries the complexity.**

Hard problems — schema validation, OAuth, locale canonicalization,
cache invalidation, transactional state — live in the runtime, where
they're written once by people who understand them. The authoring
surface is YAML the agent fills in, with structured diagnostics
catching mistakes before they become production failures. Non-coders
benefit from agent leverage *safely* because the load-bearing logic
isn't in their hands.

This ADR documents what that thesis means concretely for mantle's
authoring contract.

The primary author/integrator of consumer apps that depend on
`@aotter/mantle-*` is expected to be Claude Code (or a peer LLM
agent) running inside the consumer project. Human contributors review
and steer, but the moment-to-moment work — wiring a manifest, writing
a Procedure handler, registering it at boot, bisecting a failure — is
the AI's.

This is a different DX target from the typical SDK. Conventional
"developer experience" thinking optimizes for a human at a terminal:
prose error messages, IDE squiggles, stack traces inspected by eye,
"let me try one more thing and see what the server logs say." That
loop is fine for humans and bad for AI authors:

- An AI cannot cheaply form an intuition by "running the thing and
  seeing what happens." It can run a CLI and read structured output;
  it cannot easily watch a streaming server log over an SSH session
  and infer state.
- Prose error messages force the AI to do natural-language parsing
  before it can act. Structured diagnostics ({code, path, expected,
  actual, candidates, suggestion}) are directly actionable.
- Errors that surface only at production runtime are invisible to an
  AI working in a dev loop — by the time they appear, the AI has
  finished its turn and walked away. Failures must show up in the
  feedback channel the AI is currently watching: the CLI it just ran,
  the test suite it just executed, the deploy it is currently
  blocking on.
- "Try and see" debugging on an opaque deployed system has a long
  feedback latency that compounds badly with AI cost-per-turn. Cheap,
  deterministic, local feedback dominates.

The naive SDK posture is "it works at runtime, errors come back as
HTTP 500s." That is the correct target for the customer of the
consumer's app. It is the wrong target for the consumer-app author.

This ADR defines the contract that fixes that gap. It also folds in
the role-split decision (originally POC ADR-0013), because the
feedback loops below only make sense when paired with the question of
*which AI is reading them*: the **coder agent** (Claude Code in the
consumer's repo) versus the **operator agent** (a content-editing
client like Claude Desktop, talking to the deployed Worker over MCP).

## Decision

### Part A — Three feedback loops for the coder agent

The SDK provides **three explicit feedback loops**, ordered by
"leftward shift" — catch the failure as early in the author's
workflow as physically possible:

#### Loop 1 — Static validation (`mantle validate`)

Pure manifest + handler-source check. No D1, no runtime, no
network. Runs in the AI's terminal in milliseconds. Reads YAML files
and handler registration source files; emits structured diagnostics;
exits non-zero on any error.

The CLI ships in the `@aotter/mantle-spec` package — it's the
spec authority for what a v0.1 manifest must look like.

What it catches:
- Manifest envelope (`apiVersion`, `kind`, `metadata.name`)
- `Trigger.target.procedure` references a Procedure that exists
- `View.from` references a Schema that exists; `View.fields` and
  `View.filter` refer only to declared properties of that Schema
- `Schema.uniqueIndexes` and `Schema.indexes` contain valid ordered
  tuples of scalar properties declared in `spec.schema.properties`
- `x-mantle-bind: <value>` is in the closed enum
- `requires.auth.all` predicates are in the v0.1 vocabulary
- `Trigger.source.path` does not collide with another Trigger
- `metadata.name` is unique within `kind`
- Each `Procedure.handler.ref` has a corresponding
  `sdk.registerHandler("<ref>", ...)` call somewhere in the
  consumer's TS source (textual grep, not runtime — boot loop is
  Loop 2's job)

This is the cheapest loop; it must be runnable without booting
anything. AI authors should run it after every manifest edit.

#### Test harness (planned public package surface)

Supporting tooling that consumers use inside their own test suites —
it is not itself a feedback loop, it's the harness those tests run
against. In-memory dispatcher invocation: the consumer's test suite
imports a public testing module that spins up a complete dispatcher
against an in-memory D1 substitute, seeds rows, and calls Procedures
or Views directly without going through HTTP.

Target API sketch:

```ts
import { createTestDispatcher } from "@aotter/mantle-runtime/testing";
import { manifests } from "../manifests"; // loaded by build hook
import { handlers } from "../handlers";   // map of ref → fn

const dispatcher = await createTestDispatcher({ manifests, handlers });
await dispatcher.seed({ collection: "posts", rows: [...] });

const result = await dispatcher.invoke(
  "send-contact-message",
  { name: "Alex", message: "hi" },
  { user: { id: "user-uuid" } },
);
expect(result).toEqual({ ok: true });

const view = await dispatcher.queryView("recent-published");
expect(view.items).toHaveLength(2);
```

Catches:
- Handler logic bugs (validation rules, branching, error returns)
- Auth predicate evaluation (handler called with wrong user/staff
  context returns `AUTH_DENIED`)
- Input/output schema enforcement (caller-supplied `x-mantle-bind` field
  is rejected; handler-returned shape mismatching `output` is
  rejected)
- View result correctness against fixture data
- Cross-Trigger correctness when one Procedure has multiple bindings

The test harness is **not** mocked — it should share the real
dispatcher, validator, handler registry, and in-memory runtime ports.
The public `testing` export has not shipped yet; current v0.1.0 code
uses runtime package tests plus starter integration smokes to cover
the same contract until the consumer-facing harness is promoted.

#### Loop 2 — Boot-time fail-fast

Dispatcher build phase, after manifests are parsed and handlers are
registered, before the serve loop starts. Walks the entire manifest
graph and the in-memory handler registry; refuses to start serving if
anything is missing or inconsistent.

What it catches that Loop 1 cannot:
- `Procedure.handler.ref` that has a `sdk.registerHandler(...)` call
  in source (Loop 1 saw it textually) but did not actually execute
  (e.g. the registration file wasn't imported, the boot function was
  skipped behind a feature flag)
- D1 schema drift — table state in the connected D1 does not match
  the DDL derived from current manifests; SDK refuses to serve until
  a migration is applied or the drift is acknowledged
- Cross-manifest references that a recent deploy introduced without
  the corresponding atom (e.g. updated Trigger pointed at a Procedure
  that wasn't included in the deploy bundle)

Failure mode is **process exit non-zero**, not "log a warning and
serve anyway." A missing handler must not surface as a runtime 500 to
a customer; it must surface as a boot failure to the deploy pipeline,
which is visible to the AI author who just shipped.

#### Loop 3 — Runtime errors

Runtime diagnostics (see ADR-0008 and the design-atoms reference)
cover the cases that reach this far. The contract's job is to make
Loop 3 the layer that handles **input it had no way to predict**
(request shape, auth state, transient infrastructure failures), not
the layer that handles **author-side mistakes** (those are Loops 1
and 2's job).

#### Phase ordering rationale

The author's lifecycle is:

```
edit YAML → run validate (Loop 1) → run tests (test harness)
         → push → deploy boots (Loop 2) → serves (Loop 3)
```

The earlier a class of error is caught, the cheaper it is to fix and
the smaller the surface area for surprise. An author waits seconds for
`validate`, seconds-to-minutes for the test suite, minutes for boot,
hours-to-days for runtime errors to be reported. The discipline is:
**never let a class of error surface in a later loop than where it
could have been caught**. If the validator could find it, boot must
not be the first to find it.

An earlier draft of this contract ordered Boot before Test. That was
wrong: tests run during the AI's edit cycle, on the AI's machine,
inside the same turn. Boot runs only after a deploy is committed.
Tests must be left of Boot in the diagram and left of Boot in the
discipline.

### Part B — Role-split surfaces

(Folded in from POC ADR-0013, which was a separate ADR in the POC tree
and is consolidated here in v0.1.0.)

Two AI agents read and write to a `@aotter/mantle-*` deployment:

1. **The coder agent** — Claude Code (cc) running inside the
   consumer's repo. Edits manifests, handlers, scaffold files,
   `wrangler.toml`. Runs CLI commands (`mantle validate`,
   `mantle emit-openapi`). Reads skill files. Has shell, filesystem, git,
   and network access in the consumer's dev environment.

2. **The operator agent** — a content-editing client (Claude Desktop,
   claude.ai, or any MCP-speaking host) connected to the deployed
   Worker's `/mcp` endpoint over OAuth. Calls the Day-1 MCP tool
   catalog: generic tools (`list_entries`, `get_entry`,
   `request_publish`, `unpublish_entry`, `archive_entry`) plus
   per-collection authoring tools (`create_draft_<collection>`,
   `update_draft_<collection>`). Has *only* the MCP tools the Worker
   exposes; no shell, no filesystem, no git.

These are different roles with different *capability surfaces*. The
coder agent has many more capabilities than the operator agent *by
virtue of where it runs*, not because anyone designed the asymmetry —
it's a property of the environments. cc can run an arbitrary command
in the consumer's repo; an MCP-only client cannot.

Without an explicit principle, every feature decision can be expressed
on either surface. "Should `mantle validate` also be an MCP tool?"
"Should `update_draft` also be a CLI command?" Answered ad-hoc, the
two surfaces drift toward feature parity, which destroys the role
boundary, which destroys the security and DX properties the boundary
protects.

The SDK has **two surfaces, mapped to two roles**:

| Surface | Audience | Trust | Default access |
|---|---|---|---|
| **Skills + CLI + SDK TS API** | the coder agent (cc) | unconstrained — runs in consumer's repo | filesystem, shell, git, full SDK |
| **MCP tools** | the operator agent (MCP client) | constrained — ops session over OAuth | only the verbs declared in the Day-1 catalog |

The two surfaces are **not symmetric** and should not become
symmetric. Each new feature picks **one** surface based on which role
needs it; if the answer is "both," the feature is fundamentally about
content state (in which case it belongs on MCP and the coder uses the
SDK TS API instead of needing a matching MCP tool).

#### What goes on Skills + CLI + SDK TS API (coder surface)

- Anything that touches the **manifest set** (Schema / View /
  Procedure / Trigger declarations). The coder edits YAML; the
  operator never sees the manifest layer.
- Anything that requires **shell or filesystem access** —
  scaffolding, test running, deploy.
- Anything **dev-loop shaped** — the three feedback loops above
  (validate / boot / runtime) plus the test harness are
  coder-surface concerns, not operator-surface.
- Anything that **mutates code** in the consumer's repo — registering
  handlers, wiring imports, updating `wrangler.toml`.
- **Skill files** carrying domain context. cc reads these; MCP clients
  do not.

Concrete artifacts today:
- `skills/<name>/SKILL.md` files in the
  [`aotter/mantle`](https://github.com/aotter/mantle)
  repo, discoverable by URL. Distribution as a Claude plugin is
  **optional** (a v0.1.x convenience), not required — the canonical
  location is the in-repo path, and any agent that can fetch a URL
  can consume them.
- `mantle validate` CLI (shipped in `@aotter/mantle-spec`)
- `mantle emit-openapi` CLI (likewise)
- Public testing harness (planned; current coverage is SDK tests +
  starter integration smokes)

#### What goes on MCP (operator surface)

- **CRUD on content state** — the Day-1 generic tools plus the
  per-collection create/update tools generated from Schemas.
- Anything an **operator user** would do in a hypothetical WordPress
  admin: write a post, update a draft, request publish, list
  submissions.
- Future ops-role verbs that don't exist yet but have an obvious
  operator use case ("translate this draft", "schedule for Friday").
  When added, they land as **new SDK builtin tools** — declared in
  the MCP catalog source under the closed Day-1 set, not
  auto-generated from consumer Procedures.

#### What goes on neither (the SDK TS API only)

A small third category exists: APIs that only the **runtime itself**
consumes (the dispatcher, the boot validator, the diagnostic types).
These are exported from `@aotter/mantle-spec` for the coder to
import inside their handler code, but are not CLI commands and not
MCP tools — they're library types.

#### What does NOT go on either surface

- **Consumer Procedures auto-emitted as MCP tools.** This was
  considered as `Trigger.source.kind: mcp` and rejected. A
  consumer-defined Procedure carries arbitrary code; auto-emitting it
  to MCP would let the operator agent trigger arbitrary side effects
  defined by the coder agent. The role boundary collapses. Ops-role
  verbs land as SDK builtins, not as auto-bound consumer Procedures.
- **CLI commands that mutate runtime state.** The CLI is for the
  pre-deploy authoring loop. Once deployed, runtime state changes via
  MCP (operator) or via direct SDK calls inside handler code
  (developer). No `mantle publish-entry <id>` is planned — that
  would mix the two surfaces.

## Consequences

### Pros

- Errors land in the channel the coder agent is watching at the
  moment they author. Validation errors → terminal output of the CLI
  they just ran. Test errors → test runner output of the suite they
  just executed. Boot errors → deploy pipeline log the deploy is
  blocked on. Runtime errors → customer-visible failures (the only
  place runtime errors should appear).
- One diagnostic format (ADR-0008) across all loops means the coder
  agent writes one parser, not three.
- Test harness as a public SDK export means consumer apps can ship
  handler tests as part of normal CI without wiring up their own
  dispatcher harness.
- Boot fail-fast turns a class of "runtime 500 reaches customer"
  failures into "deploy blocked, fix forward" failures.
- The framing — coder agent as primary author, operator agent as
  bounded MCP consumer, with explicit phase ordering — gives reviewers
  a yardstick for proposed SDK features: "which loop does this
  affect, and which surface owns it?" New error types must declare a
  code.
- Permission boundary maps cleanly to surface boundary. The operator
  agent's permissions are bounded by the MCP tool catalog; the coder
  agent's by what shell + git + the SDK can do. Neither agent can
  escalate by switching tools.
- MCP catalog stays narrow as a **property**, not a discipline.
  Adding things to MCP requires demonstrating an operator-role use
  case.

### Costs

- v0.1 ships more than just a runtime: also the `mantle validate`
  CLI, a public testing module, and a boot validator. Roughly +30%
  of the v0.1 dispatcher work.
- Test harness needs an in-memory D1 substitute (most plausible:
  `better-sqlite3` or an equivalent SQLite binding running the same
  DDL the production D1 adapter applies). Adds a dev-dependency to
  the SDK and a compatibility surface to keep honest against real D1
  quirks.
- Diagnostic format is locked early (ADR-0008); any field-shape
  change forces a doc revise and a code change across all loops.
- The error catalog (one named code per failure mode, per loop) must
  stay synchronized with the validator/harness/runtime
  implementations. A regression where the validator and the boot
  loop emit different codes for the same underlying issue would
  defeat the point.
- Two surfaces means two surfaces. Documentation, releases,
  versioning, and contracts apply to both. Mitigated by the fact
  that the two surfaces have little overlap by design — most features
  touch only one.
- No cross-surface convenience. A hypothetical "consumer defines a
  Procedure that's also an MCP tool with one YAML block" would be
  ergonomically nice but is structurally rejected by Part B.

### Risks

- **Validator under-approximates** (rejects valid manifests): authors
  will route around it (`--no-validate` etc.), defeating the purpose.
  Mitigation: validator MUST err on the permissive side; ambiguous
  cases emit `severity: warning` not `error`; exit code 0 unless an
  error is found.
- **Test harness diverges from runtime**: in-memory SQLite has
  slightly different SQL semantics (collation, type affinity, JSON1
  edge cases) from production D1. Tests pass here, prod fails. Same
  trap as mocking the database. Mitigation: SDK itself runs starter
  integration tests against real D1 in CI; document the
  known-divergence list in the testing module's README.
- **Boot fail-fast aggressiveness**: if boot refuses to start on
  cosmetic issues (a Schema property has an unrecognized but harmless
  `x-` extension), the deploy pipeline becomes hostile. Mitigation:
  boot validates only **load-bearing** invariants (missing handler
  refs, dangling Trigger targets, schema drift). Cosmetic / advisory
  checks are warnings via `--strict` flag, not errors.
- **AI authors over-trust the contract**: "the SDK said it was fine
  therefore it is fine." Loop 3 (runtime) still exists for reasons
  the contract cannot prevent. Mitigation: docs make clear that
  runtime errors are still possible and that the contract reduces —
  not eliminates — surface area.
- **Drift via "MCP-ifying everything".** The MCP transport is trendy;
  there's pressure (industry-wide) to expose every API as MCP.
  Following that trend would erase the role boundary. Mitigation:
  this ADR is the bar to clear. Any "expose X as MCP" PR has to
  argue X is operator-role.
- **Confusion when cc *uses* MCP tools to inspect a deployed
  worker.** cc CAN call MCP tools (it has MCP-tool capability). This
  isn't a violation — when cc calls MCP tools, it's playing the
  operator role to inspect runtime state, not extending the coder
  surface. The principle is about which surface a feature is
  *exposed on*, not who calls into it.
- **Future Anthropic SDK changes that blur the line.** If Claude
  Code gains MCP-tool-only modes, or if MCP clients gain shell
  access, the role/surface mapping might need revision. This ADR is
  grounded in the current capabilities asymmetry; if that asymmetry
  collapses, supersede with a new ADR.

## Alternatives considered

**(a) Runtime errors only.**
Rejected: primary author is AI; CF deploy logs are an inappropriate
UI for that author. Failures must land in the loop the author is
currently in.

**(b) Static validation only.**
Rejected as insufficient: cannot catch handler logic bugs, cannot
verify that a `registerHandler` call actually executes (only that it
appears textually), cannot test data-flow against fixtures.

**(c) Test harness only.**
Rejected: better than (a) but still lets misconfigurations land in
deploys (handler renamed but not re-registered, manifest references
stale schema name). Static is cheaper and finds these faster.

**(d) Skip the test harness; rely on consumer's own integration
tests.**
Rejected: it is the SDK's job to make handler-level testing trivial;
pushing the dispatcher-spin-up burden to every consumer is exactly
the kind of boilerplate that demotivates writing tests in the first
place.

**(e) Prose error messages.**
Rejected: see ADR-0008. AI parseability outweighs human readability
for the primary author; a `--format=text` mode preserves the human
option without locking the structure.

**(f) Feature parity across both surfaces.** Every CLI command also
an MCP tool; every MCP tool also a CLI command. Rejected: this
destroys the role boundary by giving each agent all capabilities.
The "operator agent has fewer capabilities than the coder agent"
property would no longer be a structural fact about the surfaces; it
would be a discipline imposed on individual operator sessions, which
we have no way to enforce.

**(g) MCP-only — drop the CLI.** All SDK operations as MCP tools.
Rejected: cc loses the sub-second feedback loops that depend on CLI
tools (validate, typecheck, build). MCP tool calls are slower (HTTP
round trip, JSON-RPC envelope), and harder to integrate into editor
/ filesystem contexts where cc lives.

**(h) CLI-only — drop MCP.** All operations as CLI; the operator
agent shells out. Rejected: the operator agent (an MCP-only client)
can't shell out. MCP exists precisely because the operator-role
environment doesn't have a shell.

## How to apply

When proposing a new SDK feature or behavior, declare:

1. **Which agent runs this?**
   - If the coder agent → CLI subcommand and/or SDK TS API and/or
     SKILL.md section.
   - If the operator agent → MCP tool added to the Day-1 catalog.
   - If "both" — recheck. The feature is probably fundamentally a
     CRUD-on-content verb (operator → MCP, coder uses the SDK TS API
     directly) or a manifest-side authoring concern (coder →
     CLI/skills, operator never sees it). Real "both" cases should
     be vanishingly rare.

2. **Which loop owns the failure mode?** (Loop 1 static, Loop 2
   boot, Loop 3 runtime)

3. **Could it move left?** (e.g. a runtime check that could be a
   boot check, a boot check that could be a static check)

4. **Does it emit the structured diagnostic shape?** (ADR-0008)

5. **Can a consumer reproduce the failure offline?** (i.e. is it
   visible to Loop 1 or to the test harness, not only Loop 3)

6. **Does the feature mutate the consumer's repo?** → CLI (or SDK
   API the CLI uses). Never MCP — the operator agent is not in the
   consumer's repo.

7. **Does the feature observe / mutate runtime state in the deployed
   Worker?** → MCP tool, with the ops-role description in the
   tool's `description` field. Or HTTP Trigger + handler if the
   feature is consumer-shaped (a Procedure the consumer wrote).
   Don't auto-bridge consumer Procedures to MCP.

Reviewers should treat "this lands as a runtime 500 only" as a
yellow flag — sometimes correct (genuine runtime conditions), often
a sign that earlier loops were not considered. Likewise, when a PR
adds either an MCP tool or a CLI command, check whether the *other*
surface tries to mirror the change. If yes, that's a flag — push
the proposer to pick one surface or to articulate a real two-role
use case.
