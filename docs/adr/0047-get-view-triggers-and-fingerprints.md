# ADR-0047: GET View Triggers, and behavior and exposure fingerprints

**Status:** Accepted (issue #2174); implementation in progress.

**Date:** 2026-11-27

**Amends:** ADR-0001 (a Trigger may target a View), ADR-0012 (a public View may gain custom GET routes beside
`/api/views/<name>`), ADR-0046 (target pinning, `describeApp`, `matchTarget` and REST precedence), and ADR-0008 (four
new diagnostic codes).

**Non-goal:** application-owned SSR or PDF formatting of a View's rows (#2175). This record only adds the route and the
registry facts that such work would read.

## Context

A public View is reachable at one generated route, `GET /api/views/<name>`, with lenient query handling: the first
value of a repeated key wins, unknown keys are ignored and a `limit` above the cap is clamped. Applications that want a
resource-shaped URL, such as `GET /api/orders/{id}` for an `order-detail` View, write a custom handler that repeats the
View's input reader, paging and guard, and that `mantle describe`, `matchTarget` and the gateway pin cannot see.

A Trigger already binds an http method and path to a Procedure, and the generated router, describe and matcher already
agree on its path grammar and precedence (ADR-0046, #1617). Extending that binding to a View reuses all of it.

The registry has a second problem. A target's `targetHash` is one hash over its whole definition, including its http
Triggers. Moving a write Trigger from one path to another therefore changes the pin of `procedure:<name>` and of every
entry that embeds it, and `diffApp` reports a behavior change although the operation is the same. A host or reviewer
cannot tell "what the operation does" apart from "where and how it is reachable".

## Decision

### 1. Grammar: a Trigger may target a public View with GET

```yaml
kind: Trigger
metadata: { name: order-detail-get }
spec:
  source: { kind: http, method: GET, path: /api/orders/{id} }
  target: { view: order-detail }
```

- `spec.target` declares exactly one of `procedure` or `view`. A Trigger with `target.view` has an http source with
  method `GET`; GET exists only for View targets, and `HttpMethod` for Procedure targets stays `POST|PUT|PATCH|DELETE`.
  MCP exposure of a View still comes from its `surface`.
- Only a View with `surface: public` may be targeted. `admin` and `internal` Views need caller-mode lowering on REST,
  which is a follow-up.
- The generated `GET /api/views/<name>` route stays; each Trigger adds one exposure.
- The plan lowers the Trigger to `{ source, view }`. Existing Triggers keep their exact lowered shape, so existing plan
  fingerprints do not change. The plan stores no binding: one function derives it (§2.5).

### 2. Path templates for GET Triggers

The existing http grammar applies: the `/api/` prefix, and each segment is either a literal that neither starts with
`:` nor contains a brace, or a whole `{name}`. GET Triggers add:

1. **Normal form.** No empty segment, no trailing `/`, and no dot segment: a literal may not be `.` or `..` and may not
   contain `%`. Every GET template names exactly one normalized route, and the existing collision key (method plus path
   with each `{x}` replaced by `{}`) is its normal form.
2. **Parameters.** Each `{name}` names a top-level property of the View's `input` whose type, ignoring `null`, is
   `string`, `integer`, `number` or `boolean`, and appears at most once.
3. **Reserved space.** The first segment after `/api/` is a literal other than `views` and `auth`. `/api/views/**` holds
   the generated View routes; `/api/auth/**` is Better Auth's default base. No GET Trigger can therefore match a path
   under either prefix, literal or parameterized: no overlap with built-in routes holds by construction. A custom
   Better Auth `basePath` is not reserved; the application keeps it clear.

Write Triggers keep today's path rules.

### 3. Diagnostics

Parse level (`INVALID_MANIFEST_ENVELOPE`):

- A missing `target`, or an absent `view` with no string `procedure`, keeps today's message and path
  (`Trigger.spec.target.procedure is required (string)` at `/spec/target/procedure`).
- Both `procedure` and `view`, or a `view` that is not a non-empty string: `Trigger.spec.target must declare exactly one
  of 'procedure' or 'view' as a string.` at `/spec/target`.
- `target.view` with an MCP source or a method other than GET: `A Trigger targeting a View must use source { kind:
  http, method: GET }.` at `/spec/source`.
- GET with `target.procedure` keeps the existing method-set message, and an unknown target key the existing
  unknown-key message.

Graph level, one root cause per Trigger in this order: target, path grammar, parameters, collision.

| Code | Path | When |
|---|---|---|
| `TRIGGER_TARGET_VIEW_UNKNOWN` (new) | `/spec/target/view` | No such View; candidates and suggestion as for Procedures. |
| `TRIGGER_TARGET_VIEW_SURFACE` (new) | `/spec/target/view` | The View's surface is `admin` or `internal`. |
| `TRIGGER_PATH_INVALID` | `/spec/source/path` | Existing rules, plus the GET normal form (§2.1). |
| `TRIGGER_PATH_RESERVED` (new) | `/spec/source/path` | First segment after `/api/` is `views`, `auth` or a parameter; names the generated View route when the path equals one. |
| `TRIGGER_PATH_PARAM_INVALID` (new) | `/spec/source/path` | A `{name}` that is not an input, not scalar, or repeated. |
| `TRIGGER_PATH_COLLISION` | `/spec/source` | Two GET Triggers share the normalized key; only for paths that passed the earlier checks. |

`VIEW_INPUT_RESERVED_NAME` still guarantees that no input is named `limit` or `cursor`.

### 4. Input contract: one strict decode-and-coerce path

The generated route reuses the View's own generated `query` reader, `page` module, guard, scopes, conversions and
lowering mode, so there is no second validator. It is marked `strict`. For a request the dispatcher, in this fixed
order:

1. refuses a path key that also appears in the query string, and any query key given more than once;
2. merges the percent-decoded path values into the query and runs the View's reader (same coercions and messages);
3. refuses a key that is neither `limit`, `cursor` nor a declared input;
4. then calls `page()`, which applies `auth`, refuses `limit` below 1 and a malformed or foreign cursor, and only then
   reads.

Every refusal is 400 `INPUT_VALIDATION_FAILED` through the existing `invalid()`. Steps 1 to 3 run before the database
handle is taken; every refusal, including those of `page()`, happens before any data read. Paging is the View's:
default `min(50, cap)`, a larger `limit` is clamped, an empty `cursor` is dropped, and cursors stay bound to
`views/<name>`, shared with the custom route.

`/api/views/<name>` keeps first-value-wins, ignored unknown keys and the silent clamp. `kernel/validation.ts`,
`kernel/paging.ts`, the write-Trigger dispatch and the generated `validation/*` modules do not change.

### 5. Routing and HEAD

- A GET View Trigger answers GET only. HEAD on its path is 405 with `Allow: GET`; the built-in View route keeps HEAD.
- `matchTarget` treats HEAD as a View read only for the built-in id form `rest:GET /api/views/<x>` whose first variant
  is `view:<x>`.
- Precedence is `routeOrder` alone (ADR-0046): fewer parameters first, a literal before a parameter from the left, then
  the path text. `GET /api/orders/latest` wins over `GET /api/orders/{id}`. Because no GET Trigger can match a built-in
  View path, the router and the matcher select the same target for every method and path; a conformance test over the
  example apps keeps them equal.
- **Mixed versions, fail-closed.** A matcher older than this record resolves `HEAD /api/orders/5` to the custom GET
  target while Core answers 405. A gateway may admit or refuse that HEAD; Core never serves data for it. Upgrade the
  gateway's `@aotter/mantle/describe` together with Core before declaring GET View Triggers.

### 6. One binding derivation

`restBinding(plan, trigger | view)` returns `{ path, input: "query" | "body", strict, head, response: "page" | "result" }`.
The REST generator, describe's `_meta.exposure` and the exposure fingerprint all use it, so generation and describe
cannot disagree.

### 7. Describe and fingerprints

Describe stays at `schemaVersion: 1`; every addition is a new key:

- `view:<name>` lists its GET Triggers in `triggers`, and each GET Trigger gets a `rest:GET <template>` entry whose
  variant is the View.
- Every target carries `_meta.behaviorHash` and `_meta.exposureHash`; every `rest:` entry carries `_meta.exposure` from
  `restBinding`. The report carries `targetHashVersion: 2`; an absent field means 1.
- **Behavior** is what the operation does: the declaration minus presentation, effective `requires`, `restrict`,
  dialect, Schemas, user fields, `readOnly`, `opaque`, `nativeDatabase` and `trustedOnly`. Presentation is an explicit,
  tested list: `title`, `description`, MCP annotations and tool display fields, and `uiSchema`. Authored SQL stays in
  behavior, so a whitespace-only SQL edit still reads as a behavior change (fail-closed). A route entry with one variant
  and no behavior of its own reuses that variant's `behaviorHash`.
- **Exposure** is where and how it is reachable: for a canonical target its surfaces other than REST, its non-http
  Triggers, input schema, effective `requires`, `readOnly`, `trustedOnly` and presentation; for a route entry its
  binding, input schema, `requires`, flags and variant ids.
- **Runtime pin.** `targetHash = hash({ behavior: behaviorHash, exposure: exposureHash })`. It still binds operation
  and exposure, and `TARGET_MISMATCH` and `TARGET_HASH_MISMATCH` still fire at admission.

So a path-only move changes only that `rest:` entry's id, exposure and pin; `procedure:<name>`, `view:<name>` and other
entries keep their pins. Renaming or retyping a `{name}`, or changing strictness or HEAD, moves exposure and pin. A
projection, `requires`, `restrict` or scope change moves behavior and every dependent pin. A title or description edit
moves exposure and pin but not `behaviorHash`.

**Transition field.** Every target also carries `_meta.targetHashV1`, the previous formula kept verbatim as a frozen
function. It is describe-only and costs nothing at startup. It is carried through the 0.2.x line and removed later by
an amendment to this record.

Host props, `AccessTarget` and the generated `access-targets.ts` keep their shape. A reader that lacks
`behaviorHash`, `exposureHash`, `exposure` or `targetHashV1` treats them as unknown and does not compare them.

### 8. `diffApp`

Existing fields and directions stay. Added:

1. `exposure` is compared on `rest:` entries when both sides have it (`changed`).
2. `behavior` is `changed` whenever both sides have `behaviorHash` and it differs.
3. When only `exposureHash` differs and nothing else was recorded for the target, `exposure` is `changed`.
4. A REST move that changes only the URI (same method; equal `behaviorHash`, exposure, `requires`, input schema,
   variant ids and flags) is one `{ id: <new>, field: "exposure", direction: "changed", before: <old id>, after: <new
   id> }`.
5. An http Trigger whose id, kind, method and surface are equal and whose path alone differs is `changed` in
   `triggers`, not widened.
6. **Across formula versions.** When `targetHashVersion` differs, one `{ id: "*", field: "targetHashVersion",
   direction: "changed", before, after }` line is added, and the per-target fallback still runs: it compares the
   older report's `targetHash` with the newer report's `_meta.targetHashV1` and reports `behavior` `changed` as today.
   If the newer report has no `targetHashV1`, each target gets `{ field: "behavior", direction: "changed", unverified:
   true }` instead of silence. A SQL or projection change in the upgrade deploy is always visible.

### 9. Startup size

New runtime code lives only in the lazy `rest-router` and `rest-dispatch` chunks; `Route.strict` is type-only. For an
application without GET View Triggers the generated output is byte-identical, so `startup:rest`, `startup:mcp`,
`startup:web` and `startup:all` do not change. Budgets are not raised. The fixture app behind `startup:all` gets no GET
Trigger (its headroom is small); the REST-only Worker size test carries one and is the gate for the new route shape.

## Consequences

- A public View can be read at a resource-shaped URL with strict input handling, with no handler code, and the route is
  visible to describe, `matchTarget`, the gateway pin and Admin's developer console.
- For an application without GET View Triggers, the plan and plan fingerprint, every generated module except the values
  in `access-targets.ts`, request behavior and every existing parse diagnostic are unchanged.
- **Breaking, once.** Every `targetHash` value, and so every value in `access-targets.ts`, changes on upgrade. A host
  that keeps pre-upgrade pins gets 412 `TARGET_HASH_MISMATCH` before any data until it re-reads describe.
- `diffApp` output is refined: behavior is reported from `behaviorHash`, a path-only Trigger move is `changed` in
  `triggers`, a URI-only REST move is one `exposure` line, and a cross-version diff adds one `*` line.
- A gateway must upgrade `@aotter/mantle/describe` with Core before an application declares GET View Triggers; an older
  matcher over-approximates HEAD, and Core refuses it.

## Alternatives

- **A `rest:` key on the View** (a second exposure switch). Rejected: ADR-0012 keeps one View declaration and routes
  through Triggers; a Trigger already owns http binding, precedence and collisions.
- **Lenient handling on the custom route**, as on `/api/views/<name>`. Rejected: a resource URL is a new contract, and
  repeated or unknown keys are author mistakes better refused before any read. The built-in route stays lenient for
  compatibility.
- **Allow `admin` and `internal` Views.** Deferred: they need caller-mode lowering on REST.
- **Reserve only the literal built-in paths.** Rejected: parameterized templates such as `/api/{a}/x` could still
  overlap `/api/views/**` or `/api/auth/**`; reserving the first segment removes overlap by construction.
- **Keep one `targetHash` over the whole definition.** Rejected: any path move changes unrelated pins and reads as a
  behavior change.
- **Bump `schemaVersion`.** Rejected: an older `diffApp` would throw on every newer report; additive keys plus
  `targetHashVersion` keep older readers working.
- **Drop SQL text from behavior.** Rejected: fail-closed matters more than ignoring whitespace edits.

## How to apply

- Declare a GET Trigger with `target.view` only for a `surface: public` View, with a path whose first segment after
  `/api/` is your own literal, such as `/api/orders/{id}`.
- Read `_meta.behaviorHash` to ask "did the operation change" and `_meta.exposureHash` or `_meta.exposure` to ask "did
  its reachability change"; keep pinning `targetHash`.
- Compare reports across the formula change through `_meta.targetHashV1` (what `diffApp` does).
- Reviewers reject a GET Trigger route that bypasses the View's reader and `page()`, a second validator for it, and any
  new runtime code for it in the startup graph.

## Implementation status

In progress on the #2174 branch, in slices: compatibility baselines; grammar, parse, link and plan; graph diagnostics;
strict dispatch and HEAD; generator, describe entry and matcher; fingerprints and `targetHash` v2; `diffApp`; handbook.
The record is updated when the branch merges.
