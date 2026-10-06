---
description: The structured Diagnostic shape, the wire error envelope, HTTP statuses, and the diagnostic codes Mantle 0.2.0 raises from mantle generate, boot and run time.
---
# Diagnostics

Every refusal is a `Diagnostic`, from `mantle generate` to a REST call:

```ts
interface Diagnostic {
  code: DiagnosticCode;          // the catalog below
  phase: "validate" | "boot" | "runtime" | "test";
  severity: "error" | "warning";
  path: string;                  // where: a manifest pointer, a route, a field
  message: string;               // for people; never parse it
  source?: { sourceId, documentIndex, path, … };   // the manifest file and document
  value?: unknown; expected?: string; candidates?: string[]; suggestion?: string;
  failure?: { outcome: "not-applied" | "partial" | "unknown"; retry: "never" | "after-change" | "safe" | "reconcile"; resource? };
  conflict?: { opIndex?: number; reason: "lock" | "expect" | "unique" };
}
```

`mantle generate` prints `CODE path: message`; a SQL diagnostic's message
starts with `SQL <line>:<column> near "<token>"`. Over HTTP a failure is
`{ "error": <diagnostic> }` with the status below; internal details are
redacted. Over MCP it is a tool error result carrying the same code.
Handler code catches `DiagnosticError` and reads `error.diagnostic.code`.

## Run time

| Code | HTTP | Meaning |
|---|---|---|
| `INPUT_VALIDATION_FAILED` | 400 | input against its schema, a failed `check`, a malformed body or query |
| `UNAUTHENTICATED` | 401 | no caller, or a presented credential that failed |
| `ENTITLEMENT_REQUIRED` | 402 | a guard found no entitlement |
| `AUTH_DENIED` | 403 | a signed-in caller fails a predicate or a role, or a cross-origin session write |
| `NOT_FOUND` | 404 | no such route, View, row or operation for this caller |
| `METHOD_NOT_ALLOWED` | 405 | |
| `CONFLICT` | 409 | a lock, a row op that wrote nothing, a unique index; `conflict` says which and which op |
| `LIFECYCLE_HOOK_REJECTED` | 409 | for a before hook that rejects with it |
| `PRECONDITION_FAILED` | 412 | |
| `RATE_LIMITED` | 429 | |
| `INTERNAL_ERROR`, `OUTPUT_VALIDATION_FAILED` | 500 | a handler threw something that is not a `DiagnosticError`, or returned what `output` refuses |
| `RESOURCE_UNAVAILABLE`, `OUTCOME_UNKNOWN`, `PARTIAL_FAILURE` | 503 | storage was unreachable; after `OUTCOME_UNKNOWN` the write may or may not have applied, so retry with the same ids and locks |
| `RESOURCE_EXHAUSTED` | 507 | |
| `INVOCATION_DEPTH_EXCEEDED` | 500 | more than 8 nested invocations (hooks and `ctx.invoke`) |
| `PROCEDURE_NOT_FOUND` | 500 | `invokeProcedure` with a name the plan lacks |
| `SITE_NOT_CONFIGURED` | 501 | Admin's `/site-settings` on a runtime without site defaults |
| `MEDIA_*` | 400, 404, 409, 410, 501 | media uploads: `MEDIA_NOT_CONFIGURED` (501) without media storage and site defaults, `MEDIA_UPLOAD_EXPIRED` (410), `MEDIA_ASSET_NOT_FOUND` (404), `MEDIA_OBJECT_NOT_FOUND` and `MEDIA_CHECKSUM_MISMATCH` (409), and 400 for a refused type, size, purpose or variant set |

Admin's statistics route answers 501 with the wire code
`STATISTICS_UNAVAILABLE`, which is not a `DiagnosticCode`. `DISPATCHER_NOT_BUILT`
(501) is in the catalog and not raised by 0.2.0.

## Boot

| Code | Meaning |
|---|---|
| `HANDLER_NOT_REGISTERED`, `HANDLER_NOT_DECLARED` | the handlers map lacks a plan ref, or has one the plan lacks |
| `PLAN_FINGERPRINT_MISMATCH` | the plan is not the expected one, or was compiled for another dialect or plan version |
| `SCHEDULE_NOT_WIRED` | an enabled schedule Trigger without `schedules: true` |
| `STORAGE_CHANGE_BLOCKED` | storage has a difference boot will not change; the message names it and hints SQL |
| `STORAGE_TABLE_NOT_OWNED` | a table Mantle would create exists and is not Mantle's |
| `INVALID_LOCALE`, `SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES` | a site `locales` entry that is not a language with an optional 2-letter region, or a `localized` Schema without site `locales` |

## `mantle generate`

| Codes | About |
|---|---|
| `INVALID_MANIFEST_ENVELOPE`, `DUPLICATE_NAME`, `MANIFEST_ROOT_NOT_FOUND`, `MANIFEST_READ_FAILED` | files and the envelope; a `v1` apiVersion fails here and names the upgrade guide; `x-mantle-bind` fails and names its replacements (`spec.scope`, `auth.uid()`, `now()`) |
| `REQUIRED_FIELD_UNKNOWN`, `INVALID_PATTERN`, `JSON_SCHEMA_UNSUPPORTED`, `JSON_SCHEMA_REF_INVALID`, `JSON_SCHEMA_LIMIT_EXCEEDED` | JSON Schemas |
| `SCHEMA_INDEX_INVALID`, `SCHEMA_INDEX_FIELD_UNKNOWN`, `UNIQUE_INDEX_FIELD_UNKNOWN`, `SCHEMA_SEARCH_INVALID`, `SCHEMA_SEARCH_FIELD_UNKNOWN`, `SCHEMA_TTL_INVALID`, `SCHEMA_TTL_TRANSLATION_UNSUPPORTED`, `SCHEMA_UI_INVALID`, `SCHEMA_NAME_CASE_COLLISION`, `FIELD_NAME_CASE_COLLISION`, `MANTLE_REF_INVALID` | Schemas |
| `TRANSLATES_PARENT_UNKNOWN`, `TRANSLATES_REQUIRES_LOCALIZED`, `TRANSLATES_REQUIRES_CONTENT_FIELD`, `TRANSLATES_FIELD_NOT_IN_PARENT`, `TRANSLATES_FIELD_NOT_IN_CHILD`, `TRANSLATES_PARENT_IS_LOCALIZED` | `translates` |
| `VIEW_INPUT_INVALID_SHAPE`, `VIEW_INPUT_RESERVED_NAME`, `VIEW_CACHE_INVALID`, `VIEW_UI_INVALID` | Views |
| `SQL_SYNTAX`, `SQL_UNSUPPORTED`, `SQL_FUNCTION`, `SQL_RELATION`, `SQL_COLUMN`, `SQL_WRITE`, `SQL_SHAPE`, `SQL_TYPE` | View and Procedure SQL, with a position |
| `AUTH_PREDICATE_NOT_IN_ENUM`, `GUARD_PROCEDURE_UNKNOWN`, `GUARD_SELF_REFERENCE`, `GUARD_PROCEDURE_NOT_REF`, `GUARD_CHAIN_NOT_ALLOWED`, `PROCEDURE_TARGET_INVALID` | `requires` and `target` |
| `TRIGGER_TARGET_PROCEDURE_UNKNOWN`, `TRIGGER_PATH_COLLISION`, `TRIGGER_PATH_INVALID`, `SCHEDULE_INPUT_INVALID`, `SCHEDULE_AUTH_INVALID`, `LIFECYCLE_SCHEMA_UNKNOWN`, `LIFECYCLE_TARGET_NOT_REF` | Triggers |
| `MCP_TOOL_NAME_COLLISION`, `MCP_TOOL_DESCRIPTION_MISSING` (warning), `MCP_TOOL_INPUT_UNION_AMBIGUOUS`, `MCP_TOOL_INPUT_UNBOUNDED` | MCP tools |
| `GENERATE_FEATURE_DEPENDENCY_MISSING` | a selected feature, identity, host or dialect whose package is not installed, or `admin` with identity `none`; the message carries the install command |

A schedule Trigger whose cron Cloudflare cannot run the same way, or any
enabled schedule Trigger on host `bun`, fails with exit 1 as
`Trigger <name>: <message>` before anything is written.

`FIXTURE_SCHEMA_VIOLATION` is reserved for consumer test diagnostics.
