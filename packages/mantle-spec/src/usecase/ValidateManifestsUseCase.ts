import {
  validateDiagnostic,
  type Diagnostic,
} from "../kernel/diagnostic.js";
import {
  MANTLE_BIND_VALUES,
  FILTER_COMPARISON_OPS,
  RESERVED_ENTRY_COLUMNS,
  type AuthPredicate,
  type FilterAst,
  type ProcedureManifest,
  type SchemaManifest,
  type TriggerManifest,
  type ViewManifest,
} from "../domain/model/ManifestGrammar.js";
import { partitionManifests } from "../domain/service/ManifestParser.js";
import { checkLocaleAndTranslates } from "../domain/service/CrossSchemaChecker.js";
import {
  bestMatch,
  manifestPath,
  type ManifestFilePaths,
} from "../domain/service/ManifestPathDiagnoser.js";
import type { ValidateManifestsRequest } from "./dto/ValidateManifestsRequest.js";
import type { ValidateManifestsResponse } from "./dto/ValidateManifestsResponse.js";

/**
 * `ValidateManifestsUseCase` — Loop 1 of the SDK authoring contract
 * (ADR-0007 / authoring-contract.md). Pure: no DB, no network. The
 * structural parser (`ManifestParser`) catches single-manifest
 * envelope / shape / DRAFT-key errors. This use case catches everything
 * that requires looking at MULTIPLE manifests together (cross-refs,
 * duplicates, path collisions) plus Schema-aware checks.
 *
 * Diagnostics carry phase: "validate".
 *
 * Stateless and dependency-free; instantiate once and reuse, or call
 * directly via the static `run` helper if construction ceremony adds
 * no value.
 */
export class ValidateManifestsUseCase {
  execute(request: ValidateManifestsRequest): ValidateManifestsResponse {
    const diags: Diagnostic[] = [];
    const partitioned = partitionManifests(request.manifests);
    const schemasByName = byName(partitioned.schemas);
    const proceduresByName = byName(partitioned.procedures);

    diags.push(...checkDuplicates("Schema", partitioned.schemas, request.filePaths));
    diags.push(...checkDuplicates("View", partitioned.views, request.filePaths));
    diags.push(...checkDuplicates("Procedure", partitioned.procedures, request.filePaths));
    diags.push(...checkDuplicates("Trigger", partitioned.triggers, request.filePaths));

    for (const s of partitioned.schemas) {
      diags.push(...checkSchemaInternals(s, request.filePaths));
    }

    diags.push(
      ...checkLocaleAndTranslates({
        schemas: partitioned.schemas,
        phase: "validate",
        siteLocales: request.siteLocales,
        filePaths: request.filePaths,
      }),
    );

    for (const v of partitioned.views) {
      diags.push(...checkViewRefs(v, schemasByName, request.filePaths));
      diags.push(...checkTargetAuth(v, request.filePaths));
    }

    for (const p of partitioned.procedures) {
      diags.push(...checkTargetAuth(p, request.filePaths));
      diags.push(...checkBuiltinHandler(p, schemasByName, request.filePaths));
      diags.push(
        ...collectInvalidPatterns(p.spec.input, "Procedure", p.metadata.name, "/spec/input", request.filePaths),
        ...collectInvalidPatterns(p.spec.output, "Procedure", p.metadata.name, "/spec/output", request.filePaths),
      );
    }

    diags.push(
      ...checkGuards(
        [...partitioned.procedures, ...partitioned.views],
        proceduresByName,
        request.filePaths,
      ),
    );

    diags.push(...checkTriggerRefs(partitioned.triggers, proceduresByName, request.filePaths, schemasByName));

    if (request.handlerSource !== undefined) {
      diags.push(...checkHandlerRefsInSource(partitioned.procedures, request.handlerSource, request.filePaths));
    }

    let errorCount = 0;
    let warningCount = 0;
    for (const d of diags) {
      if (d.severity === "error") errorCount++;
      else warningCount++;
    }
    return { diagnostics: diags, errorCount, warningCount };
  }

  /** Convenience static — equivalent to `new ValidateManifestsUseCase().execute(req)`. */
  static run(request: ValidateManifestsRequest): ValidateManifestsResponse {
    return new ValidateManifestsUseCase().execute(request);
  }
}

function byName<M extends { metadata: { name: string } }>(arr: ReadonlyArray<M>): Map<string, M> {
  const m = new Map<string, M>();
  for (const x of arr) m.set(x.metadata.name, x);
  return m;
}

function checkDuplicates<M extends { kind: string; metadata: { name: string } }>(
  kind: string,
  arr: ReadonlyArray<M>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  // Two-pass: count duplicates, then emit one diagnostic per
  // occurrence (including the first). `manifestPath`'s `occurrence`
  // arg pulls the correct file location per copy so each diagnostic
  // points at its own source position — not at whichever copy the
  // loader saw last.
  const counts = new Map<string, number>();
  for (const m of arr) {
    counts.set(m.metadata.name, (counts.get(m.metadata.name) ?? 0) + 1);
  }
  const seenIndex = new Map<string, number>();
  const out: Diagnostic[] = [];
  for (const m of arr) {
    const total = counts.get(m.metadata.name) ?? 0;
    if (total < 2) continue;
    const ordinal = (seenIndex.get(m.metadata.name) ?? 0) + 1;
    seenIndex.set(m.metadata.name, ordinal);
    out.push(
      validateDiagnostic({
        code: "DUPLICATE_NAME",
        severity: "error",
        path: manifestPath(kind, m.metadata.name, "/metadata/name", filePaths, ordinal),
        value: m.metadata.name,
        expected: `metadata.name unique within kind ${kind}`,
        message: `${kind} manifest '${m.metadata.name}' is duplicated (occurrence ${ordinal} of ${total}).`,
      }),
    );
  }
  return out;
}

function checkSchemaInternals(
  s: SchemaManifest,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const schema = s.spec.schema as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  const properties = schema.properties ?? {};

  // `required` entries that aren't declared in `properties` are never
  // added to the generated zod shape — so a typo'd required field is
  // silently unenforced. Surface it at pre-deploy. (#399)
  if (Array.isArray(schema.required)) {
    schema.required.forEach((field, ri) => {
      if (typeof field === "string" && !(field in properties)) {
        out.push(
          validateDiagnostic({
            code: "REQUIRED_FIELD_UNKNOWN",
            severity: "error",
            path: manifestPath("Schema", s.metadata.name, `/spec/schema/required/${ri}`, filePaths),
            value: field,
            expected: `name of a property declared in spec.schema.properties`,
            candidates: Object.keys(properties),
            suggestion: bestMatch(field, Object.keys(properties)),
            message: `Schema '${s.metadata.name}' lists '${field}' in required but never declares it under properties — the constraint is silently unenforced.`,
          }),
        );
      }
    });
  }

  // Any string `pattern` must compile; an uncompilable one would
  // otherwise throw a raw SyntaxError at first entry write. (#395)
  out.push(
    ...collectInvalidPatterns(s.spec.schema, "Schema", s.metadata.name, "/spec/schema", filePaths),
  );

  const ui = s.spec.uniqueIndexes ?? [];
  ui.forEach((composite, ci) => {
    composite.forEach((field, fi) => {
      if (!(field in properties)) {
        out.push(
          validateDiagnostic({
            code: "UNIQUE_INDEX_FIELD_UNKNOWN",
            severity: "error",
            path: manifestPath(
              "Schema",
              s.metadata.name,
              `/spec/uniqueIndexes/${ci}/${fi}`,
              filePaths,
            ),
            value: field,
            expected: `name of a property declared in spec.schema.properties`,
            candidates: Object.keys(properties),
            suggestion: bestMatch(field, Object.keys(properties)),
            message: `Schema '${s.metadata.name}' uniqueIndexes references unknown field '${field}'.`,
          }),
        );
      }
    });
  });

  for (const [propName, propSpec] of Object.entries(properties)) {
    const ps = propSpec as Record<string, unknown> | null;
    if (!ps || typeof ps !== "object") continue;
    const bind = ps["x-mantle-bind"];
    if (typeof bind !== "string") continue;
    if (!(MANTLE_BIND_VALUES as readonly string[]).includes(bind)) {
      out.push(
        validateDiagnostic({
          code: "BIND_VALUE_NOT_IN_ENUM",
          severity: "error",
          path: manifestPath(
            "Schema",
            s.metadata.name,
            `/spec/schema/properties/${propName}/x-mantle-bind`,
            filePaths,
          ),
          value: bind,
          expected: `one of ${MANTLE_BIND_VALUES.join(", ")}`,
          candidates: [...MANTLE_BIND_VALUES],
          suggestion: bestMatch(bind, [...MANTLE_BIND_VALUES]),
          message: `Schema '${s.metadata.name}' property '${propName}' has illegal x-mantle-bind value.`,
        }),
      );
    }
  }
  return out;
}

/**
 * Walk a JSON Schema (properties + array items, recursively) and emit
 * an INVALID_PATTERN diagnostic for any `pattern` string that
 * `new RegExp` can't compile. The runtime converter skips such a
 * pattern rather than crash, but the author should hear about it at
 * pre-deploy. (#395)
 */
function collectInvalidPatterns(
  root: unknown,
  kind: "Schema" | "Procedure",
  name: string,
  basePointer: string,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const visit = (node: unknown, pointer: string): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n["pattern"] === "string") {
      try {
        new RegExp(n["pattern"] as string);
      } catch (e) {
        out.push(
          validateDiagnostic({
            code: "INVALID_PATTERN",
            severity: "error",
            path: manifestPath(kind, name, `${pointer}/pattern`, filePaths),
            value: n["pattern"],
            expected: "a valid JavaScript regular expression",
            message: `${kind} '${name}' has an uncompilable regex pattern at ${pointer}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          }),
        );
      }
    }
    const props = n["properties"];
    if (props && typeof props === "object") {
      for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
        visit(v, `${pointer}/properties/${k}`);
      }
    }
    if (n["items"] && typeof n["items"] === "object") {
      visit(n["items"], `${pointer}/items`);
    }
  };
  visit(root, basePointer);
  return out;
}

function checkViewRefs(
  v: ViewManifest,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const fromName = v.spec.from;
  const schema = schemasByName.get(fromName);
  if (!schema) {
    out.push(
      validateDiagnostic({
        code: "VIEW_FROM_UNKNOWN_SCHEMA",
        severity: "error",
        path: manifestPath("View", v.metadata.name, "/spec/from", filePaths),
        value: fromName,
        expected: "name of a declared Schema",
        candidates: [...schemasByName.keys()],
        suggestion: bestMatch(fromName, [...schemasByName.keys()]),
        message: `View '${v.metadata.name}' references unknown Schema '${fromName}'.`,
      }),
    );
    return out;
  }

  const props = (schema.spec.schema as { properties?: Record<string, unknown> }).properties ?? {};
  const validFieldNames = new Set([...Object.keys(props), ...RESERVED_ENTRY_COLUMNS]);

  if (v.spec.fields) {
    v.spec.fields.forEach((f, i) => {
      if (!validFieldNames.has(f)) {
        out.push(
          validateDiagnostic({
            code: "VIEW_FIELD_NOT_IN_SCHEMA",
            severity: "error",
            path: manifestPath("View", v.metadata.name, `/spec/fields/${i}`, filePaths),
            value: f,
            expected: `property of Schema '${fromName}' or a reserved metadata field`,
            candidates: [...validFieldNames].sort(),
            suggestion: bestMatch(f, [...validFieldNames]),
            message: `View '${v.metadata.name}' field '${f}' is not declared on Schema '${fromName}'.`,
          }),
        );
      }
    });
  }

  if (v.spec.filter) {
    out.push(
      ...checkFilterFields(
        v.spec.filter,
        validFieldNames,
        v.metadata.name,
        fromName,
        "/spec/filter",
        filePaths,
      ),
    );
  }

  if (v.spec.orderBy) {
    v.spec.orderBy.forEach((o, i) => {
      if (!validFieldNames.has(o.field)) {
        out.push(
          validateDiagnostic({
            code: "VIEW_FIELD_NOT_IN_SCHEMA",
            severity: "error",
            path: manifestPath(
              "View",
              v.metadata.name,
              `/spec/orderBy/${i}/field`,
              filePaths,
            ),
            value: o.field,
            expected: `property of Schema '${fromName}' or a reserved metadata field`,
            candidates: [...validFieldNames].sort(),
            suggestion: bestMatch(o.field, [...validFieldNames]),
            message: `View '${v.metadata.name}' orderBy references unknown field '${o.field}'.`,
          }),
        );
      }
    });
  }

  return out;
}

function checkFilterFields(
  node: FilterAst,
  validFields: ReadonlySet<string>,
  viewName: string,
  schemaName: string,
  jsonPointer: string,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const comparison = getFilterComparison(node);
  if (comparison) {
    if (!validFields.has(comparison.node.field)) {
      return [
        validateDiagnostic({
          code: "VIEW_FILTER_FIELD_NOT_IN_SCHEMA",
          severity: "error",
          path: manifestPath(
            "View",
            viewName,
            `${jsonPointer}/${comparison.op}/field`,
            filePaths,
          ),
          value: comparison.node.field,
          expected: `property of Schema '${schemaName}' or a reserved metadata field`,
          candidates: [...validFields].sort(),
          suggestion: bestMatch(comparison.node.field, [...validFields]),
          message: `View '${viewName}' filter references unknown field '${comparison.node.field}'.`,
        }),
      ];
    }
    return [];
  }
  if ("and" in node) {
    return node.and.flatMap((c, i) =>
      checkFilterFields(c, validFields, viewName, schemaName, `${jsonPointer}/and/${i}`, filePaths),
    );
  }
  if ("or" in node) {
    return node.or.flatMap((c, i) =>
      checkFilterFields(c, validFields, viewName, schemaName, `${jsonPointer}/or/${i}`, filePaths),
    );
  }
  return [];
}

function getFilterComparison(
  node: FilterAst,
): { readonly op: (typeof FILTER_COMPARISON_OPS)[number]; readonly node: { readonly field: string; readonly value: unknown } } | null {
  if ("eq" in node) return { op: "eq", node: node.eq };
  if ("gt" in node) return { op: "gt", node: node.gt };
  if ("gte" in node) return { op: "gte", node: node.gte };
  if ("lt" in node) return { op: "lt", node: node.lt };
  if ("lte" in node) return { op: "lte", node: node.lte };
  return null;
}

function checkBuiltinHandler(
  p: ProcedureManifest,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const h = p.spec.handler;
  if (h.kind !== "builtin") return [];
  const out: Diagnostic[] = [];
  const target = schemasByName.get(h.schema);
  if (!target) {
    out.push(
      validateDiagnostic({
        code: "BUILTIN_HANDLER_SCHEMA_UNKNOWN",
        severity: "error",
        path: manifestPath("Procedure", p.metadata.name, "/spec/handler/schema", filePaths),
        value: h.schema,
        expected: "name of a declared Schema",
        candidates: [...schemasByName.keys()],
        suggestion: bestMatch(h.schema, [...schemasByName.keys()]),
        message: `Procedure '${p.metadata.name}' has handler.kind: builtin / schema: '${h.schema}', but no Schema by that name is declared.`,
      }),
    );
    return out;
  }
  // op: archive is editorial-only. Inline the lifecycle resolution
  // here — we need only the Schema.spec.lifecycle default, not the
  // full state-machine helpers.
  const lifecycle = target.spec.lifecycle ?? "simple";
  if (h.op === "archive" && lifecycle !== "editorial") {
    out.push(
      validateDiagnostic({
        code: "BUILTIN_HANDLER_SCHEMA_NOT_EDITORIAL",
        severity: "error",
        path: manifestPath("Procedure", p.metadata.name, "/spec/handler/op", filePaths),
        value: "archive",
        expected: `Schema '${h.schema}' to declare lifecycle: editorial (op: archive is editorial-only — see ADR-0011)`,
        message: `Procedure '${p.metadata.name}' uses op: archive on Schema '${h.schema}', but that Schema's lifecycle is 'simple'. Either set Schema.spec.lifecycle: editorial or use op: delete.`,
      }),
    );
  }
  return out;
}

function checkTargetAuth(
  p: ProcedureManifest | ViewManifest,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const all = p.spec.requires?.auth?.all;
  if (!all) return out;
  all.forEach((pred, i) => {
    if (!isValidPredicate(pred)) {
      out.push(
        validateDiagnostic({
          code: "AUTH_PREDICATE_NOT_IN_ENUM",
          severity: "error",
          path: manifestPath(
            "Procedure",
            p.metadata.name,
            `/spec/requires/auth/all/${i}`,
            filePaths,
          ),
          value: pred,
          expected: "'ctx.user', 'ctx.auth', { 'ctx.auth.scope': <scope> }, or { 'ctx.staff': [<role>, ...] }",
          message: `${p.kind} '${p.metadata.name}' has an illegal auth predicate.`,
        }),
      );
    }
  });
  return out;
}

function isValidPredicate(p: unknown): p is AuthPredicate {
  if (p === "ctx.user" || p === "ctx.auth") return true;
  if (
    typeof p === "object" &&
    p !== null &&
    !Array.isArray(p) &&
    "ctx.auth.scope" in (p as object)
  ) {
    const scope = (p as Record<string, unknown>)["ctx.auth.scope"];
    return typeof scope === "string" && scope.length > 0;
  }
  if (
    typeof p === "object" &&
    p !== null &&
    !Array.isArray(p) &&
    "ctx.staff" in (p as object)
  ) {
    const roles = (p as Record<string, unknown>)["ctx.staff"];
    if (Array.isArray(roles) && roles.length > 0 && roles.every((r) => typeof r === "string")) {
      return true;
    }
  }
  return false;
}

function checkGuards(
  targets: ReadonlyArray<ProcedureManifest | ViewManifest>,
  proceduresByName: ReadonlyMap<string, ProcedureManifest>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const target of targets) {
    const guardName = target.spec.requires?.guard?.procedure;
    if (!guardName) continue;
    const path = manifestPath(
      target.kind,
      target.metadata.name,
      "/spec/requires/guard/procedure",
      filePaths,
    );
    const guard = proceduresByName.get(guardName);
    if (!guard) {
      out.push(
        validateDiagnostic({
          code: "GUARD_PROCEDURE_UNKNOWN",
          severity: "error",
          path,
          value: guardName,
          expected: "name of a declared Procedure",
          candidates: [...proceduresByName.keys()],
          suggestion: bestMatch(guardName, [...proceduresByName.keys()]),
          message: `${target.kind} '${target.metadata.name}' references unknown guard Procedure '${guardName}'.`,
        }),
      );
      continue;
    }
    if (target.kind === "Procedure" && target.metadata.name === guardName) {
      out.push(
        validateDiagnostic({
          code: "GUARD_SELF_REFERENCE",
          severity: "error",
          path,
          value: guardName,
          expected: "a different, unguarded Procedure",
          message: `Procedure '${target.metadata.name}' cannot guard itself.`,
        }),
      );
      continue;
    }
    if (guard.spec.handler.kind !== "ref") {
      out.push(
        validateDiagnostic({
          code: "GUARD_PROCEDURE_BUILTIN",
          severity: "error",
          path,
          value: guardName,
          expected: "a Procedure with handler.kind: ref",
          message: `${target.kind} '${target.metadata.name}' uses '${guardName}' as a guard, but guard Procedures cannot use builtin handlers.`,
        }),
      );
    }
    if (guard.spec.requires?.guard) {
      out.push(
        validateDiagnostic({
          code: "GUARD_CHAIN_NOT_ALLOWED",
          severity: "error",
          path,
          value: guardName,
          expected: "an unguarded Procedure",
          message: `${target.kind} '${target.metadata.name}' uses '${guardName}' as a guard, but guard chains are not allowed.`,
        }),
      );
    }
  }
  return out;
}

function checkTriggerRefs(
  triggers: ReadonlyArray<TriggerManifest>,
  proceduresByName: ReadonlyMap<string, ProcedureManifest>,
  filePaths?: ManifestFilePaths,
  schemasByName?: ReadonlyMap<string, SchemaManifest>,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const httpRoutes = new Map<string, string>();

  for (const t of triggers) {
    const procName = t.spec.target.procedure;
    if (!proceduresByName.has(procName)) {
      out.push(
        validateDiagnostic({
          code: "TRIGGER_TARGET_PROCEDURE_UNKNOWN",
          severity: "error",
          path: manifestPath("Trigger", t.metadata.name, "/spec/target/procedure", filePaths),
          value: procName,
          expected: "name of a declared Procedure",
          candidates: [...proceduresByName.keys()],
          suggestion: bestMatch(procName, [...proceduresByName.keys()]),
          message: `Trigger '${t.metadata.name}' targets unknown Procedure '${procName}'.`,
        }),
      );
    }

    if (t.spec.source.kind === "http") {
      const httpPath = t.spec.source.path;
      const isValidPrefix = httpPath.startsWith("/api/");
      if (!isValidPrefix) {
        out.push(
          validateDiagnostic({
            code: "TRIGGER_PATH_INVALID",
            severity: "error",
            path: manifestPath("Trigger", t.metadata.name, "/spec/source/path", filePaths),
            value: httpPath,
            expected: "path starting with '/api/'",
            message:
              `Trigger '${t.metadata.name}' has path '${httpPath}' — http Trigger ` +
              `paths MUST start with '/api/' so adapters can route public ` +
              `pages and Procedure endpoints without ambiguity.`,
          }),
        );
      }
      // Only track valid paths for collision detection — emitting both
      // TRIGGER_PATH_INVALID and TRIGGER_PATH_COLLISION for the same
      // bad path produces noisy diagnostics that misdescribe the root
      // cause (collision is secondary; the path is the real error).
      const key = `${t.spec.source.method} ${httpPath}`;
      const prior = httpRoutes.get(key);
      if (prior) {
        out.push(
          validateDiagnostic({
            code: "TRIGGER_PATH_COLLISION",
            severity: "error",
            path: manifestPath("Trigger", t.metadata.name, "/spec/source", filePaths),
            value: key,
            expected: `unique (method, path) across all http Triggers (also declared by '${prior}')`,
            message: `Trigger '${t.metadata.name}' shares route ${key} with Trigger '${prior}'.`,
          }),
        );
      } else if (isValidPrefix) {
        httpRoutes.set(key, t.metadata.name);
      }
    }

    if (t.spec.source.kind === "lifecycle" && schemasByName && !schemasByName.has(t.spec.source.schema)) {
      const schemaName = t.spec.source.schema;
      out.push(
        validateDiagnostic({
          code: "LIFECYCLE_SCHEMA_UNKNOWN",
          severity: "error",
          path: manifestPath("Trigger", t.metadata.name, "/spec/source/schema", filePaths),
          value: schemaName,
          expected: "name of a declared Schema",
          candidates: [...schemasByName.keys()],
          suggestion: bestMatch(schemaName, [...schemasByName.keys()]),
          message: `Trigger '${t.metadata.name}' watches unknown Schema '${schemaName}'.`,
        }),
      );
    }
  }
  return out;
}

function checkHandlerRefsInSource(
  procedures: ReadonlyArray<ProcedureManifest>,
  source: string,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const p of procedures) {
    if (p.spec.handler.kind !== "ref") continue;
    const ref = p.spec.handler.ref;
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Two registration patterns we accept as evidence:
    //   1. Quoted string literal: `registerHandler('captchaCheck', ...)`
    //      or `handlers: { 'captchaCheck': ... }`
    //   2. Unquoted object-property-key shorthand:
    //      `{ captchaCheck: someFn, slackNotify: otherFn }` —
    //      the idiomatic JS form the publication / intake / presence
    //      starters use in `src/handlers/index.ts`'s buildHandlers().
    //
    // Both are evidence that the handler is wired; boot's catalog
    // check is the source of truth either way, so a false negative
    // here would just delay the same diagnostic until boot.
    const quoted = new RegExp(`["'\`]${escaped}["'\`]`);
    const propertyKey = new RegExp(`(?:^|[\\s{,;])${escaped}\\s*:`, "m");
    if (!quoted.test(source) && !propertyKey.test(source)) {
      out.push(
        validateDiagnostic({
          code: "HANDLER_NOT_REGISTERED",
          severity: "warning",
          path: manifestPath(
            "Procedure",
            p.metadata.name,
            "/spec/handler/ref",
            filePaths,
          ),
          value: ref,
          expected: `'${ref}' to appear in handler source as a quoted string (e.g. registerHandler('${ref}', ...)) or an unquoted object-property key (e.g. { ${ref}: someFn })`,
          message: `Procedure '${p.metadata.name}' handler.ref '${ref}' was not found in any handler source file. The boot-time validator will hard-fail if it isn't registered at runtime.`,
        }),
      );
    }
  }
  return out;
}
