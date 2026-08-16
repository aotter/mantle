import {
  validateDiagnostic,
  type Diagnostic,
} from "../../kernel/diagnostic.js";
import {
  FILTER_COMPARISON_OPS,
  RESERVED_ENTRY_COLUMNS,
  hasCtxUserRefKey,
  isCtxUserRef,
  type FilterAst,
  type Manifest,
  type ProcedureManifest,
  type SchemaManifest,
  type TriggerManifest,
  type ViewManifest,
} from "../model/ManifestGrammar.js";
import { partitionManifests } from "./ManifestPartition.js";
import { checkTranslatesReferences } from "./CrossSchemaChecker.js";
import { checkViewAdminUi } from "./SchemaAdminUiChecker.js";
import {
  bestMatch,
  manifestPath,
  type ManifestFilePaths,
} from "./ManifestPathDiagnoser.js";
import {
  mcpToolNameSegment,
  RESERVED_MCP_GENERIC_TOOL_NAMES,
  RESERVED_MCP_TOOL_PREFIXES,
} from "./McpToolNaming.js";

/**
 * Package-private implementation of the pure graph rules. The public sealed
 * entry is `linkManifestSet`; the compatibility validator delegates there.
 */
export function validateManifestGraph(
  manifests: readonly Manifest[],
  filePaths?: ManifestFilePaths,
): {
  readonly diagnostics: readonly Diagnostic[];
  readonly schemas: readonly SchemaManifest[];
  readonly views: readonly ViewManifest[];
  readonly procedures: readonly ProcedureManifest[];
  readonly triggers: readonly TriggerManifest[];
} {
  const diags: Diagnostic[] = [];
  const partitioned = partitionManifests(manifests);
  const schemasByName = byName(partitioned.schemas);
  const proceduresByName = byName(partitioned.procedures);

  diags.push(...checkDuplicates("Schema", partitioned.schemas, filePaths));
  diags.push(...checkDuplicates("View", partitioned.views, filePaths));
  diags.push(...checkDuplicates("Procedure", partitioned.procedures, filePaths));
  diags.push(...checkDuplicates("Trigger", partitioned.triggers, filePaths));

  diags.push(...checkTranslatesReferences(partitioned.schemas, "validate", filePaths));

  for (const v of partitioned.views) {
    diags.push(...checkViewRefs(v, schemasByName, filePaths));
  }

  for (const p of partitioned.procedures) {
    diags.push(...checkBuiltinHandler(p, schemasByName, filePaths));
    diags.push(...checkCollectionActionRef(p, schemasByName, filePaths));
  }

  diags.push(
    ...checkGuards(
      [...partitioned.procedures, ...partitioned.views],
      proceduresByName,
      filePaths,
    ),
  );

  diags.push(...checkTriggerRefs(partitioned.triggers, proceduresByName, filePaths, schemasByName));
  diags.push(...checkMcpToolNameCollisions(
    partitioned.schemas,
    partitioned.views,
    partitioned.procedures,
    filePaths,
  ));

  return { diagnostics: diags, ...partitioned };
}

function checkCollectionActionRef(
  procedure: ProcedureManifest,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const target = procedure.spec.uiSchema?.["collectionAction"];
  if (typeof target !== "string" || schemasByName.has(target)) return [];
  return [validateDiagnostic({
    code: "SCHEMA_UI_INVALID",
    severity: "error",
    path: manifestPath("Procedure", procedure.metadata.name, "/spec/uiSchema/collectionAction", filePaths),
    value: target,
    expected: "the metadata.name of an existing Schema",
    message: `Procedure '${procedure.metadata.name}' collection action references unknown Schema '${target}'.`,
  })];
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

function checkViewRefs(
  v: ViewManifest,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  if (v.spec.sql) return [];
  const out: Diagnostic[] = [];
  const fromName = v.spec.from;
  if (!fromName) return out;
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

  const list = checkViewAdminUi(v).list;
  for (const [key, fields] of Object.entries(list) as Array<[
    keyof typeof list,
    readonly string[],
  ]>) {
    fields.forEach((field, index) => {
      if (!validFieldNames.has(field)) {
        out.push(validateDiagnostic({
          code: "VIEW_UI_INVALID",
          severity: "error",
          path: manifestPath("View", v.metadata.name, `/spec/uiSchema/list/${key}/${index}`, filePaths),
          value: field,
          expected: `property of Schema '${fromName}' or a reserved metadata field`,
          candidates: [...validFieldNames].sort(),
          suggestion: bestMatch(field, [...validFieldNames]),
          message: `View '${v.metadata.name}' Admin list references unknown field '${field}'.`,
        }));
      }
    });
  }

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
    out.push(...checkCtxUserFilter(v, schema, filePaths));
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

function checkCtxUserFilter(
  view: ViewManifest,
  schema: SchemaManifest,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  if (!view.spec.filter) return [];
  const refs = collectCtxUserFilters(view.spec.filter, "/spec/filter");
  if (refs.length === 0) return [];
  const out: Diagnostic[] = [];
  const hasUserGate = view.spec.requires?.auth?.all?.includes("ctx.user") ?? false;
  const indexes = [...(schema.spec.uniqueIndexes ?? []), ...(schema.spec.indexes ?? [])];
  for (const ref of refs) {
    if (!ref.valid) {
      out.push(validateDiagnostic({
        code: "VIEW_FILTER_CTX_USER_REF_INVALID",
        severity: "error",
        path: manifestPath("View", view.metadata.name, ref.pointer, filePaths),
        value: ref.value,
        expected: 'exactly { "$ctx.user": "id" } as an eq comparison value',
        message: `View '${view.metadata.name}' has an invalid ctx.user filter sentinel.`,
      }));
      continue;
    }
    if (!hasUserGate) {
      out.push(validateDiagnostic({
        code: "VIEW_FILTER_CTX_USER_REF_REQUIRES_AUTH",
        severity: "error",
        path: manifestPath("View", view.metadata.name, "/spec/requires/auth/all", filePaths),
        expected: "ctx.user",
        message: `View '${view.metadata.name}' binds a filter to ctx.user but does not require ctx.user.`,
      }));
    }
    if (!indexes.some((index) => index[0] === ref.field)) {
      out.push(validateDiagnostic({
        code: "VIEW_FILTER_CTX_USER_REF_REQUIRES_INDEX",
        severity: "error",
        path: manifestPath("View", view.metadata.name, ref.fieldPointer, filePaths),
        value: ref.field,
        expected: `Schema '${schema.metadata.name}' index whose first field is '${ref.field}'`,
        message: `View '${view.metadata.name}' must index identity-bound field '${ref.field}' as the leftmost field.`,
      }));
    }
  }
  return out;
}

function collectCtxUserFilters(
  node: FilterAst,
  pointer: string,
): Array<{
  readonly field: string;
  readonly fieldPointer: string;
  readonly pointer: string;
  readonly value: unknown;
  readonly valid: boolean;
}> {
  const comparison = getFilterComparison(node);
  if (comparison) {
    if (!hasCtxUserRefKey(comparison.node.value)) return [];
    return [{
      field: comparison.node.field,
      fieldPointer: `${pointer}/${comparison.op}/field`,
      pointer: `${pointer}/${comparison.op}/value`,
      value: comparison.node.value,
      valid: comparison.op === "eq" && isCtxUserRef(comparison.node.value),
    }];
  }
  const children = "and" in node ? node.and : "or" in node ? node.or : [];
  const key = "and" in node ? "and" : "or";
  return children.flatMap((child, index) =>
    collectCtxUserFilters(child, `${pointer}/${key}/${index}`),
  );
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
  return out;
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

interface ToolNameOwner {
  readonly kind: "Schema" | "View" | "Procedure";
  readonly name: string;
}

function checkMcpToolNameCollisions(
  schemas: readonly SchemaManifest[],
  views: readonly ViewManifest[],
  procedures: readonly ProcedureManifest[],
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const seen = new Map<string, ToolNameOwner>();
  const out: Diagnostic[] = [];
  for (const schema of schemas) {
    const segment = mcpToolNameSegment(schema.metadata.name);
    const prior = seen.get(segment);
    if (prior && !sameOwner(prior, "Schema", schema.metadata.name)) {
      out.push(validateDiagnostic({
        code: "MCP_TOOL_NAME_COLLISION",
        severity: "error",
        path: manifestPath("Schema", schema.metadata.name, "/metadata/name", filePaths),
        value: segment,
        expected: `Schema name unique after kebab→snake mangling (collides with '${prior.name}')`,
        message: `Schema '${schema.metadata.name}' mangles to MCP tool suffix '${segment}', which already comes from Schema '${prior.name}'.`,
      }));
    } else if (!prior) {
      seen.set(segment, { kind: "Schema", name: schema.metadata.name });
    }
  }
  const viewNames = new Map<string, string>();
  for (const view of views) {
    const segment = mcpToolNameSegment(view.metadata.name);
    const prior = viewNames.get(segment);
    if (prior && prior !== view.metadata.name) {
      out.push(validateDiagnostic({
        code: "MCP_TOOL_NAME_COLLISION",
        severity: "error",
        path: manifestPath("View", view.metadata.name, "/metadata/name", filePaths),
        value: `query_view_${segment}`,
        expected: `View name unique after kebab→snake mangling (collides with '${prior}')`,
        message: `View '${view.metadata.name}' mangles to MCP tool name 'query_view_${segment}', which already comes from View '${prior}'.`,
      }));
    } else if (!prior) {
      viewNames.set(segment, view.metadata.name);
    }
  }
  for (const procedure of procedures) {
    const name = mcpToolNameSegment(procedure.metadata.name);
    let conflict: string | null = null;
    if (RESERVED_MCP_GENERIC_TOOL_NAMES.has(name)) {
      conflict = `built-in MCP tool '${name}'`;
    } else {
      const prefix = RESERVED_MCP_TOOL_PREFIXES.find((candidate) => name.startsWith(candidate));
      if (prefix) conflict = `reserved tool-name prefix '${prefix}' (used by Schema / View tools)`;
      else {
        const prior = seen.get(name);
        if (prior && !sameOwner(prior, "Procedure", procedure.metadata.name)) {
          conflict = `${prior.kind} '${prior.name}'`;
        }
      }
    }
    if (conflict) {
      out.push(validateDiagnostic({
        code: "MCP_TOOL_NAME_COLLISION",
        severity: "error",
        path: manifestPath("Procedure", procedure.metadata.name, "/metadata/name", filePaths),
        value: name,
        expected: `Procedure name unique after kebab→snake mangling (collides with ${conflict})`,
        message: `Procedure '${procedure.metadata.name}' mangles to MCP tool name '${name}', which collides with ${conflict}.`,
      }));
      continue;
    }
    seen.set(name, { kind: "Procedure", name: procedure.metadata.name });
  }
  return out;
}

function sameOwner(
  prior: ToolNameOwner,
  kind: ToolNameOwner["kind"],
  name: string,
): boolean {
  return prior.kind === kind && prior.name === name;
}
