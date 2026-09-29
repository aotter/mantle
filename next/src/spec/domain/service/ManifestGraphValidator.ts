import {
  validateDiagnostic,
  type Diagnostic,
} from "../../kernel/diagnostic.js";
import {
  MANTLE_REF_KEYWORD,
  RESERVED_PROCEDURE_INPUT_NAMES,
  resolveMantleRef,
  resolveLocalizedText,
  type JsonSchema,
  type Manifest,
  type ProcedureManifest,
  type SchemaManifest,
  type TriggerManifest,
  type ViewManifest,
} from "../model/ManifestGrammar.js";
import { partitionManifests } from "./ManifestPartition.js";
import { jsonSchemaToZod } from "./JsonSchemaToZod.js";
import { checkTranslatesReferences } from "./CrossSchemaChecker.js";
import { checkSchemaNavTargets } from "./SchemaAdminUiChecker.js";
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
    partitioned.schemas,
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

/** `Procedure.spec.target` names what the handler mutates and locks. */
function checkProcedureTarget(
  procedure: ProcedureManifest,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const target = procedure.spec.target;
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
  // Schema, column and input references are checked where the SQL is parsed (compilePlan).
  // A shared cache is the one rule that needs the referenced Schemas, and it reads the
  // statement's table names the same way the old native SQL check did.
  if (!v.spec.cache) return [];
  return [...schemasByName.values()]
    .filter((schema) =>
      referencesTable(v.spec.sql, schema.metadata.name)
      && (schema.spec.ttl || (schema.spec.lifecycle ?? "publishing") !== "publishing"))
    .map((schema) => validateDiagnostic({
      code: "VIEW_CACHE_INVALID",
      severity: "error",
      path: manifestPath("View", v.metadata.name, "/spec/cache", filePaths),
      value: schema.metadata.name,
      expected: "no shared cache over a TTL or operational Schema",
      message: `View '${v.metadata.name}' cannot cache ${schema.spec.ttl ? "TTL" : "operational"} Schema '${schema.metadata.name}'.`,
    }));
}

function checkSqlHandler(
  p: ProcedureManifest,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  // Declared annotations must not contradict what a `sql` handler proves (#972): it always writes,
  // and a DELETE destroys. A false hint would tell a client to skip the confirmation the MCP spec
  // defaults to. What the statements do is otherwise checked by compilePlan; a `DELETE FROM` inside
  // a string literal over-rejects, which is the safe direction.
  const h = p.spec.handler;
  if (!("sql" in h)) return [];
  const hint = (key: "readOnlyHint" | "destructiveHint", value: boolean, message: string) =>
    p.spec.mcp?.[key] === value
      ? [validateDiagnostic({
          code: "INVALID_MANIFEST_ENVELOPE",
          severity: "error",
          path: manifestPath("Procedure", p.metadata.name, `/spec/mcp/${key}`, filePaths),
          value,
          expected: `no ${key}, or ${key}: ${!value}, on this sql handler`,
          message: `Procedure '${p.metadata.name}' declares mcp.${key}: ${value} but its sql handler ${message}.`,
        })]
      : [];
  return [
    ...hint("readOnlyHint", true, "writes"),
    ...(/\bdelete\s+from\b/i.test(h.sql) ? hint("destructiveHint", false, "deletes") : []),
  ];
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
          message: `${target.kind} '${target.metadata.name}' uses '${guardName}' as a guard, but guard Procedures must use a ref handler.`,
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

function sameOwner(
  prior: ToolNameOwner,
  kind: ToolNameOwner["kind"],
  name: string,
): boolean {
  return prior.kind === kind && prior.name === name;
}
