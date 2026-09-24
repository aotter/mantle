---
description: The Diagnostic shape and the complete closed code catalog — every validate, boot and runtime code, what it means and the HTTP status it maps to.
---
# Diagnostics

Every failure in Mantle is a `Diagnostic`: one structured object with a stable code, the phase that produced it and a JSON Pointer to the offending place. The catalog is closed — adding a code is a grammar-revise event — so an agent can group by `code` or filter by `phase` without parsing prose. This page is the whole catalog. The rules that raise each code live on the atom pages: [Manifest](./manifest.md), [Schema](./schema.md), [View](./view.md), [Procedure](./procedure.md), [Trigger](./trigger.md), [Authorization](./authorization.md) and [Site config](./site-config.md).

## Shape

```ts
interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly phase: "validate" | "test" | "boot" | "runtime";
  readonly severity: "error" | "warning";
  readonly path: string;
  readonly source?: SourceLocation;
  readonly value?: unknown;
  readonly expected?: string;
  readonly candidates?: readonly string[];
  readonly suggestion?: string;
  readonly message: string;
  readonly failure?: {
    readonly outcome: "not-applied" | "partial" | "unknown";
    readonly retry: "never" | "after-change" | "safe" | "reconcile";
    readonly resource?: string;
  };
}
```

| Field | Meaning |
|---|---|
| `code` | One of the codes below. Unprefixed `UPPER_SNAKE`. |
| `phase` | Which loop produced it. The same code may appear in more than one phase when it names the same root cause. |
| `severity` | `error` withholds the result of its stage; `warning` does not. |
| `path` | Where the problem is. In validate and boot phases a manifest path such as `manifest:Procedure/expire-order#/spec/handler/ref`; in the runtime phase a target path plus a JSON Pointer, such as `manifest:View/my-orders#/params/locale`. |
| `source` | Authored location: `{ sourceId, documentIndex, path }` plus a line and column span when the YAML node is known. Present on parse diagnostics. |
| `value` | The offending value, when one can be shown. |
| `expected` | What would have been accepted, in prose. |
| `candidates` | The valid alternatives — declared handler keys, enabled locales, declared Procedure names. Security-sensitive. |
| `suggestion` | Nearest-match hint, when one is computed. |
| `message` | Human-readable. Call sites may supply their own; otherwise it is derived as `[<phase>/<code>] at <path>; expected <…>; got <…>; (did you mean <…>?)`. The structured fields stay authoritative. |

`candidates` is stripped by `redactForWire` before any HTTP egress, because listing valid alternatives to an untrusted caller leaks schema information. Internal phases — validate, test and boot — skip that redaction, so a CLI or boot log keeps the full list. One or more diagnostics travel across a transport boundary inside a `DiagnosticError`; the boundary catch emits the structured payload instead of falling back to the `INTERNAL_ERROR` envelope reserved for genuinely unexpected throws.

`failure` describes safe effect and recovery facts for storage and service failures. `safe` means retrying the same idempotent operation is safe, not that Mantle automatically retries it. Unknown write/send outcomes require reconciliation unless the adapter guarantees idempotence. Provider payloads, SQL and credentials belong in `DiagnosticError`’s internal `cause`, never public fields. See the [port operation matrix](../../adr/0023-port-failure-contract.md).

## Validate-only

Raised by the parser, the graph validator and the code generator. `mantle validate` and `mantle generate` surface these; parsing is all-or-nothing, so one error-severity diagnostic withholds the whole parsed set.

| Code | Meaning | HTTP |
|---|---|---|
| `INVALID_MANIFEST_ENVELOPE` | Wrong `apiVersion`, unknown key at a known level, wrong value shape, a YAML syntax or alias-limit failure, a Schema data property named `expectedVersion` (reserved Procedure OCC token; ADR-0022), or a Schema data property named after a native entry column (`id`, `status`, `version`, `createdAt`, `updatedAt`, `authorId`). | — |
| `DUPLICATE_NAME` | Two documents of the same kind declare the same `metadata.name`. | — |
| `VIEW_FROM_UNKNOWN_SCHEMA` | `spec.from` names no declared Schema. | — |
| `VIEW_FIELD_NOT_IN_SCHEMA` | A `fields` entry or `orderBy[i].field` is neither a Schema property nor a reserved entry column. | — |
| `VIEW_FILTER_FIELD_NOT_IN_SCHEMA` | A filter comparison names an unknown field. | — |
| `VIEW_PARAMS_INVALID_SHAPE` | `spec.params` is not an object schema with an object `properties`. | — |
| `VIEW_PARAMS_RESERVED_NAME` | `params.properties` declares `page`, `show` or `cursor`. | — |
| `VIEW_FILTER_PARAM_REF_UNKNOWN` | `{ $param: <name> }` names a param that is not declared. | — |
| `VIEW_FILTER_PARAM_REF_NOT_REQUIRED` | The referenced param is not listed in `params.required`. | — |
| `VIEW_FILTER_CTX_USER_REF_INVALID` | The `{ "$ctx.user": "id" }` sentinel is malformed or used outside `eq`. | — |
| `VIEW_FILTER_CTX_USER_REF_REQUIRES_AUTH` | The sentinel is used without `ctx.user` in `requires.auth.all`. | — |
| `VIEW_FILTER_CTX_USER_REF_REQUIRES_INDEX` | The bound field is not the leftmost field of a declared index. | — |
| `VIEW_ORDERBY_INVALID` | An `orderBy` entry has the wrong shape or an unknown `direction`. | — |
| `VIEW_UI_INVALID` | A View `uiSchema` key is unknown, used on a public View, or names an unknown output field. | — |
| `VIEW_PUBLIC_STATUS_INVALID` | A public View over a `publishing` Schema compares `status` to anything but `published`. The runtime always reads published rows only on that surface, so the filter can only contradict it. | — |
| `REQUIRED_FIELD_UNKNOWN` | A `required` entry of `spec.schema` is not declared under `properties`. | — |
| `INVALID_PATTERN` | A `pattern` does not compile as a JavaScript regular expression. | — |
| `JSON_SCHEMA_UNSUPPORTED` | A JSON Schema keyword outside the accepted subset. | — |
| `JSON_SCHEMA_REF_INVALID` | A `$ref` does not begin `#/$defs/` or does not resolve in the same document. | — |
| `JSON_SCHEMA_LIMIT_EXCEEDED` | Nesting deeper than 100 levels, or more than 10,000 schema nodes. | — |
| `BIND_VALUE_NOT_IN_ENUM` | `x-mantle-bind` is not `ctx.user`, `ctx.staff` or `now`. | — |
| `AUTH_PREDICATE_NOT_IN_ENUM` | A `ctx.staff` role is not `owner`, `editor` or `contributor`. | — |
| `GUARD_PROCEDURE_UNKNOWN` | `requires.guard.procedure` names no declared Procedure. | — |
| `GUARD_SELF_REFERENCE` | A Procedure names itself as its own guard. | — |
| `GUARD_PROCEDURE_BUILTIN` | The guard Procedure uses a builtin handler instead of `handler.kind: ref`. | — |
| `GUARD_CHAIN_NOT_ALLOWED` | The guard Procedure itself declares a guard. | — |
| `SCHEMA_INDEX_INVALID` | An index tuple breaks a shape, naming, reserved-column, type or duplication rule. | — |
| `SCHEMA_INDEX_FIELD_UNKNOWN` | An `indexes` field is not a top-level Schema property. | — |
| `UNIQUE_INDEX_FIELD_UNKNOWN` | A `uniqueIndexes` field is not a top-level Schema property. | — |
| `SCHEMA_SEARCH_INVALID` | `searchableFields` repeats an entry or names a non-string property. | — |
| `SCHEMA_SEARCH_FIELD_UNKNOWN` | A `searchableFields` entry is not a Schema property. | — |
| `SCHEMA_UI_INVALID` | A Schema or Procedure `uiSchema` rule is broken, including unknown roots, invalid `nav.standalone`, or a Schema declaring `uiSchema.collectionAction`. | — |
| `HANDLER_BUILTIN_NOT_IN_V010` | A builtin Procedure was invoked on a runtime assembled without the builtin collaborator. | — |
| `MANIFEST_ROOT_NOT_FOUND` | The manifests directory is missing, unreadable, or contains no `.yaml` or `.yml` file. | — |
| `MANIFEST_READ_FAILED` | A manifest source could not be read. | — |
| `CODEGEN_IDENTIFIER_COLLISION` | Two names in one group collapse to the same generated lower-camel identifier. | — |
| `SCHEDULE_INPUT_INVALID` | A scheduled Procedure cannot accept the empty object supplied by its system Trigger. | — |
| `SCHEDULE_AUTH_INVALID` | A scheduled Procedure requires user or staff authority that the system caller never has. | — |
| `FIXTURE_SCHEMA_VIOLATION` | Reserved for consumer-authored test diagnostics on the `test` phase. Core emits purpose-shaped harness reports instead. | — |

## Cross-phase

Named by the same code in validate, boot or runtime, depending on where the condition is detectable.

| Code | Meaning | HTTP |
|---|---|---|
| `HANDLER_NOT_REGISTERED` | A `handler.kind: ref` key has no function in the `handlers` map. Boot attaches the registered keys as `candidates`; the runtime occurrence is defence in depth. | `500` |
| `TRIGGER_TARGET_PROCEDURE_UNKNOWN` | `spec.target.procedure` names no declared Procedure. | — |
| `TRIGGER_PATH_COLLISION` | Two HTTP Triggers claim the same `(method, path)`. | — |
| `TRIGGER_PATH_INVALID` | An HTTP Trigger path does not start `/api/` (validate), or falls under an adapter-reserved prefix (boot). | — |
| `MCP_TOOL_NAME_COLLISION` | Two atoms mangle to the same MCP tool name, a Procedure takes a reserved generic name or prefix, or two MCP Triggers share a `(surface, tool name)`. | — |
| `MCP_TOOL_DESCRIPTION_MISSING` | Warning. A Procedure reached by an MCP Trigger has no `spec.description`; `tools/list` would show a generated placeholder instead of something an agent can choose by. | — |
| `MCP_TOOL_INPUT_UNREACHABLE` | Warning. An MCP write tool requires `expectedVersion` for a collection that no View on the same surface exposes `version` for, so an agent cannot read the value it must send. SQL Views are checked only by a conservative token scan. | — |
| `MCP_TOOL_INPUT_UNION_AMBIGUOUS` | Warning. An MCP-surfaced Procedure input is a top-level `oneOf`; MCP clients render it poorly, and when its branches require fields the advertised `required` omits a caller satisfying the schema can still be rejected. Prefer one tool per branch. Disable or tune through `ValidateManifestsRequest.mcpInput`, or `mantle validate --no-mcp-input-checks`. | — |
| `MCP_TOOL_INPUT_UNBOUNDED` | Warning. An MCP-surfaced Procedure input has an array without `maxItems` (or above the configured bound) or a free-form object with no declared properties, so an agent must serialise an unbounded payload into one `tools/call`. Typed maps (`additionalProperties: { type: … }`) do not count as free-form. | — |
| `PROCEDURE_NOT_FOUND` | An invocation names a Procedure that is not in the compiled plan. | — |
| `NOT_FOUND` | The addressed resource does not exist: an entry id, a View name, a media asset, an operation name. | `404` |
| `METHOD_NOT_ALLOWED` | The path exists but the method is not bound. | `405` |
| `VIEW_DIALECT_UNSUPPORTED` | The bound storage adapter does not support a `sql` View's dialect. | — |

## Builtin handlers and lifecycle

| Code | Meaning | HTTP |
|---|---|---|
| `BUILTIN_HANDLER_SCHEMA_UNKNOWN` | `handler.schema` names no declared Schema. | — |
| `BUILTIN_HANDLER_CONTRACT_INVALID` | The Procedure's `input` breaks the builtin op's contract, such as a missing `expectedVersion` on `update` or a `match` tuple that is not exactly one `uniqueIndexes` entry; or `spec.mcp` contradicts the op (`readOnlyHint: true` on any builtin, `destructiveHint: false` on `op: delete`). | — |
| `LIFECYCLE_SCHEMA_UNKNOWN` | A lifecycle Trigger's `source.schema` names no declared Schema. | — |
| `LIFECYCLE_HOOK_REJECTED` | A `before_*` hook aborted the mutation. The diagnostic names the rejecting hook. | `409` |

## Locale and translates

| Code | Meaning | HTTP |
|---|---|---|
| `SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES` | A Schema declares `localized: true` while the site has no valid locales. | — |
| `TRANSLATES_PARENT_UNKNOWN` | `translates.parent` names no declared Schema. | `409` |
| `TRANSLATES_REQUIRES_LOCALIZED` | A Schema declares `translates` without `localized: true`. | — |
| `TRANSLATES_REQUIRES_CONTENT_FIELD` | A translation child declares no property besides `locale` and the join field. | — |
| `TRANSLATES_FIELD_NOT_IN_PARENT` | The join field is not declared in the parent's `properties`. | — |
| `TRANSLATES_FIELD_NOT_IN_CHILD` | The join field is not declared in the child's own `properties`. | — |
| `TRANSLATES_PARENT_IS_LOCALIZED` | The named parent is itself `localized: true`. | — |

## Runtime

These are the codes that reach a caller. Everything else in this catalog is caught before traffic.

| Code | Meaning | HTTP |
|---|---|---|
| `RESOURCE_EXHAUSTED` | A known capacity or quota refusal. | `507` |
| `RESOURCE_UNAVAILABLE` | A required storage or service dependency is unavailable. | `503` |
| `RATE_LIMITED` | A recognized request-rate refusal. | `429` |
| `OUTCOME_UNKNOWN` | The operation may have taken effect; reconcile before retry. | `503` |
| `PARTIAL_FAILURE` | Some effects completed; inspect the operation’s recovery contract. | `503` |
| `PRECONDITION_FAILED` | A storage or service precondition failed. | `412` |
| `INPUT_VALIDATION_FAILED` | Procedure input, View params or an entry's `data` failed the compiled schema, including the write-time locale gate. | `400` |
| `INVALID_LOCALE` | A locale value is not a canonical Mantle v0.1 tag. Also raised at boot against `site_config/locales`. | `400` |
| `UNAUTHENTICATED` | An auth predicate failed and the caller presented no identity at all. | `401` |
| `ENTITLEMENT_REQUIRED` | A guard Procedure denied the call on current business state. | `402` |
| `AUTH_DENIED` | An auth predicate failed for a caller that is authenticated in some way, or an Admin caller lacks the required staff role. | `403` |
| `CONFLICT` | Optimistic-concurrency mismatch, unique-index violation, an illegal lifecycle transition, or a generic write against a read-only Schema. Not retryable as sent. | `409` |
| `OUTPUT_VALIDATION_FAILED` | A handler returned a value that does not match its declared `output`. A handler bug. | `500` |
| `INTERNAL_ERROR` | An uncaught handler exception. | `500` |
| `DISPATCHER_NOT_BUILT` | The runtime feature is not implemented in this build. | `501` |
| `MEDIA_NOT_CONFIGURED` | Media uploads are not enabled: no `mediaStorage` port is bound. | `501` |
| `MEDIA_PURPOSE_REJECTED` | The requested `purpose` is not declared in `siteDefaults.media.purposes`. The declared set is returned in `expected`. | `400` |
| `MEDIA_MIME_REJECTED` | The declared mime is outside the accepted image set. | `400` |
| `MEDIA_SVG_REJECTED` | An SVG upload was attempted while the adapter has SVG disabled; object storage does not sanitize SVG payloads. | `400` |
| `MEDIA_SIZE_EXCEEDED` | A declared `byteSize` exceeds the cap. | `400` |
| `MEDIA_VARIANTS_INCOMPLETE` | The variants manifest does not cover every mime the purpose requires. | `400` |
| `MEDIA_VARIANT_SIZE_EXCEEDED` | One variant's `byteSize` exceeds its mime's `maxBytes`. | `400` |
| `MEDIA_VARIANTS_SUSPICIOUS_SIZE` | A modern format is larger than its fallback, so the uploader skipped optimization for that variant. | `400` |
| `MEDIA_UPLOAD_EXPIRED` | The upload capability's TTL elapsed, or it never existed. | `410` |
| `MEDIA_OBJECT_NOT_FOUND` | Commit ran before every variant's bytes reached the storage backend. | `409` |
| `MEDIA_CHECKSUM_MISMATCH` | Uploaded bytes do not match the declared checksum. | `409` |
| `MEDIA_ASSET_NOT_FOUND` | No `media_assets` row matches the id. | `404` |

## How diagnostics surface

Only the runtime phase maps to HTTP. `httpStatusFor` reads the status table above; **a runtime code that is not in that table becomes `500`**. Validate, test and boot phases have no HTTP mapping at all — they surface through:

- **CLI exit codes.** `mantle validate`, `mantle generate` and `mantle-harness` print each diagnostic as `<code> <path>: <message>` in text mode or as JSON otherwise. Exit `0` means no errors (warnings are allowed), `1` means one or more errors, `2` means a CLI invocation problem.
- **A thrown `BootValidationError`.** Deployment preparation collects boot diagnostics and throws them together; the error carries the full `diagnostics` array.
- **Worker init logs.** On Cloudflare the facade boots the runtime once per isolate. A boot failure is logged and the request boundary returns a redacted `{ ok: false, error: "internal_error" }` with `500`, so the diagnostic detail stays in the log rather than on the wire.

Five codes are declared in the catalog but not emitted anywhere in the shipped source at this version: `FIXTURE_SCHEMA_VIOLATION` (reserved for consumer tests by design), `MANIFEST_READ_FAILED`, `METHOD_NOT_ALLOWED`, `DISPATCHER_NOT_BUILT` and `MEDIA_CHECKSUM_MISMATCH`. They remain part of the public contract because the catalog, not the current set of throw sites, is the contract.

## Source

- [`packages/mantle-spec/src/kernel/diagnostic.ts`](../../../packages/mantle-spec/src/kernel/diagnostic.ts)
- [`packages/mantle-spec/src/domain/service/ManifestParser.ts`](../../../packages/mantle-spec/src/domain/service/ManifestParser.ts)
- [`packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts`](../../../packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts)
- [`packages/mantle-spec/src/domain/service/CrossSchemaChecker.ts`](../../../packages/mantle-spec/src/domain/service/CrossSchemaChecker.ts)
- [`packages/mantle-spec/src/infrastructure/cli/ValidateCommand.ts`](../../../packages/mantle-spec/src/infrastructure/cli/ValidateCommand.ts)
- [`packages/mantle-spec/src/infrastructure/cli/loadManifests.ts`](../../../packages/mantle-spec/src/infrastructure/cli/loadManifests.ts)
- [`packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts`](../../../packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts)
- [`packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts`](../../../packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts)
- [`packages/mantle-runtime/src/usecase/media/diagnostics.ts`](../../../packages/mantle-runtime/src/usecase/media/diagnostics.ts)
- [`packages/mantle-runtime/src/domain/service/EntryMutationDiagnostics.ts`](../../../packages/mantle-runtime/src/domain/service/EntryMutationDiagnostics.ts)
- [`packages/adapters/cloudflare/src/worker/createMantleWorker.ts`](../../../packages/adapters/cloudflare/src/worker/createMantleWorker.ts)
