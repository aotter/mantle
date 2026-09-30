/** Graph checks across Triggers, Procedures and Views: targets, guards, sql handlers, and MCP tool names. */
import { validateDiagnostic, type Diagnostic } from "../../kernel/diagnostic.js";
import { resolveLocalizedText, type ProcedureManifest, type SchemaManifest, type TriggerManifest, type ViewManifest, type JsonSchema } from "../model/ManifestGrammar.js";
import { jsonSchemaToZod } from "./JsonSchemaToZod.js";
import { bestMatch, manifestPath, type ManifestFilePaths } from "./ManifestPathDiagnoser.js";
import { mcpToolNameSegment } from "./McpToolNaming.js";

/** `Procedure.spec.target` names what the handler mutates and locks. */
export function checkProcedureTarget(
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

export function checkViewRefs(
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

export function checkSqlHandler(
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

export function checkGuards(
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

export function checkTriggerRefs(
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

    // a hook target is consumer code: an inline program would write inside a before hook, which fails open (ADR-0032 decision 3)
    const hookTarget = t.spec.source.kind === "lifecycle" ? proceduresByName.get(t.spec.target.procedure) : undefined;
    if (hookTarget && !("ref" in hookTarget.spec.handler)) {
      out.push(
        validateDiagnostic({
          code: "LIFECYCLE_TARGET_NOT_REF",
          severity: "error",
          path: manifestPath("Trigger", t.metadata.name, "/spec/target/procedure", filePaths),
          value: t.spec.target.procedure,
          expected: "a Procedure with a ref handler",
          message: `Lifecycle Trigger '${t.metadata.name}' targets '${t.spec.target.procedure}', whose handler is an inline program; a hook target must use a ref handler.`,
        }),
      );
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

/**
 * MCP tools come only from Views and Procedures (ADR-0032): a View's tool and a Procedure's tool share one namespace, named by the
 * manifest name with kebab folded to snake. Internal Views are never tools.
 */
export function checkMcpToolNameCollisions(
  views: readonly ViewManifest[],
  procedures: readonly ProcedureManifest[],
  triggers: readonly TriggerManifest[],
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const seen = new Map<string, string>();
  const out: Diagnostic[] = [];
  const exposed = new Set(triggers.flatMap((t) => (t.spec.source.kind === "mcp" ? [t.spec.target.procedure] : [])));
  const claim = (kind: "View" | "Procedure", name: string) => {
    const segment = mcpToolNameSegment(name);
    if ((kind === "View" || exposed.has(name)) && (segment.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(segment))) {
      out.push(validateDiagnostic({
        code: "MCP_TOOL_NAME_COLLISION",
        severity: "error",
        path: manifestPath(kind, name, "/metadata/name", filePaths),
        value: segment,
        expected: "an MCP tool name of at most 128 characters from [A-Za-z0-9_.-]",
        message: `${kind} '${name}' cannot be an MCP tool name: it must be at most 128 characters from [A-Za-z0-9_.-].`,
      }));
      return;
    }
    const prior = seen.get(segment);
    if (prior && prior !== `${kind} ${name}`) {
      out.push(validateDiagnostic({
        code: "MCP_TOOL_NAME_COLLISION",
        severity: "error",
        path: manifestPath(kind, name, "/metadata/name", filePaths),
        value: segment,
        expected: `${kind} name unique after kebab→snake mangling (collides with ${prior})`,
        message: `${kind} '${name}' mangles to MCP tool name '${segment}', which already comes from ${prior}.`,
      }));
    } else if (!prior) seen.set(segment, `${kind} ${name}`);
  };
  for (const view of views) if (view.spec.surface !== "internal") claim("View", view.metadata.name);
  for (const procedure of procedures) claim("Procedure", procedure.metadata.name);
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

function hasType(schema: JsonSchema | undefined, types: readonly string[]): boolean {
  const declared = schema?.type;
  const list = Array.isArray(declared) ? declared : declared === undefined ? [] : [declared];
  return list.length > 0 && list.every((type) => types.includes(type) || type === "null") && list.some((type) => types.includes(type));
}
