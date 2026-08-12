# ADR-0007: AI-as-primary-author — three pre-serve loops, two role surfaces

**Status:** Carried over from POC v0.0.x; amended for the shipped v0.1 CLI,
testing, plugin, and MCP surfaces (incorporates POC ADR-0013).

**Date:** 2026-05-03; last amended 2026-08-03

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

### Part A — Three pre-serve feedback loops for the coder agent

The SDK provides **three explicit pre-serve feedback loops**, ordered by
"leftward shift" — catch the failure as early in the author's workflow as
physically possible. Runtime diagnostics remain the final, serving-time
boundary rather than a fourth authoring gate.

#### Loop 1 — Static validation (`mantle validate`)

Pure manifest + handler-source check. No D1, no runtime, no
network. Runs in the AI's terminal in milliseconds. Reads YAML files
and handler registration source files; emits structured diagnostics;
exits non-zero on any error.

The implementation lives in `@aotter/mantle-spec`. Adopters run it through the
umbrella package's `mantle` binary; a direct spec install exposes the fallback
`mantle-spec` binary.

What it catches:
- Manifest envelope (`apiVersion`, `kind`, `metadata.name`)
- `Trigger.target.procedure` references a Procedure that exists
- `View.from` references a Schema that exists; `View.fields` and
  `View.filter` refer only to declared properties of that Schema
- `Schema.uniqueIndexes` and `Schema.indexes` contain valid ordered
  tuples of scalar properties declared in `spec.schema.properties`
- `Schema.searchableFields` contains unique top-level string properties
- `x-mantle-bind: <value>` is in the closed enum
- `requires.auth.all` predicates are in the v0.1 vocabulary
- `Trigger.source.path` does not collide with another Trigger
- `metadata.name` is unique within `kind`
- Each `Procedure.handler.ref` appears as a key in the consumer's TypeScript
  handler map (textual grep, not runtime — boot Loop 3 verifies the actual
  map)

This is the cheapest loop; it must be runnable without booting
anything. AI authors should run it after every manifest edit.

#### Loop 2 — Local tests and measured harnesses

Consumer tests exercise exported runtime use cases or the adapter application
with project-owned fakes appropriate to that test. Core does not ship a second
in-memory Worker or dispatcher abstraction.

The public Node-only `@aotter/mantle/runtime/testing` surface instead provides
the two shared measurements that are expensive for each consumer to rebuild:

- crowded real-SQLite View execution and `EXPLAIN QUERY PLAN` index coverage;
- HTTP sampling for a running Worker, including optional test-only query/row
  metric headers.

The umbrella package exposes both through `mantle-harness`. These checks use the
real manifest validator, migrations, View compiler, SQL, and HTTP surface; they
do not pretend an in-memory adapter proves Cloudflare behavior. Project tests
still own handler logic, auth combinations, and product-specific fixtures.

#### Loop 3 — Boot-time fail-fast

Dispatcher build phase, after manifests are parsed and handlers are
registered, before the serve loop starts. Walks the entire manifest
graph and the in-memory handler registry; refuses to start serving if
anything is missing or inconsistent.

What it catches that Loop 1 cannot:
- `Procedure.handler.ref` that appeared textually in source (Loop 1 saw it) but
  is absent from the actual `handlers` map passed to runtime assembly
- Current site locale state that conflicts with localized/translation Schemas
- Generated index state that cannot be reconciled with declared Schema indexes
- Cross-manifest references that a recent deploy introduced without
  the corresponding atom (e.g. updated Trigger pointed at a Procedure
  that wasn't included in the deploy bundle)

Failure mode is a rejected `bootInit()` promise carrying structured boot
diagnostics, not "log a warning and serve anyway." The conventional adapter
does not dispatch through an unbooted runtime and resets a rejected lazy-boot
promise so a transient infrastructure failure can retry. Deployment workflows
must exercise the Worker readiness/smoke path if they need the failure before
traffic.

#### Runtime diagnostics

Runtime diagnostics (see ADR-0008 and the design-atoms reference)
cover the cases that reach this far. The contract's job is to make
the serving boundary handle **input it had no way to predict**
(request shape, auth state, transient infrastructure failures), not
the layer that handles **author-side mistakes** (those belong in the earliest
applicable pre-serve loop).

#### Phase ordering rationale

The author's lifecycle is:

```
edit YAML → run validate (Loop 1) → run tests/harnesses (Loop 2)
         → push → deploy boots (Loop 3) → serves (runtime diagnostics)
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
   claude.ai, or any MCP-speaking host) connected to the deployed Worker over
   OAuth. `/mcp` carries public View queries and explicitly public MCP
   Triggers; `/mcp/staff` carries staff View queries, authoring/lifecycle
   builtins, and explicitly staff MCP Triggers. The agent has *only* the tools
   on its authorized catalog; no shell, filesystem, or git.

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
- Anything **dev-loop shaped** — static validation, local
  tests/measurements, and boot verification are coder-surface concerns, not
  operator-surface.
- Anything that **mutates code** in the consumer's repo — registering
  handlers, wiring imports, updating `wrangler.toml`.
- **Skill files** carrying domain context. cc reads these; MCP clients
  do not.

Concrete artifacts today:

- Version-matched Core skills ship inside `@aotter/mantle`, through the Mantle
  agent plugin, and through exact-byte repo-local projections written by
  `mantle skills`.
- The umbrella `mantle` CLI exposes `validate`, `generate`, `skills`, `update`,
  `introspect`, `emit-openapi`, and `emit-types`; direct spec installs expose
  the authoring subset through `mantle-spec`.
- `@aotter/mantle/runtime/testing` and `mantle-harness` expose the measured
  SQLite/index and live-HTTP checks described in Loop 2.

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

A small third category exists: library APIs such as manifest/diagnostic types,
runtime use cases, dispatchers, and the boot validator. They are exported from
the matching `@aotter/mantle` subpath for composition or tests, but are not
separate CLI commands or MCP tools.

#### What does NOT go on either surface

- **Unbound consumer Procedures auto-emitted as MCP tools.** A Procedure carries
  arbitrary code and is transport-neutral by itself. Exposure requires an
  explicit `Trigger.source.kind: mcp`, a declared `public | staff` surface, and
  the target's authorization predicates/guard. Core also emits its closed
  authoring/lifecycle builtins and View query tools on the matching surface.
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
- One diagnostic format (ADR-0008) across validation, boot, and runtime
  failures means the coder agent writes one parser. Measured harnesses use
  separate stable report types because they are results, not failures.
- Public measured harnesses let consumers gate index access paths and live HTTP
  behavior without rebuilding Core's migration/compiler instrumentation.
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
- The Node-only planner uses the platform's `node:sqlite`; it is a compatibility
  surface to keep honest against real D1 and does not enter Worker bundles.
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
- No implicit cross-surface convenience. A consumer Procedure reaches MCP only
  through an explicit MCP Trigger and its surface/authorization declaration.

### Risks

- **Validator under-approximates** (rejects valid manifests): authors
  will route around it (`--no-validate` etc.), defeating the purpose.
  Mitigation: validator MUST err on the permissive side; ambiguous
  cases emit `severity: warning` not `error`; exit code 0 unless an
  error is found.
- **SQLite planner diverges from D1**: local SQLite can differ in collation,
  type affinity, JSON, or planner choices. Mitigation: Core CI also runs the
  Wrangler-local Worker benchmark; local planner output gates query shape and
  access paths, not provider equivalence.
- **Boot fail-fast aggressiveness**: if boot refuses to start on
  cosmetic issues (a Schema property has an unrecognized but harmless
  `x-` extension), the deploy pipeline becomes hostile. Mitigation:
  boot validates only **load-bearing** invariants (missing handler
  refs, dangling Trigger targets, schema drift). Cosmetic / advisory
  checks remain non-blocking diagnostics rather than boot errors.
- **AI authors over-trust the contract**: "the SDK said it was fine
  therefore it is fine." Runtime diagnostics still exist for reasons
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
Rejected as insufficient: cannot catch handler logic bugs, cannot verify that
a textual handler key reaches the assembled runtime map, and cannot test
data-flow against fixtures.

**(c) Test harness only.**
Rejected: better than (a) but still lets misconfigurations land in
deploys (handler renamed but not re-registered, manifest references
stale schema name). Static is cheaper and finds these faster.

**(d) Ship a second full in-memory Worker/dispatcher harness.**
Deferred. Consumer tests can call the public use cases or adapter app directly;
Core only centralizes the real-SQLite planner and live-HTTP measurements whose
instrumentation would otherwise be duplicated. Add a fuller factory only when
multiple consumers demonstrate the same unavoidable setup.

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

2. **Which loop owns the failure mode?** (Loop 1 static, Loop 2 local
   tests/harnesses, Loop 3 boot; unpredictable serving conditions stay runtime)

3. **Could it move left?** (e.g. a runtime check that could be a
   boot check, a boot check that could be a static check)

4. **Does it emit the structured diagnostic shape?** (ADR-0008)

5. **Can a consumer reproduce the failure offline?** (i.e. is it visible to
   Loop 1 or Loop 2, not only after boot or at runtime)

6. **Does the feature mutate the consumer's repo?** → CLI (or SDK
   API the CLI uses). Never MCP — the operator agent is not in the
   consumer's repo.

7. **Does the feature observe / mutate runtime state in the deployed
   Worker?** → MCP tool, with the ops-role description in the
   tool's `description` field. Or HTTP Trigger + handler if the
   feature is consumer-shaped (a Procedure the consumer wrote).
   An MCP Trigger is the explicit bridge when a consumer intentionally exposes
   a Procedure to an operator surface.

Reviewers should treat "this lands as a runtime 500 only" as a
yellow flag — sometimes correct (genuine runtime conditions), often
a sign that earlier loops were not considered. Likewise, when a PR
adds either an MCP tool or a CLI command, check whether the *other*
surface tries to mirror the change. If yes, that's a flag — push
the proposer to pick one surface or to articulate a real two-role
use case.
