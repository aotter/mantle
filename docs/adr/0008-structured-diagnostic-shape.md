# ADR-0008: Structured diagnostic shape for AI-parseable errors

**Status:** Carried over from POC v0.0.x; amended for the shipped v0.1
diagnostic emitters and measured harnesses.

**Date:** 2026-04-30 (POC); last amended 2026-08-03.

**Deciders**: phsu

**Related**: [ADR-0007](0007-ai-as-primary-author.md) (the AI-as-primary-author contract this diagnostic format serves); the zod runtime is described in [`docs/design-atoms.md`](../design-atoms.md) § "Manifest validation — JSON Schema in, zod at runtime".

---

## Context

ADR-0007 commits the SDK to three pre-serve feedback loops (static
validation, local tests/measurements, and boot-time fail-fast) before the
runtime layer. Authoring/runtime failures need one stable record shape; the
measured index and HTTP harnesses use their own purpose-shaped JSON reports.
If each failure emitter used an ad-hoc shape, the consumer agent reading those
errors would need multiple parsers — defeating the
"deterministic feedback" property that justified the contract in
the first place.

An earlier runtime error vocabulary (`INPUT_VALIDATION_FAILED`,
`AUTH_DENIED`, `HANDLER_NOT_REGISTERED`, `DISPATCHER_NOT_BUILT`,
`INTERNAL_ERROR`) was HTTP-shaped: a short code + a status + a
free-form message. That is under-specified for the new loops:

- A static-validation error needs to point to **a file path and
  manifest pointer**, not an HTTP status.
- A "you used an unknown Schema name" error needs to carry the
  **list of known Schemas** and a **best-guess suggestion**, so
  the AI author can fix without doing its own grep.
- A boot error needs to declare **what was checked and what was
  missing**, so the deploy log is self-explanatory.
- Validation, boot, runtime, and consumer-authored test diagnostics should
  agree on **severity** (error vs warning) so integrations do not need
  per-phase logic.

A free-form message field carries all of this in prose, but
forces the AI author to do natural-language parsing on every
diagnostic before it can route a fix. Structure is cheaper.

## Decision

Core validation, boot, and runtime emit diagnostics in the following shape.
The public `test` phase is reserved for consumer test diagnostics; the shipped
`mantle-harness` commands emit `IndexCoverageReport` and `HttpBenchmarkReport`
instead. The canonical type, diagnostic-code constants, and shipped phase
helpers live in `@aotter/mantle-spec`; every other package imports from there.

```ts
type Phase = "validate" | "test" | "boot" | "runtime";

interface Diagnostic {
  /** Stable machine code. UPPER_SNAKE, no prefix. */
  code: string;
  /** Which feedback loop emitted this diagnostic. */
  phase: Phase;
  /** "error" blocks the loop's exit-zero / serve-loop / etc.
   *  "warning" surfaces but does not block. */
  severity: "error" | "warning";
  /** Filesystem path or manifest pointer (JSON Pointer style)
   *  identifying where the issue is. */
  path: string;
  /** What the validator/dispatcher saw. */
  value?: unknown;
  /** One-line description of what was expected. */
  expected?: string;
  /** Valid alternatives, when the expected set is enumerable. */
  candidates?: string[];
  /** Best-guess fix string, when one is high-confidence. */
  suggestion?: string;
  /** Human-readable fallback prose. AI authors should prefer
   *  the structured fields; humans reading TTY output read this. */
  message: string;
}
```

### Code naming convention

Codes are **UPPER_SNAKE, unprefixed**. The `phase` field
disambiguates which feedback loop emitted the diagnostic.

When the same root cause surfaces in multiple loops, the same
`code` is reused with a different `phase`. AI consumers can
group by `code` (root-cause grouping across loops) or filter
by `phase` (this-loop-only handling). Concrete examples:

| code | phases | example contexts |
|---|---|---|
| `HANDLER_NOT_REGISTERED` | `validate`, `boot`, `runtime` | textual grep miss (warning, validate); registry lookup miss (error, boot); dispatch attempt miss (error, runtime, defense-in-depth) |
| `TRIGGER_TARGET_PROCEDURE_UNKNOWN` | `validate`, `boot` | dangling reference caught by either loop |
| `TRIGGER_PATH_COLLISION` | `validate`, `boot` | two http Triggers on same method+path |
| `NOT_FOUND` | `runtime` (`test` reserved) | unknown name in queryView / GET /api/views/X |
| `INPUT_VALIDATION_FAILED` | `runtime` (`test` reserved) | zod validation failure at the serving boundary |

Codes that are phase-exclusive simply never appear with another phase.
`INVALID_MANIFEST_ENVELOPE` is validate-only. The catalog reserves
`FIXTURE_SCHEMA_VIOLATION` for consumer-authored `phase: "test"` diagnostics;
Core does not currently emit it.

### Why no prefixes

Earlier drafts of this ADR proposed per-loop prefixes on the
code string. That was retired because:

- **It bakes provenance into the symbol** when a structured
  field already carries it cleaner. `phase` is the right place;
  prefix in the code string is redundant.
- **It forces three different codes for the same root cause**
  (one per loop), fragmenting consumer error handling. A
  consumer that wants "treat any 'handler not registered' issue
  uniformly" had to parse the prefix off the symbol — defeating
  the parseability argument that justified structure in the
  first place.
- **It's not a standard convention** — closest cousins are
  PHP's `E_*` legacy constants and PostgreSQL SQLSTATE class
  prefixes; both are artefacts of language eras when structured
  records weren't ergonomic. Modern systems (gRPC, OAuth 2.0
  RFC 6749, Stripe API, AWS) use plain UPPER_SNAKE or
  lower_snake without prefixes and identify source through
  separate fields.

### `path` format

- For static validation: filesystem path + JSON Pointer fragment,
  e.g. `manifests/site.yaml#/3/spec/from`.
- For a consumer test diagnostic: test file path + assertion location when
  available, e.g. `tests/handlers/contact.test.ts:42`.
- For boot-time: manifest pointer (no on-disk path because boot
  reads parsed manifests, not files), e.g.
  `manifest:View/recent-published#/spec/from`.
- For runtime: HTTP request path + JSON Pointer into request
  body, e.g. `POST /api/contact#/body/email`.

The convention is "the most specific locator the loop has access
to." All four are strings; AI parsers can dispatch on prefix
(`/`, `manifest:`, HTTP method, test runner format).

### `candidates` — when to populate

Populate when the expected set is **finite and known at
diagnostic time**:
- `VIEW_FROM_UNKNOWN_SCHEMA` → list all declared Schemas
- `BIND_VALUE_NOT_IN_ENUM` → list `["ctx.user", "ctx.staff", "now"]`
- `HANDLER_NOT_REGISTERED` (`phase: boot`) → list registered ref names
- `AUTH_DENIED` (`phase: runtime`) → **do not populate**
  (security: don't tell the caller which roles would have worked)

Omit when the expected set is open (e.g. "any non-empty string"
for `metadata.name`).

### `suggestion` — when to populate

Populate when one candidate is high-confidence (e.g. typo via
edit-distance ≤ 2 on a short identifier). Otherwise omit.
Suggestions are advisory; the AI author should still verify
before applying.

### CLI output mode

- `--format=json` (default when stdout is **not** a TTY, e.g. CI,
  AI-author): emits `{ phase, diagnostics, errorCount, warningCount }` on
  stdout; exit code 1 if any diagnostic has `severity: "error"`, else 0.
- `--format=text` (default when stdout **is** a TTY, i.e. human
  at terminal): prints severity, code, path, structured details, prose message,
  and suggestion when present.

The same diagnostic objects power both modes; text mode is a
formatter, not a separate code path. AI authors invoking the CLI
get JSON automatically because they pipe through subprocess; no
flag needed.

### Consumer test diagnostic surface

Runtime use cases return result objects carrying runtime-phase diagnostics, so
consumer tests can assert stable `diagnostic.code` values without matching
exception prose. A consumer that emits its own fixture/setup diagnostic may use
`makeDiagnostic({ phase: "test", ... })`. Core currently exports no
`testDiagnostic` helper and its measured planner/HTTP harnesses return their
purpose-shaped reports instead of `Diagnostic` objects.

### Runtime diagnostic surface

Runtime HTTP responses on error paths wrap the same redacted object as
`{ ok: false, diagnostic }`, plus the HTTP status from the shared error-code
table. The `path` carries the most specific request/use-case locator available.
The `candidates` field is **always omitted** at wire egress to avoid leaking
schema information to untrusted callers.

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "ok": false,
  "diagnostic": {
    "code": "INPUT_VALIDATION_FAILED",
    "phase": "runtime",
    "severity": "error",
    "path": "POST /api/contact#/body/email",
    "message": "Field 'email' must be a valid email address."
  }
}
```

### Validator translation (zod, not Ajv)

The POC originally translated Ajv `ErrorObject[]` into
`Diagnostic[]` for `INPUT_VALIDATION_FAILED`. Late in the POC
(PR #81) the runtime validator was swapped to **zod** so the
admin SPA and CF Workers could share a CSP-safe path with no
`Function`-constructor codegen. The v0.1.0 rebuild inherits zod
from day 1 — manifest authoring stays JSON Schema, but the
runtime validator a manifest author's request body hits is a
zod schema, produced by the JSON-Schema → zod converter in
`@aotter/mantle-spec` (see [`docs/design-atoms.md`](../design-atoms.md) § "Manifest validation — JSON Schema in, zod at runtime").

Concretely, runtime entry validation consumes `ZodError.issues`:

- `issue.path: PropertyKey[]` becomes an RFC 6901 JSON Pointer (`~` and `/`
  escaped, numeric segments preserved);
- every issue stays in the stable `INPUT_VALIDATION_FAILED` family rather than
  exposing zod's internal issue-code vocabulary;
- `issue.message` supplies fallback human prose. Call sites with known
  trust-boundary context may additionally populate `value`, `expected`, or a
  more specific message before wire redaction.

The same rule that retired Ajv's per-validator error format as a
Diagnostic candidate (alternative (d) below) applies to zod —
`ZodError` is internal plumbing, `Diagnostic` is the public surface.

## Consequences

### Pros

- One parser handles diagnostics from any phase. AI consumer code branches on
  the exact `code` and optionally `phase`, without per-emitter adapters.
- `candidates` + `suggestion` make the most common author errors
  (typo, unknown name, wrong enum value) one-step fixes — the AI
  author reads the diagnostic and writes the corrected manifest
  in the same turn, no grep or human prompting needed.
- `severity: warning` gives the validator a way to surface "this
  is fishy but legal" without blocking — preserves the
  permissive-validator discipline (see ADR-0007 risks).
- Same shape for HTTP responses keeps the runtime layer
  consistent with the contract layers; consumers' app frontends
  and AI authors see the same structure.
- Single source of truth. The interface, code constants, and
  formatter all live in `@aotter/mantle-spec`; the runtime
  package and adapters import them. A future `mantle-netlify`
  inherits the shape for free.

### Costs

- Shape locked early: any field-shape change forces a doc revise and code
  change across CLI, runtime, adapters, and consumer parsers.
- Implementing `candidates` and `suggestion` correctly requires
  the validator/dispatcher to track richer context (the set of
  declared Schema names, the registered ref list, etc.). More
  bookkeeping, more code.
- Stable codes are a public surface. Renaming `VIEW_FROM_UNKNOWN_SCHEMA`
  to a "better" name later is a breaking change for any
  consumer-side error handling.

### Risks

- **Codes proliferate**. Without discipline, every assertion
  becomes its own code (`NAME_TOO_LONG`, `NAME_TOO_SHORT`,
  `NAME_HAS_UPPERCASE`...). Mitigation: codes are scoped by
  failure mode, not by individual assertion. `INVALID_NAME`
  with `expected: "kebab-case, 1-64 chars"` covers the family;
  the `value` and `expected` fields carry the specifics.
- **`message` and structured fields drift**. Mitigation: `makeDiagnostic`
  derives a default message from the structured fields. Explicit contextual
  messages are allowed, but reviewers treat `code`, `phase`, `path`, `value`,
  and `expected` as authoritative and reject contradictions.
- **`candidates` leaks information at runtime**. Already
  addressed: runtime responses omit `candidates`. Code review
  should treat any runtime path that populates `candidates` as a
  bug.

## Alternatives considered

**(a) Free-form prose messages only**. Rejected: AI parsing
burden, and "did you mean?" suggestions become inline text the
AI must extract.

**(b) Just exit code + count of errors**. Rejected: gives the AI
no fixable information; turns every failure into a re-run-with-
verbose-flag escalation.

**(c) Reuse OpenAPI Problem+JSON (RFC 7807)**. Rejected: too
HTTP-flavored (the `type` URI, the `instance` URI), doesn't
carry path/candidates/suggestion structure cleanly. Adopting
Problem+JSON for the runtime layer specifically might be
considered later as an opt-in alternate output mode for
HTTP-strict consumers.

**(d) Surface validator-library error formats directly (Ajv
`ErrorObject`, zod `ZodError`)**. Rejected: those formats are
internal to the validator implementation, change between
library versions, and don't fit non-validation errors (handler
not registered, schema drift, etc.). The library's error
objects feed *into* the Diagnostic translator described under
"Validator translation"; they are never the public surface.

## How to apply

- New error codes: choose a suffix that names the failure
  family, not the specific assertion. UPPER_SNAKE, no prefix.
  Add the constant to `@aotter/mantle-spec`'s diagnostic
  code module; do not redeclare per-package.
- When the same root cause can be caught by multiple loops,
  reuse the code; let `phase` distinguish.
- Implementation: use `makeDiagnostic` or the shipped phase helpers
  `validateDiagnostic`, `bootDiagnostic`, and `runtimeDiagnostic`, all exported
  from `@aotter/mantle-spec`. Consumer test diagnostics call `makeDiagnostic`
  with `phase: "test"` directly.
- Documentation: keep phase/applicability prose in this ADR and the
  version-matched design/runtime references synchronized with the exported
  catalog.

## Implementation status

Implemented. Canonical declarations live in
`packages/mantle-spec/src/kernel/diagnostic.ts`; runtime, Cloudflare adapter,
admin UI, and CLI import the public spec exports. `redactForWire` removes
`candidates` before REST/MCP egress. The `test` phase and
`FIXTURE_SCHEMA_VIOLATION` remain reserved compatibility surface; Core ships no
test-phase helper or emitter today.
