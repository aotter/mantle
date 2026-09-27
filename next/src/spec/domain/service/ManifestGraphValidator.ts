import {
  validateDiagnostic,
  type Diagnostic,
} from "../../kernel/diagnostic.js";
import {
  RESERVED_ENTRY_COLUMNS,
  EXPECTED_VERSION_PROPERTY,
  MANTLE_REF_KEYWORD,
  RESERVED_PROCEDURE_INPUT_NAMES,
  resolveMantleRef,
  resolveLocalizedText,
  type JsonSchema,
  type LifecycleHook,
  type Manifest,
  type ProcedureManifest,
  type SchemaManifest,
  type StoreProgramOp,
  type StoreWhereSpec,
  type TriggerManifest,
  type ViewManifest,
} from "../model/ManifestGrammar.js";
import { isPublishing } from "./LifecycleStateMachine.js";
import { inputReference, isRowOp, isStoreProgram, pinnedId, procedureTarget, storeOpSchema, storeOpVerb } from "./StoreProgram.js";
import { partitionManifests } from "./ManifestPartition.js";
import { jsonSchemaToZod } from "./JsonSchemaToZod.js";
import { checkTranslatesReferences } from "./CrossSchemaChecker.js";
import { checkSchemaNavTargets, checkViewAdminUi } from "./SchemaAdminUiChecker.js";
import { checkSchemaIndexes } from "./SchemaIndexChecker.js";
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

  for (const s of partitioned.schemas) {
    diags.push(...checkMantleRefs("Schema", s.metadata.name, "/spec/schema", s.spec.schema, schemasByName, filePaths));
  }
  const hooks = lifecycleHooksBySchema(partitioned.triggers);
  for (const p of partitioned.procedures) {
    diags.push(...checkStoreProgram(p, schemasByName, hooks, filePaths));
    diags.push(...checkCollectionActionRef(p, schemasByName, filePaths));
    diags.push(...checkMantleRefs("Procedure", p.metadata.name, "/spec/input", p.spec.input, schemasByName, filePaths));
    diags.push(...checkProcedureTarget(p, schemasByName, filePaths));
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

/**
 * `x-mantle-ref` on top-level properties. The string form is unchanged; the
 * object form must name an existing Schema and a field that identifies one
 * entry: `id` or a single-field unique index (ADR-0029).
 */
function checkMantleRefs(
  kind: "Schema" | "Procedure",
  name: string,
  pointer: string,
  schema: JsonSchema,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    const raw = property?.[MANTLE_REF_KEYWORD];
    if (raw === undefined || typeof raw === "string") continue;
    const path = manifestPath(kind, name, `${pointer}/properties/${pointerSegment(field)}/${MANTLE_REF_KEYWORD}`, filePaths);
    const ref = resolveMantleRef(property);
    const keys = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? Object.keys(raw) : [];
    if (!ref || keys.some((key) => key !== "schema" && key !== "field")) {
      out.push(validateDiagnostic({
        code: "MANTLE_REF_INVALID",
        severity: "error",
        path,
        value: raw,
        expected: "a Schema name, or { schema: <Schema name>, field: <id or single-field unique index> }",
        message: `${kind} '${name}' field '${field}' has a malformed x-mantle-ref.`,
      }));
      continue;
    }
    const target = schemasByName.get(ref.schema);
    if (!target) {
      out.push(validateDiagnostic({
        code: "MANTLE_REF_INVALID",
        severity: "error",
        path: `${path}/schema`,
        value: ref.schema,
        expected: "the metadata.name of an existing Schema",
        candidates: [...schemasByName.keys()],
        suggestion: bestMatch(ref.schema, [...schemasByName.keys()]),
        message: `${kind} '${name}' field '${field}' references unknown Schema '${ref.schema}'.`,
      }));
      continue;
    }
    const keyFields = entryKeyFields(target);
    if (!keyFields.includes(ref.field)) {
      out.push(validateDiagnostic({
        code: "MANTLE_REF_INVALID",
        severity: "error",
        path: `${path}/field`,
        value: ref.field,
        expected: `one of ${keyFields.join(", ")}`,
        candidates: keyFields,
        message: `${kind} '${name}' field '${field}' references '${ref.schema}.${ref.field}', which does not identify one entry; use id or a single-field unique index.`,
      }));
    }
  }
  return out;
}

/** Fields whose value identifies exactly one entry of a Schema. */
function entryKeyFields(schema: SchemaManifest): string[] {
  const unique = checkSchemaIndexes(schema).declarations
    .filter((declaration) => declaration.unique && declaration.fields.length === 1)
    .map((declaration) => declaration.fields[0]!.name);
  return ["id", ...new Set(unique)];
}

/**
 * `Procedure.spec.target` names what the Procedure mutates. An inline
 * program infers it (`procedureTarget`) unless one is declared.
 */
function checkProcedureTarget(
  procedure: ProcedureManifest,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const target = procedureTarget(procedure);
  if (!target) return [];
  const name = procedure.metadata.name;
  const fail = (pointer: string, value: unknown, expected: string, message: string, candidates?: readonly string[]) =>
    [validateDiagnostic({
      code: "PROCEDURE_TARGET_INVALID",
      severity: "error",
      path: manifestPath("Procedure", name, `/spec/target${pointer}`, filePaths),
      value,
      expected,
      ...(candidates ? { candidates } : {}),
      message,
    })];
  if (!schemasByName.has(target.schema)) {
    return fail("/schema", target.schema, "the metadata.name of an existing Schema", `Procedure '${name}' target references unknown Schema '${target.schema}'.`, [...schemasByName.keys()]);
  }
  const input = procedure.spec.input;
  const properties = input.properties ?? {};
  const required = new Set(input.required ?? []);
  if (!required.has(target.id) || !hasType(properties[target.id], ["string"])) {
    return fail("/id", target.id, "a required string input property", `Procedure '${name}' target.id '${target.id}' must be a required string property of spec.input.`, Object.keys(properties));
  }
  if (target.version !== undefined && !hasType(properties[target.version], ["number", "integer"])) {
    return fail("/version", target.version, "a number input property", `Procedure '${name}' target.version '${target.version}' must be a number property of spec.input.`, Object.keys(properties));
  }
  return [];
}

function hasType(schema: JsonSchema | undefined, types: readonly string[]): boolean {
  const declared = schema?.type;
  const list = Array.isArray(declared) ? declared : declared === undefined ? [] : [declared];
  return list.length > 0 && list.every((type) => types.includes(type) || type === "null") && list.some((type) => types.includes(type));
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
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

/**
 * Whether native SQL names a Schema's table (bare, `"quoted"`, `` `quoted` ``
 * or `[bracketed]`). Mantle tables are named after their Schema, so every
 * read of a TTL table spells its name. A match inside a literal or comment
 * over-rejects, which is the safe direction.
 */
function referencesTable(sql: string, table: string): boolean {
  const name = table.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${name}(?![\\p{L}\\p{N}_$])`, "iu").test(sql);
}

function checkViewRefs(
  v: ViewManifest,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  if (v.spec.sql) {
    const sql = v.spec.sql;
    const out: Diagnostic[] = [];
    const reads = [...schemasByName.values()].filter((schema) => referencesTable(sql, schema.metadata.name));
    const expiring = reads.filter((schema) => schema.spec.ttl).map((schema) => schema.metadata.name);
    if (expiring.length > 0) out.push(validateDiagnostic({
      code: "VIEW_TTL_NATIVE_UNSAFE", severity: "error",
      path: manifestPath("View", v.metadata.name, "/spec/sql", filePaths),
      value: expiring,
      message: `Native SQL View '${v.metadata.name}' reads TTL Schema ${expiring.map((name) => `'${name}'`).join(", ")} and cannot guarantee logical TTL filtering.`,
      expected: "a select View over a TTL Schema, or SQL that does not read one",
    }));
    const scoped = reads.filter((schema) => schema.spec.scope).map((schema) => schema.metadata.name);
    if (scoped.length > 0) out.push(validateDiagnostic({
      code: "VIEW_SQL_SCOPED_SCHEMA", severity: "error",
      path: manifestPath("View", v.metadata.name, "/spec/sql", filePaths),
      value: scoped,
      message: `Native SQL View '${v.metadata.name}' reads scoped Schema ${scoped.map((name) => `'${name}'`).join(", ")}; native SQL cannot carry the caller scope. Use a select View.`,
      expected: "a select View over a scoped Schema",
    }));
    return out;
  }
  const out: Diagnostic[] = [];
  const select = v.spec.select;
  if (!select) return out;
  const fromName = select.from;
  const schema = schemasByName.get(fromName);
  if (!schema) {
    out.push(validateDiagnostic({
      code: "VIEW_FROM_UNKNOWN_SCHEMA",
      severity: "error",
      path: manifestPath("View", v.metadata.name, "/spec/select/from", filePaths),
      value: fromName,
      expected: "name of a declared Schema",
      candidates: [...schemasByName.keys()],
      suggestion: bestMatch(fromName, [...schemasByName.keys()]),
      message: `View '${v.metadata.name}' references unknown Schema '${fromName}'.`,
    }));
    return out;
  }
  if (v.spec.cache && !isPublishing(schema)) {
    out.push(validateDiagnostic({
      code: "VIEW_CACHE_INVALID", severity: "error",
      path: manifestPath("View", v.metadata.name, "/spec/cache", filePaths),
      value: fromName,
      expected: "a View over a publishing Schema",
      message: `View '${v.metadata.name}' cannot cache operational Schema '${fromName}'.`,
    }));
  }
  if (v.spec.cache && schema.spec.ttl) {
    out.push(validateDiagnostic({
      code: "VIEW_CACHE_INVALID", severity: "error",
      path: manifestPath("View", v.metadata.name, "/spec/cache", filePaths),
      value: fromName,
      expected: "no shared cache for a View over a TTL Schema",
      message: `View '${v.metadata.name}' cannot cache TTL Schema '${fromName}' past its expiry boundary.`,
    }));
  }
  const status = select.where?.["status"];
  if (v.spec.surface === "public" && isPublishing(schema) && status !== undefined && status !== "published"
    && !(status && typeof status === "object" && (status as Record<string, unknown>)["eq"] === "published" && Object.keys(status).length === 1)) {
    // The runtime reads published rows only on this View (#1007); any other
    // status comparison can only contradict it and return nothing.
    out.push(validateDiagnostic({
      code: "VIEW_PUBLIC_STATUS_INVALID", severity: "error",
      path: manifestPath("View", v.metadata.name, "/spec/select/where/status", filePaths),
      value: status,
      expected: "status: published, or no status comparison",
      message: `View '${v.metadata.name}' is public over publishing Schema '${fromName}'; it always reads published rows only, so its status comparison must be 'published' or omitted.`,
    }));
  }

  const validFieldNames = columnsOf(schema);
  const list = checkViewAdminUi(v).list;
  for (const [key, fields] of Object.entries(list) as Array<[keyof typeof list, readonly string[]]>) {
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

  const cursorFields = ["id", Object.keys(select.orderBy ?? {})[0] ?? "updatedAt"];
  if (v.spec.surface === "public" && select.columns && cursorFields.some((field) => !select.columns!.includes(field))) {
    out.push(validateDiagnostic({
      code: "VIEW_ORDERBY_INVALID", severity: "error",
      path: manifestPath("View", v.metadata.name, "/spec/select/columns", filePaths),
      expected: `public View projection includes ${[...new Set(cursorFields)].join(" and ")} used by its pagination cursor`,
      message: `Public View '${v.metadata.name}' must project its cursor fields.`,
    }));
  }
  if (v.spec.cache && usesReference(select.where, "$now")) out.push(validateDiagnostic({
    code: "VIEW_CACHE_INVALID", severity: "error",
    path: manifestPath("View", v.metadata.name, "/spec/cache", filePaths),
    expected: "a caller and time independent View",
    message: `View '${v.metadata.name}' uses $now and cannot have a shared cache.`,
  }));
  for (const [i, field] of (select.columns ?? []).entries()) {
    if (!validFieldNames.has(field)) out.push(validateDiagnostic({
      code: "VIEW_FIELD_NOT_IN_SCHEMA", severity: "error",
      path: manifestPath("View", v.metadata.name, `/spec/select/columns/${i}`, filePaths),
      value: field, expected: `property of Schema '${fromName}' or a reserved metadata field`,
      message: `View '${v.metadata.name}' select references unknown field '${field}'.`,
    }));
  }
  for (const field of Object.keys(select.orderBy ?? {})) {
    if (!validFieldNames.has(field)) {
      out.push(validateDiagnostic({
        code: "VIEW_FIELD_NOT_IN_SCHEMA", severity: "error",
        path: manifestPath("View", v.metadata.name, `/spec/select/orderBy/${field}`, filePaths),
        value: field, expected: `property of Schema '${fromName}' or a reserved metadata field`,
        message: `View '${v.metadata.name}' orderBy references unknown field '${field}'.`,
      }));
    } else if (!RESERVED_ENTRY_COLUMNS.includes(field as never) && !isScalarProperty(schema.spec.schema.properties?.[field])) {
      out.push(validateDiagnostic({
        code: "VIEW_FIELD_NOT_IN_SCHEMA", severity: "error",
        path: manifestPath("View", v.metadata.name, `/spec/select/orderBy/${field}`, filePaths),
        value: field, expected: "a scalar Schema column",
        message: `View '${v.metadata.name}' orderBy requires a scalar field.`,
      }));
    }
  }
  const scan = scanStoreWhere("View", v.metadata.name, schemasByName, filePaths, out);
  const touched = select.where ? scan(select.where, schema, "/spec/select/where") : [];
  if (v.spec.cache && touched.some((other) => other.spec.ttl)) out.push(validateDiagnostic({
    code: "VIEW_CACHE_INVALID", severity: "error",
    path: manifestPath("View", v.metadata.name, "/spec/cache", filePaths),
    expected: "no shared cache over a TTL Schema",
    message: `View '${v.metadata.name}' cannot cache a subquery over a TTL Schema.`,
  }));
  const requiresCaller = Boolean(schema.spec.scope) || touched.some((other) => other.spec.scope) || usesReference(select.where, "$ctx.user.id");
  if (requiresCaller && !v.spec.requires?.auth?.all?.includes("ctx.user")) out.push(validateDiagnostic({
    code: "STORE_CALLER_REQUIRED", severity: "error",
    path: manifestPath("View", v.metadata.name, "/spec/requires/auth/all", filePaths),
    expected: "ctx.user",
    message: `View '${v.metadata.name}' reads a scoped Schema or $ctx.user.id, so it must require ctx.user.`,
  }));
  return out;
}

function columnsOf(schema: SchemaManifest): Set<string> {
  return new Set([...RESERVED_ENTRY_COLUMNS, ...Object.keys(schema.spec.schema.properties ?? {})]);
}

function isScalarProperty(property: JsonSchema | undefined): boolean {
  const types = [property?.type].flat().filter((type) => type !== "null");
  return Boolean(property) && !property?.oneOf && types.length === 1 && ["string", "number", "integer", "boolean"].includes(String(types[0]));
}

function usesReference(value: unknown, reference: string): boolean {
  if (value === reference) return true;
  if (Array.isArray(value)) return value.some((item) => usesReference(item, reference));
  return Boolean(value) && typeof value === "object" && !("$literal" in (value as object))
    && Object.values(value as object).some((item) => usesReference(item, reference));
}

/**
 * Check a Store `where` against the Schemas it names (columns, subquery
 * Schemas and their columns). Returns the Schemas its subqueries read.
 */
function scanStoreWhere(
  atom: "View" | "Procedure",
  name: string,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  filePaths: ManifestFilePaths | undefined,
  out: Diagnostic[],
): (where: StoreWhereSpec, source: SchemaManifest, pointer: string) => SchemaManifest[] {
  const unknownCode = atom === "View" ? "VIEW_FIELD_NOT_IN_SCHEMA" : "STORE_PROGRAM_INVALID";
  const schemaCode = atom === "View" ? "VIEW_FROM_UNKNOWN_SCHEMA" : "STORE_PROGRAM_SCHEMA_UNKNOWN";
  const scan = (where: StoreWhereSpec, source: SchemaManifest, pointer: string): SchemaManifest[] => {
    const touched: SchemaManifest[] = [];
    const fields = columnsOf(source);
    for (const [field, value] of Object.entries(where)) {
      const at = `${pointer}/${field}`;
      if (field === "and" || field === "or") {
        for (const [index, child] of (value as readonly StoreWhereSpec[]).entries()) touched.push(...scan(child, source, `${at}/${index}`));
        continue;
      }
      if (field === "not") {
        touched.push(...scan(value as StoreWhereSpec, source, at));
        continue;
      }
      if (!fields.has(field)) out.push(validateDiagnostic({
        code: unknownCode, severity: "error",
        path: manifestPath(atom, name, at, filePaths), value: field,
        expected: `property of Schema '${source.metadata.name}' or a reserved metadata field`,
        message: `${atom} '${name}' where references unknown field '${field}' on Schema '${source.metadata.name}'.`,
      }));
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const [operator, operand] of Object.entries(value)) {
        if ((operator !== "in" && operator !== "notIn") || !operand || typeof operand !== "object" || Array.isArray(operand)) continue;
        const sub = operand as { from: string; select: string; where?: StoreWhereSpec };
        const other = schemasByName.get(sub.from);
        if (!other) {
          out.push(validateDiagnostic({
            code: schemaCode, severity: "error",
            path: manifestPath(atom, name, `${at}/${operator}/from`, filePaths), value: sub.from,
            expected: "name of a declared Schema",
            message: `${atom} '${name}' subquery references unknown Schema '${sub.from}'.`,
          }));
          continue;
        }
        touched.push(other);
        if (!columnsOf(other).has(sub.select)) out.push(validateDiagnostic({
          code: unknownCode, severity: "error",
          path: manifestPath(atom, name, `${at}/${operator}/select`, filePaths), value: sub.select,
          expected: `property of Schema '${sub.from}' or a reserved metadata field`,
          message: `${atom} '${name}' subquery references unknown field '${sub.select}'.`,
        }));
        if (sub.where) touched.push(...scan(sub.where, other, `${at}/${operator}/where`));
      }
    }
    return touched;
  };
  return scan;
}

/** Per-row lifecycle hooks declared for each Schema, from its lifecycle Triggers. */
function lifecycleHooksBySchema(triggers: readonly TriggerManifest[]): ReadonlyMap<string, ReadonlySet<LifecycleHook>> {
  const hooks = new Map<string, Set<LifecycleHook>>();
  for (const trigger of triggers) {
    const source = trigger.spec.source;
    if (source.kind !== "lifecycle") continue;
    const set = hooks.get(source.schema) ?? new Set<LifecycleHook>();
    for (const hook of source.on) set.add(hook);
    hooks.set(source.schema, set);
  }
  return hooks;
}

/**
 * Inline Store program rules (ADR-0032 decisions 1–3). The parser already
 * checked shapes and value references; this checks them against Schemas,
 * indexes, hooks and the Procedure's own declarations.
 */
function checkStoreProgram(
  p: ProcedureManifest,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  hooks: ReadonlyMap<string, ReadonlySet<LifecycleHook>>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const handler = p.spec.handler;
  if (!isStoreProgram(handler)) return [];
  const out: Diagnostic[] = [];
  const name = p.metadata.name;
  const fail = (code: Diagnostic["code"], pointer: string, message: string, extra: Partial<Pick<Diagnostic, "value" | "expected" | "candidates">> = {}) =>
    out.push(validateDiagnostic({ code, severity: "error", path: manifestPath("Procedure", name, pointer, filePaths), message, ...extra }));
  if (p.spec.mcp?.readOnlyHint === true) {
    fail("STORE_PROGRAM_INVALID", "/spec/mcp/readOnlyHint", `Procedure '${name}' declares mcp.readOnlyHint: true but its Store program writes.`, { value: true });
  }
  if (p.spec.mcp?.destructiveHint === false && handler.store.some((op) => "delete" in op)) {
    fail("STORE_PROGRAM_INVALID", "/spec/mcp/destructiveHint", `Procedure '${name}' declares mcp.destructiveHint: false but its Store program deletes.`, { value: false });
  }
  const output = p.spec.output;
  const results = output.properties?.["results"];
  if (output.type !== "object" || (output.properties && !hasType(results, ["array"])) || (output.required ?? []).some((key) => key !== "results")) {
    fail("STORE_PROGRAM_OUTPUT_INVALID", "/spec/output", `Procedure '${name}' runs a Store program, whose output is { results }; its output schema must accept that object.`, {
      expected: "type: object, with at most a `results` array property",
    });
  }
  const input = p.spec.input;
  const inputProps = input.properties ?? {};
  const wholeInput = Object.keys(inputProps).filter((key) => key !== "id" && !RESERVED_PROCEDURE_INPUT_NAMES.includes(key as never));
  let requiresCaller = usesReference(handler.store, "$ctx.user.id");
  const scan = scanStoreWhere("Procedure", name, schemasByName, filePaths, out);
  handler.store.forEach((op: StoreProgramOp, index) => {
    const at = `/spec/handler/store/${index}`;
    const verb = storeOpVerb(op);
    const schemaName = storeOpSchema(op);
    const schema = schemasByName.get(schemaName);
    if (!schema) {
      fail("STORE_PROGRAM_SCHEMA_UNKNOWN", `${at}/${verb}`, `Procedure '${name}' writes unknown Schema '${schemaName}'.`, {
        value: schemaName, expected: "name of a declared Schema", candidates: [...schemasByName.keys()],
      });
      return;
    }
    if (schema.spec.scope) requiresCaller = true;
    const properties = Object.keys(schema.spec.schema.properties ?? {});
    const fieldsKey = "insert" in op ? "values" : "update" in op ? "set" : undefined;
    const fields = "insert" in op ? op.values : "update" in op ? op.set : undefined;
    const written = fields === "$input" ? wholeInput : Object.keys(fields ?? {}).filter((key) => key !== "status");
    for (const column of written) {
      if (!properties.includes(column)) {
        fail("STORE_PROGRAM_INVALID", fields === "$input" ? `/spec/input/properties/${pointerSegment(column)}` : `${at}/${fieldsKey}/${pointerSegment(column)}`,
          `Procedure '${name}' writes '${column}', which Schema '${schemaName}' does not declare.`, { value: column, candidates: properties });
      }
    }
    if ("insert" in op && op.onConflict && op.onConflict !== "ignore") {
      const { columns, update } = op.onConflict;
      if (!(schema.spec.uniqueIndexes ?? []).some((declared) => declared.length === columns.length && declared.every((column, i) => column === columns[i]))) {
        fail("STORE_PROGRAM_INVALID", `${at}/onConflict/columns`, `Procedure '${name}' onConflict.columns [${columns.join(", ")}] is not a declared unique index of Schema '${schemaName}'.`, { value: columns });
      }
      for (const column of update) {
        if (!properties.includes(column)) fail("STORE_PROGRAM_INVALID", `${at}/onConflict/update`, `Procedure '${name}' onConflict updates '${column}', which Schema '${schemaName}' does not declare.`, { value: column });
      }
    }
    if ("insert" in op) return;
    for (const other of scan(op.where, schema, `${at}/where`)) if (other.spec.scope) requiresCaller = true;
    const status = "update" in op && typeof op.set === "object" ? op.set["status"] : undefined;
    if (!isRowOp(op)) {
      if (op.lock !== undefined) fail("STORE_PROGRAM_INVALID", `${at}/lock`, `Procedure '${name}' locks a set op; lock needs a where that pins id.`);
      const hooked = [...(hooks.get(schemaName) ?? [])].filter((hook) => hook.endsWith(`_${verb}`) || (status === "published" && hook.endsWith("_publish")));
      if (hooked.length > 0 || isPublishing(schema) || status !== undefined) {
        fail("STORE_SET_OP_REJECTED", `${at}/where`, hooked.length > 0
          ? `Procedure '${name}' runs a set-based ${verb} on Schema '${schemaName}', which has per-row ${hooked.join(", ")} hooks; pin id so hooks fire per row.`
          : `Procedure '${name}' runs a set-based ${verb} on publishing Schema '${schemaName}'; lifecycle rules apply per row, so pin id.`,
          { value: op.where, expected: "a where that pins id, or a set op on an operational Schema without per-row hooks" });
      }
    }
    if (status !== undefined && !isPublishing(schema)) {
      fail("STORE_PROGRAM_INVALID", `${at}/set/status`, `Procedure '${name}' sets status on operational Schema '${schemaName}', which has no lifecycle transitions.`, { value: status });
    }
    const lock = inputReference(op.lock);
    if (lock && !hasType(inputProps[lock], ["number", "integer"])) {
      fail("STORE_PROGRAM_INVALID", `${at}/lock`, `Procedure '${name}' lock '$input.${lock}' must name a number input property.`, { value: op.lock });
    }
    const id = inputReference(pinnedId(op.where));
    if (id && !hasType(inputProps[id], ["string"])) {
      fail("STORE_PROGRAM_INVALID", `${at}/where/id`, `Procedure '${name}' pins id to '$input.${id}', which must be a string input property.`, { value: id });
    }
  });
  if (requiresCaller && !p.spec.requires?.auth?.all?.includes("ctx.user")) {
    fail("STORE_CALLER_REQUIRED", "/spec/requires/auth/all", `Procedure '${name}' writes a scoped Schema or uses $ctx.user.id, so it must require ctx.user.`, { expected: "ctx.user" });
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
    if (!("ref" in guard.spec.handler)) {
      out.push(
        validateDiagnostic({
          code: "GUARD_PROCEDURE_NOT_REF",
          severity: "error",
          path,
          value: guardName,
          expected: "a Procedure with a ref handler",
          message: `${target.kind} '${target.metadata.name}' uses '${guardName}' as a guard, but a guard is a read-only check and cannot run a Store program.`,
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

    if (t.spec.source.kind === "schedule") {
      const target = proceduresByName.get(procName);
      if (target && (target.spec.requires?.auth?.all.length ?? 0) > 0) {
        out.push(validateDiagnostic({
          code: "SCHEDULE_AUTH_INVALID",
          severity: "error",
          path: manifestPath("Trigger", t.metadata.name, "/spec/target/procedure", filePaths),
          value: procName,
          expected: "a Procedure without user or staff authorization requirements",
          message: `Scheduled Trigger '${t.metadata.name}' cannot satisfy '${procName}' authorization with a system caller.`,
        }));
      }
      if (target && !jsonSchemaToZod(target.spec.input).safeParse({}).success) {
        out.push(validateDiagnostic({
          code: "SCHEDULE_INPUT_INVALID",
          severity: "error",
          path: manifestPath("Trigger", t.metadata.name, "/spec/target/procedure", filePaths),
          value: procName,
          expected: "a Procedure whose input accepts an empty object",
          message: `Scheduled Trigger '${t.metadata.name}' cannot supply required Procedure input to '${procName}'.`,
        }));
      }
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
    const hookTarget = t.spec.source.kind === "lifecycle" ? proceduresByName.get(procName) : undefined;
    if (hookTarget && !("ref" in hookTarget.spec.handler)) {
      out.push(
        validateDiagnostic({
          code: "LIFECYCLE_TARGET_NOT_REF",
          severity: "error",
          path: manifestPath("Trigger", t.metadata.name, "/spec/target/procedure", filePaths),
          value: procName,
          expected: "a Procedure with a ref handler",
          message: `Trigger '${t.metadata.name}' is a lifecycle hook, so its target '${procName}' must be a ref handler; a before hook is a read-only check and an after hook reacts after the commit.`,
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
    if (view.spec.surface === "internal") continue;
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
        `'${collection}'${!procedureTarget(procedure) ? " (inferred from its x-mantle-ref input)" : ""}, ` +
        `but no ${source.surface} View reads that collection's 'version'; an agent cannot obtain the value it must send.`,
    }));
  }
  return out;
}

/** The collection whose `version` an OCC write locks, or null when it cannot be told statically. */
function lockedCollection(procedure: ProcedureManifest): string | null {
  const target = procedureTarget(procedure);
  if (target) return target.schema;
  const input = procedure.spec.input;
  const refs = (input.required ?? []).flatMap((name) => {
    const ref = resolveMantleRef(input.properties?.[name]);
    return ref ? [ref.schema] : [];
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
  if (view.spec.select?.from !== collection) return false;
  const columns = view.spec.select.columns;
  return !columns || columns.includes("version");
}

function sameOwner(
  prior: ToolNameOwner,
  kind: ToolNameOwner["kind"],
  name: string,
): boolean {
  return prior.kind === kind && prior.name === name;
}
