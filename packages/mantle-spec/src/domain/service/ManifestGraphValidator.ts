import {
  validateDiagnostic,
  type Diagnostic,
} from "../../kernel/diagnostic.js";
import {
  FILTER_COMPARISON_OPS,
  RESERVED_ENTRY_COLUMNS,
  EXPECTED_VERSION_PROPERTY,
  MANTLE_REF_KEYWORD,
  RESERVED_PROCEDURE_INPUT_NAMES,
  hasCtxUserRefKey,
  isCtxUserRef,
  resolveLocalizedText,
  type FilterAst,
  type JsonSchema,
  type Manifest,
  type ProcedureManifest,
  type SchemaManifest,
  type TriggerManifest,
  type ViewManifest,
} from "../model/ManifestGrammar.js";
import { partitionManifests } from "./ManifestPartition.js";
import { checkTranslatesReferences } from "./CrossSchemaChecker.js";
import { checkSchemaNavTargets, checkViewAdminUi } from "./SchemaAdminUiChecker.js";
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
  diags.push(...checkSchemaReservedWireNames(partitioned.schemas, filePaths));

  diags.push(...checkTranslatesReferences(partitioned.schemas, "validate", filePaths));
  diags.push(...checkSchemaNavTargetsGraph(partitioned.schemas, schemasByName, filePaths));

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
    partitioned.triggers,
    filePaths,
  ));
  diags.push(...checkMcpExpectedVersionReachability(
    partitioned.views,
    proceduresByName,
    partitioned.triggers,
    filePaths,
  ));

  return { diagnostics: diags, ...partitioned };
}

function checkSchemaNavTargetsGraph(
  schemas: readonly SchemaManifest[],
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const schema of schemas) {
    const problem = checkSchemaNavTargets(schema, schemasByName);
    if (!problem) continue;
    out.push(validateDiagnostic({
      code: "SCHEMA_UI_INVALID",
      severity: "error",
      path: manifestPath("Schema", schema.metadata.name, problem.pointer, filePaths),
      value: problem.value,
      expected: problem.expected,
      message: problem.message,
    }));
  }
  return out;
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

function checkSchemaReservedWireNames(
  schemas: readonly SchemaManifest[],
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const schema of schemas) {
    const properties = schema.spec.schema.properties ?? {};
    for (const reserved of RESERVED_PROCEDURE_INPUT_NAMES) {
      if (!(reserved in properties) || properties[reserved] === undefined) continue;
      out.push(
        validateDiagnostic({
          code: "INVALID_MANIFEST_ENVELOPE",
          severity: "error",
          path: manifestPath("Schema", schema.metadata.name, `/spec/schema/properties/${reserved}`, filePaths),
          value: reserved,
          expected: `Schema data properties that do not collide with reserved Procedure input names (${RESERVED_PROCEDURE_INPUT_NAMES.join(", ")}). New reserved names need an ADR.`,
          message: `Schema '${schema.metadata.name}' must not declare reserved Procedure input name '${reserved}' as a data property (ADR-0022). New reserved names need an ADR.`,
        }),
      );
    }
  }
  return out;
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

  if (v.spec.cache && (schema.spec.lifecycle ?? "publishing") !== "publishing") {
    out.push(validateDiagnostic({
      code: "VIEW_CACHE_INVALID",
      severity: "error",
      path: manifestPath("View", v.metadata.name, "/spec/cache", filePaths),
      value: fromName,
      expected: "a View over a publishing Schema",
      message: `View '${v.metadata.name}' cannot cache operational Schema '${fromName}'.`,
    }));
  }
  const publicPublishing = v.spec.surface === "public"
    && (schema.spec.lifecycle ?? "publishing") === "publishing";
  if (publicPublishing && Object.hasOwn(schema.spec.schema.properties ?? {}, "status")) {
    out.push(validateDiagnostic({
      code: "VIEW_PUBLIC_STATUS_INVALID",
      severity: "error",
      path: manifestPath("View", v.metadata.name, "/spec/from", filePaths),
      value: fromName,
      expected: "a publishing Schema whose data properties do not shadow the native status column",
      message: `View '${v.metadata.name}' is public over publishing Schema '${fromName}', which declares a data property named 'status'; the runtime cannot restrict this View to published rows. Rename the property (for example 'orderStatus').`,
    }));
  } else if (publicPublishing && v.spec.filter) {
    // The runtime injects `status = published` into this View's plan (#1007);
    // any other status comparison can only contradict it and return nothing.
    for (const found of collectStatusComparisons(v.spec.filter, "/spec/filter")) {
      out.push(validateDiagnostic({
        code: "VIEW_PUBLIC_STATUS_INVALID",
        severity: "error",
        path: manifestPath("View", v.metadata.name, found.pointer, filePaths),
        value: found.value,
        expected: "eq status published, or no status comparison at all",
        message: `View '${v.metadata.name}' is public over publishing Schema '${fromName}'; it always reads published rows only, so its status filter must be 'eq published' or omitted.`,
      }));
    }
  }
  if (v.spec.cache && v.spec.filter && collectCtxUserFilters(v.spec.filter, "/spec/filter").length > 0) {
    out.push(validateDiagnostic({
      code: "VIEW_CACHE_INVALID",
      severity: "error",
      path: manifestPath("View", v.metadata.name, "/spec/cache", filePaths),
      expected: "a caller-independent View without $ctx.user filters",
      message: `View '${v.metadata.name}' cannot cache an identity-bound filter.`,
    }));
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

/** Status comparisons other than `eq status published`, with their JSON pointers. */
function collectStatusComparisons(
  node: FilterAst,
  pointer: string,
): Array<{ readonly pointer: string; readonly value: unknown }> {
  const comparison = getFilterComparison(node);
  if (comparison) {
    if (comparison.node.field !== "status") return [];
    if (comparison.op === "eq" && comparison.node.value === "published") return [];
    return [{ pointer: `${pointer}/${comparison.op}/value`, value: comparison.node.value }];
  }
  const children = "and" in node ? node.and : "or" in node ? node.or : [];
  const key = "and" in node ? "and" : "or";
  return children.flatMap((child, index) => collectStatusComparisons(child, `${pointer}/${key}/${index}`));
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
  // Declared annotations must not contradict what the builtin op proves (#972):
  // every op writes, and delete destroys. A false hint would tell a client to
  // skip the confirmation the MCP spec defaults to.
  if (p.spec.mcp?.readOnlyHint === true) {
    out.push(
      validateDiagnostic({
        code: "BUILTIN_HANDLER_CONTRACT_INVALID",
        severity: "error",
        path: manifestPath("Procedure", p.metadata.name, "/spec/mcp/readOnlyHint", filePaths),
        value: true,
        expected: "no readOnlyHint, or readOnlyHint: false, on a builtin handler",
        message: `Procedure '${p.metadata.name}' declares mcp.readOnlyHint: true but its builtin handler (op: ${h.op}) writes.`,
      }),
    );
  }
  if (h.op === "delete" && p.spec.mcp?.destructiveHint === false) {
    out.push(
      validateDiagnostic({
        code: "BUILTIN_HANDLER_CONTRACT_INVALID",
        severity: "error",
        path: manifestPath("Procedure", p.metadata.name, "/spec/mcp/destructiveHint", filePaths),
        value: false,
        expected: "no destructiveHint, or destructiveHint: true, on a builtin delete",
        message: `Procedure '${p.metadata.name}' declares mcp.destructiveHint: false but its builtin handler deletes.`,
      }),
    );
  }
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

  const inputSchema = p.spec.input as JsonSchema;
  if (!isObjectSchema(inputSchema)) {
    out.push(
      validateDiagnostic({
        code: "BUILTIN_HANDLER_CONTRACT_INVALID",
        severity: "error",
        path: manifestPath("Procedure", p.metadata.name, "/spec/input", filePaths),
        value: inputSchema.type,
        expected: "type: 'object'",
        message: `Procedure '${p.metadata.name}' (builtin op: ${h.op}) input must be an object schema.`,
      }),
    );
    return out;
  }

  const inputProps = (inputSchema.properties ?? {}) as Record<string, JsonSchema>;
  const inputRequired = new Set(inputSchema.required ?? []);

  if (h.op === "update") {
    if (!("id" in inputProps) || inputProps.id === undefined) {
      out.push(
        validateDiagnostic({
          code: "BUILTIN_HANDLER_CONTRACT_INVALID",
          severity: "error",
          path: manifestPath("Procedure", p.metadata.name, "/spec/input/properties/id", filePaths),
          expected: "property 'id' with type 'string'",
          message: `Procedure '${p.metadata.name}' (builtin op: update) requires input property 'id' with type 'string'.`,
        }),
      );
    } else if (!isStrictTypeString(inputProps.id)) {
      out.push(
        validateDiagnostic({
          code: "BUILTIN_HANDLER_CONTRACT_INVALID",
          severity: "error",
          path: manifestPath("Procedure", p.metadata.name, "/spec/input/properties/id", filePaths),
          value: inputProps.id.type,
          expected: "type: 'string'",
          message: `Procedure '${p.metadata.name}' (builtin op: update) property 'id' must be strict type 'string'.`,
        }),
      );
    }

    pushExpectedVersionContract(out, p, inputProps, inputRequired, filePaths, {
      opLabel: "update",
      required: true,
    });

    if (!inputRequired.has("id")) {
      out.push(
        validateDiagnostic({
          code: "BUILTIN_HANDLER_CONTRACT_INVALID",
          severity: "error",
          path: manifestPath("Procedure", p.metadata.name, "/spec/input/required", filePaths),
          expected: "required to include 'id'",
          message: `Procedure '${p.metadata.name}' (builtin op: update) requires 'id' in input.required.`,
        }),
      );
    }
  } else if (h.op === "delete" || h.op === "archive") {
    if (h.op === "archive" && target.spec.lifecycle === "operational") {
      out.push(
        validateDiagnostic({
          code: "BUILTIN_HANDLER_CONTRACT_INVALID",
          severity: "error",
          path: manifestPath("Procedure", p.metadata.name, "/spec/handler/op", filePaths),
          value: h.op,
          expected: "Schema with lifecycle: 'publishing' (operational Schemas do not support archive)",
          message: `Procedure '${p.metadata.name}' (builtin op: archive) targets Schema '${target.metadata.name}' with lifecycle: 'operational'. Operational Schemas cannot be archived.`,
        }),
      );
    }

    if (!("id" in inputProps) || inputProps.id === undefined) {
      out.push(
        validateDiagnostic({
          code: "BUILTIN_HANDLER_CONTRACT_INVALID",
          severity: "error",
          path: manifestPath("Procedure", p.metadata.name, "/spec/input/properties/id", filePaths),
          expected: "property 'id' with type 'string'",
          message: `Procedure '${p.metadata.name}' (builtin op: ${h.op}) requires input property 'id' with type 'string'.`,
        }),
      );
    } else if (!isStrictTypeString(inputProps.id)) {
      out.push(
        validateDiagnostic({
          code: "BUILTIN_HANDLER_CONTRACT_INVALID",
          severity: "error",
          path: manifestPath("Procedure", p.metadata.name, "/spec/input/properties/id", filePaths),
          value: inputProps.id.type,
          expected: "type: 'string'",
          message: `Procedure '${p.metadata.name}' (builtin op: ${h.op}) property 'id' must be strict type 'string'.`,
        }),
      );
    }

    if (!inputRequired.has("id")) {
      out.push(
        validateDiagnostic({
          code: "BUILTIN_HANDLER_CONTRACT_INVALID",
          severity: "error",
          path: manifestPath("Procedure", p.metadata.name, "/spec/input/required", filePaths),
          expected: "required to include 'id'",
          message: `Procedure '${p.metadata.name}' (builtin op: ${h.op}) requires 'id' in input.required.`,
        }),
      );
    }
  } else if (h.op === "upsert") {
    if (h.match) {
      const targetProps = ((target.spec.schema as { properties?: Record<string, unknown> }).properties ?? {});
      const uniqueIndexes = target.spec.uniqueIndexes ?? [];
      const matchesUniqueIndex = uniqueIndexes.some(
        (idx) => idx.length === h.match!.length && idx.every((col, i) => col === h.match![i]),
      );
      if (!matchesUniqueIndex) {
        out.push(
          validateDiagnostic({
            code: "BUILTIN_HANDLER_CONTRACT_INVALID",
            severity: "error",
            path: manifestPath("Procedure", p.metadata.name, "/spec/handler/match", filePaths),
            value: h.match,
            expected: `exact match with one declared unique index in Schema '${target.metadata.name}'`,
            message: `Procedure '${p.metadata.name}' handler.match [${h.match.join(", ")}] does not match any declared unique index on Schema '${target.metadata.name}'.`,
          }),
        );
      }

      for (const field of h.match) {
        if (!(field in targetProps)) {
          out.push(
            validateDiagnostic({
              code: "BUILTIN_HANDLER_CONTRACT_INVALID",
              severity: "error",
              path: manifestPath("Procedure", p.metadata.name, "/spec/handler/match", filePaths),
              value: field,
              expected: `property declared in Schema '${target.metadata.name}' spec.schema.properties`,
              message: `Procedure '${p.metadata.name}' matched field '${field}' is not declared on Schema '${target.metadata.name}'.`,
            }),
          );
        }
        if (!(field in inputProps) || inputProps[field] === undefined) {
          out.push(
            validateDiagnostic({
              code: "BUILTIN_HANDLER_CONTRACT_INVALID",
              severity: "error",
              path: manifestPath("Procedure", p.metadata.name, `/spec/input/properties/${field}`, filePaths),
              expected: `property '${field}' declared in Procedure input properties`,
              message: `Procedure '${p.metadata.name}' matched field '${field}' is missing from Procedure input properties.`,
            }),
          );
        }
        if (!inputRequired.has(field)) {
          out.push(
            validateDiagnostic({
              code: "BUILTIN_HANDLER_CONTRACT_INVALID",
              severity: "error",
              path: manifestPath("Procedure", p.metadata.name, "/spec/input/required", filePaths),
              expected: `required to include matched field '${field}'`,
              message: `Procedure '${p.metadata.name}' matched field '${field}' must be in input.required.`,
            }),
          );
        }
      }

      if ("id" in inputProps && inputProps.id !== undefined) {
        out.push(
          validateDiagnostic({
            code: "BUILTIN_HANDLER_CONTRACT_INVALID",
            severity: "error",
            path: manifestPath("Procedure", p.metadata.name, "/spec/input/properties/id", filePaths),
            value: inputProps.id,
            expected: "no 'id' property when using matched upsert",
            message: `Procedure '${p.metadata.name}' uses matched upsert; input must not declare 'id'.`,
          }),
        );
      }
      pushExpectedVersionContract(out, p, inputProps, inputRequired, filePaths, {
        opLabel: "upsert",
        required: false,
      });
    } else {
      const hasId = "id" in inputProps && inputProps.id !== undefined;
      if (hasId && !isStrictTypeString(inputProps.id)) {
        out.push(
          validateDiagnostic({
            code: "BUILTIN_HANDLER_CONTRACT_INVALID",
            severity: "error",
            path: manifestPath("Procedure", p.metadata.name, "/spec/input/properties/id", filePaths),
            value: inputProps.id?.type,
            expected: "type: 'string'",
            message: `Procedure '${p.metadata.name}' (builtin op: upsert) property 'id' must be strict type 'string'.`,
          }),
        );
      }
      pushExpectedVersionContract(out, p, inputProps, inputRequired, filePaths, {
        opLabel: "upsert",
        required: false,
      });
    }
  }

  return out;
}

function isObjectSchema(s: JsonSchema): boolean {
  if (s.type === "object") return true;
  if (Array.isArray(s.type) && s.type.length === 1 && s.type[0] === "object") return true;
  return false;
}

function isStrictTypeString(s?: JsonSchema): boolean {
  if (!s || typeof s !== "object") return false;
  if (Array.isArray(s.type)) return false;
  if (s.type !== "string") return false;
  if ((s as { nullable?: boolean }).nullable === true) return false;
  return true;
}

function isStrictTypeNumber(s?: JsonSchema): boolean {
  if (!s || typeof s !== "object") return false;
  if (Array.isArray(s.type)) return false;
  if (s.type !== "number") return false;
  if ((s as { nullable?: boolean }).nullable === true) return false;
  return true;
}

function pushExpectedVersionContract(
  out: Diagnostic[],
  p: ProcedureManifest,
  inputProps: Record<string, JsonSchema>,
  inputRequired: ReadonlySet<string>,
  filePaths: ManifestFilePaths | undefined,
  opts: { readonly opLabel: string; readonly required: boolean },
): void {
  const declared = EXPECTED_VERSION_PROPERTY in inputProps && inputProps[EXPECTED_VERSION_PROPERTY] !== undefined;
  if (!declared) {
    out.push(
      validateDiagnostic({
        code: "BUILTIN_HANDLER_CONTRACT_INVALID",
        severity: "error",
        path: manifestPath("Procedure", p.metadata.name, `/spec/input/properties/${EXPECTED_VERSION_PROPERTY}`, filePaths),
        expected: `property '${EXPECTED_VERSION_PROPERTY}' with type 'number'`,
        message: `Procedure '${p.metadata.name}' (builtin op: ${opts.opLabel}) requires input property '${EXPECTED_VERSION_PROPERTY}' with type 'number' (observed native entry.version at read time, not version+1).`,
      }),
    );
  } else if (!isStrictTypeNumber(inputProps[EXPECTED_VERSION_PROPERTY])) {
    out.push(
      validateDiagnostic({
        code: "BUILTIN_HANDLER_CONTRACT_INVALID",
        severity: "error",
        path: manifestPath("Procedure", p.metadata.name, `/spec/input/properties/${EXPECTED_VERSION_PROPERTY}`, filePaths),
        value: inputProps[EXPECTED_VERSION_PROPERTY]?.type,
        expected: "type: 'number'",
        message: `Procedure '${p.metadata.name}' (builtin op: ${opts.opLabel}) property '${EXPECTED_VERSION_PROPERTY}' must be strict type 'number'.`,
      }),
    );
  }
  if (opts.required && !inputRequired.has(EXPECTED_VERSION_PROPERTY)) {
    out.push(
      validateDiagnostic({
        code: "BUILTIN_HANDLER_CONTRACT_INVALID",
        severity: "error",
        path: manifestPath("Procedure", p.metadata.name, "/spec/input/required", filePaths),
        expected: `required to include '${EXPECTED_VERSION_PROPERTY}'`,
        message: `Procedure '${p.metadata.name}' (builtin op: ${opts.opLabel}) requires '${EXPECTED_VERSION_PROPERTY}' in input.required.`,
      }),
    );
  }
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
  // One description warning per Procedure, not per surface it is exposed on.
  const undescribedMcpProcedures = new Set<string>();

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

    if (t.spec.source.kind === "mcp") {
      // An MCP tool is described to a cold agent by `spec.description`.
      // The catalog falls back to "Invoke Procedure '<name>'." when it is
      // absent, which reads like a description and hides the gap; the
      // authoring gate is the one place that can still see it (#970).
      const target = proceduresByName.get(procName);
      if (target && !undescribedMcpProcedures.has(procName)
        && !resolveLocalizedText(target.spec.description, "en")?.trim()) {
        undescribedMcpProcedures.add(procName);
        out.push(
          validateDiagnostic({
            code: "MCP_TOOL_DESCRIPTION_MISSING",
            severity: "warning",
            path: manifestPath("Procedure", procName, "/spec/description", filePaths),
            value: null,
            expected: "a description an agent can choose the tool by",
            message:
              `Procedure '${procName}' is exposed as an MCP tool on the ${t.spec.source.surface} ` +
              `surface by Trigger '${t.metadata.name}' but has no spec.description; ` +
              `tools/list will show a generated placeholder.`,
          }),
        );
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
  triggers: readonly TriggerManifest[],
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
  const mcpTriggers = new Map<string, string>();
  for (const trigger of triggers) {
    const source = trigger.spec.source;
    if (source.kind !== "mcp") continue;
    const tool = mcpToolNameSegment(trigger.spec.target.procedure);
    const key = `${source.surface}\0${tool}`;
    const prior = mcpTriggers.get(key);
    if (prior) {
      out.push(validateDiagnostic({
        code: "MCP_TOOL_NAME_COLLISION",
        severity: "error",
        path: manifestPath("Trigger", trigger.metadata.name, "/spec/source", filePaths),
        value: tool,
        expected: `one MCP Trigger per surface and tool name (already bound by '${prior}')`,
        message: `Trigger '${trigger.metadata.name}' and Trigger '${prior}' both bind '${tool}' on the ${source.surface} MCP surface; invocation would lose Trigger identity.`,
      }));
    } else {
      mcpTriggers.set(key, trigger.metadata.name);
    }
  }
  return out;
}

/**
 * An MCP write tool that requires `expectedVersion` is only callable when some
 * View on the same surface lets the agent read that collection's `version`.
 * Otherwise the tool is listed, compiles and is dead on arrival (#973).
 * Warning only: the value can still arrive from outside MCP.
 */
function checkMcpExpectedVersionReachability(
  views: readonly ViewManifest[],
  proceduresByName: ReadonlyMap<string, ProcedureManifest>,
  triggers: readonly TriggerManifest[],
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const warned = new Set<string>();
  for (const trigger of triggers) {
    const source = trigger.spec.source;
    if (source.kind !== "mcp") continue;
    const procedure = proceduresByName.get(trigger.spec.target.procedure);
    if (!procedure) continue;
    const input = procedure.spec.input;
    if (!input.required?.includes(EXPECTED_VERSION_PROPERTY)) continue;
    const collection = lockedCollection(procedure);
    if (!collection) continue;
    const key = `${source.surface}\0${procedure.metadata.name}`;
    if (warned.has(key)) continue;
    if (views.some((view) => view.spec.surface === source.surface && viewExposesVersion(view, collection))) continue;
    warned.add(key);
    const tool = mcpToolNameSegment(procedure.metadata.name);
    out.push(validateDiagnostic({
      code: "MCP_TOOL_INPUT_UNREACHABLE",
      severity: "warning",
      path: manifestPath("Procedure", procedure.metadata.name, `/spec/input/properties/${EXPECTED_VERSION_PROPERTY}`, filePaths),
      value: collection,
      expected: `a '${source.surface}' View over '${collection}' that exposes 'version'`,
      message:
        `MCP tool '${tool}' on the ${source.surface} surface requires '${EXPECTED_VERSION_PROPERTY}' of ` +
        `'${collection}'${procedure.spec.handler.kind === "ref" ? " (inferred from its x-mantle-ref input)" : ""}, ` +
        `but no ${source.surface} View reads that collection's 'version'; an agent cannot obtain the value it must send.`,
    }));
  }
  return out;
}

/** The collection whose `version` an OCC write locks, or null when it cannot be told statically. */
function lockedCollection(procedure: ProcedureManifest): string | null {
  const handler = procedure.spec.handler;
  if (handler.kind === "builtin") return handler.schema;
  const input = procedure.spec.input;
  const refs = (input.required ?? []).flatMap((name) => {
    const property = input.properties?.[name];
    const ref = property?.[MANTLE_REF_KEYWORD];
    return typeof ref === "string" ? [ref] : [];
  });
  return refs.length === 1 ? refs[0]! : null;
}

function viewExposesVersion(view: ViewManifest, collection: string): boolean {
  if (view.spec.sql) {
    // SQL Views declare no output columns. The column is spelled
    // `_mantle_version` in SQL and any alias may carry the word, so a plain
    // case-insensitive substring (or a `SELECT *`) counts as exposing. This
    // can only silence the warning, never invent one; the collection is not
    // matched because CTEs, quoting and aliases hide the table name.
    return /version/iu.test(view.spec.sql) || /select\s+(?:\w+\.)?\*/iu.test(view.spec.sql);
  }
  if (view.spec.from !== collection) return false;
  return !view.spec.fields || view.spec.fields.includes("version");
}

function sameOwner(
  prior: ToolNameOwner,
  kind: ToolNameOwner["kind"],
  name: string,
): boolean {
  return prior.kind === kind && prior.name === name;
}
