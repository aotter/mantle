import { validateDiagnostic, type Diagnostic } from "../../kernel/diagnostic.js";
import { MANTLE_REF_KEYWORD, RESERVED_PROCEDURE_INPUT_NAMES, resolveMantleRef, type JsonSchema, type Manifest, type ProcedureManifest, type SchemaManifest, type TriggerManifest, type ViewManifest } from "../model/ManifestGrammar.js";
import { checkTranslatesReferences } from "./CrossSchemaChecker.js";
import { partitionManifests } from "./ManifestPartition.js";
import { bestMatch, manifestPath, type ManifestFilePaths } from "./ManifestPathDiagnoser.js";
import { checkSchemaNavTargets } from "./SchemaAdminUiChecker.js";
import { checkSchemaIndexes } from "./SchemaIndexChecker.js";
import { checkGuards, checkMcpToolNameCollisions, checkProcedureTarget, checkSqlHandler, checkTriggerRefs, checkViewRefs } from "./TriggerGraphChecks.js";

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
  diags.push(...checkCaseCollisions(partitioned.schemas, filePaths));

  diags.push(...checkTranslatesReferences(partitioned.schemas, "validate", filePaths));
  diags.push(...checkSchemaNavTargetsGraph(partitioned.schemas, schemasByName, filePaths));

  for (const v of partitioned.views) {
    diags.push(...checkViewRefs(v, schemasByName, filePaths));
  }

  for (const s of partitioned.schemas) {
    diags.push(...checkMantleRefs("Schema", s.metadata.name, "/spec/schema", s.spec.schema, schemasByName, filePaths));
  }
  for (const p of partitioned.procedures) {
    diags.push(...checkSqlHandler(p, filePaths));
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
    partitioned.views,
    partitioned.procedures,
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

/**
 * SQL resolves identifiers case-insensitively (ADR-0034 decision 2) and the plan keys Schemas and fields by their lower-case
 * name, so two names that differ only by case would silently become one table or one column.
 */
function checkCaseCollisions(schemas: readonly SchemaManifest[], filePaths?: ManifestFilePaths): Diagnostic[] {
  const out: Diagnostic[] = [];
  const collide = (names: readonly string[], report: (name: string, other: string) => void) => {
    const first = new Map<string, string>();
    for (const n of names) {
      const seen = first.get(n.toLowerCase());
      if (seen === undefined) first.set(n.toLowerCase(), n);
      else if (seen !== n) report(n, seen); // an exact repeat is DUPLICATE_NAME
    }
  };
  collide(schemas.map((s) => s.metadata.name), (name, other) => out.push(validateDiagnostic({
    code: "SCHEMA_NAME_CASE_COLLISION", severity: "error", path: manifestPath("Schema", name, "/metadata/name", filePaths), value: name,
    message: `Schema '${name}' and Schema '${other}' differ only by case; SQL names them the same table. Rename one.`,
  })));
  for (const s of schemas)
    collide(Object.keys(s.spec.schema.properties ?? {}), (name, other) => out.push(validateDiagnostic({
      code: "FIELD_NAME_CASE_COLLISION", severity: "error", path: manifestPath("Schema", s.metadata.name, `/spec/schema/properties/${pointerSegment(name)}`, filePaths), value: name,
      message: `Schema '${s.metadata.name}' declares '${name}' and '${other}', which differ only by case; SQL names them the same column. Rename one.`,
    })));
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
