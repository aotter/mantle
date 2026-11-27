/** Graph checks across Triggers, Procedures and Views: targets, sql handlers, and MCP tool names. */
import { validateDiagnostic, type Diagnostic } from "../../kernel/diagnostic.js";
import {
  resolveLocalizedText,
  type ProcedureManifest,
  type SchemaManifest,
  type TriggerManifest,
  type ViewManifest,
  type JsonSchema,
} from "../model/ManifestGrammar.js";
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
  const fail = (pointer: string, value: unknown, expected: string, message: string, candidates?: readonly string[]) => [
    validateDiagnostic({
      code: "PROCEDURE_TARGET_INVALID",
      severity: "error",
      path: manifestPath("Procedure", name, `/spec/target${pointer}`, filePaths),
      value,
      expected,
      ...(candidates ? { candidates } : {}),
      message,
    }),
  ];
  if (!schemasByName.has(target.schema)) {
    return fail(
      "/schema",
      target.schema,
      "the metadata.name of an existing Schema",
      `Procedure '${name}' target references unknown Schema '${target.schema}'.`,
      [...schemasByName.keys()],
    );
  }
  const input = procedure.spec.input;
  const properties = input.properties ?? {};
  const required = new Set(input.required ?? []);
  if (!required.has(target.id) || !hasType(properties[target.id], ["string"])) {
    return fail(
      "/id",
      target.id,
      "a required string input property",
      `Procedure '${name}' target.id '${target.id}' must be a required string property of spec.input.`,
      Object.keys(properties),
    );
  }
  if (target.version !== undefined && !hasType(properties[target.version], ["number", "integer"])) {
    return fail(
      "/version",
      target.version,
      "a number input property",
      `Procedure '${name}' target.version '${target.version}' must be a number property of spec.input.`,
      Object.keys(properties),
    );
  }
  return [];
}

export function checkSqlHandler(p: ProcedureManifest, filePaths?: ManifestFilePaths): Diagnostic[] {
  // Declared annotations must not contradict what a `sql` handler proves (#972): it always writes,
  // and a DELETE destroys. A false hint would tell a client to skip the confirmation the MCP spec
  // defaults to. What the statements do is otherwise checked by compilePlan; a `DELETE FROM` inside
  // a string literal over-rejects, which is the safe direction.
  const h = p.spec.handler;
  if (!("sql" in h)) return [];
  const hint = (key: "readOnlyHint" | "destructiveHint", value: boolean, message: string) =>
    p.spec.mcp?.[key] === value
      ? [
          validateDiagnostic({
            code: "INVALID_MANIFEST_ENVELOPE",
            severity: "error",
            path: manifestPath("Procedure", p.metadata.name, `/spec/mcp/${key}`, filePaths),
            value,
            expected: `no ${key}, or ${key}: ${!value}, on this sql handler`,
            message: `Procedure '${p.metadata.name}' declares mcp.${key}: ${value} but its sql handler ${message}.`,
          }),
        ]
      : [];
  return [
    ...hint("readOnlyHint", true, "writes"),
    ...(/\bdelete\s+from\b/i.test(h.sql) ? hint("destructiveHint", false, "deletes") : []),
  ];
}

/** Scalar input types a GET path parameter may bind, `null` aside (ADR-0047 §2). */
const PATH_PARAM_TYPES = ["string", "integer", "number", "boolean"] as const;

export function checkTriggerRefs(
  triggers: ReadonlyArray<TriggerManifest>,
  proceduresByName: ReadonlyMap<string, ProcedureManifest>,
  viewsByName: ReadonlyMap<string, ViewManifest>,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const httpRoutes = new Map<string, string>();
  // One description warning per Procedure, not per surface it is exposed on.
  const undescribedMcpProcedures = new Set<string>();

  for (const t of triggers) {
    if ("view" in t.spec.target) {
      const problem = checkViewTrigger(t, t.spec.target.view, viewsByName, httpRoutes, filePaths);
      if (problem) out.push(problem);
      continue;
    }
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
      const pathProblem = httpPathProblem(t, httpPath, filePaths);
      if (pathProblem) out.push(pathProblem);
      // Only track valid paths for collision detection — emitting both
      // TRIGGER_PATH_INVALID and TRIGGER_PATH_COLLISION for the same
      // bad path produces noisy diagnostics that misdescribe the root
      // cause (collision is secondary; the path is the real error).
      const collision = claimRoute(t, t.spec.source.method, httpPath, httpRoutes, filePaths);
      if (collision) out.push(collision);
      else if (!pathProblem) httpRoutes.set(routeKey(t.spec.source.method, httpPath), t.metadata.name);
    }

    if (t.spec.source.kind === "mcp") {
      // An MCP tool is described to a cold agent by `spec.description`.
      // The catalog falls back to "Invoke Procedure '<name>'." when it is
      // absent, which reads like a description and hides the gap; the
      // authoring gate is the one place that can still see it (#970).
      const target = proceduresByName.get(procName);
      if (
        target &&
        !undescribedMcpProcedures.has(procName) &&
        !resolveLocalizedText(target.spec.description, "en")?.trim()
      ) {
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
  }
  return out;
}

/**
 * One root cause per GET View Trigger, in ADR-0047's order: target, path grammar (invalid, then reserved), parameters,
 * collision. A path that fails an earlier check is not claimed for collision detection.
 */
function checkViewTrigger(
  t: TriggerManifest,
  viewName: string,
  viewsByName: ReadonlyMap<string, ViewManifest>,
  httpRoutes: Map<string, string>,
  filePaths?: ManifestFilePaths,
): Diagnostic | undefined {
  const name = t.metadata.name;
  const at = (pointer: string) => manifestPath("Trigger", name, pointer, filePaths);
  const view = viewsByName.get(viewName);
  if (!view) {
    return validateDiagnostic({
      code: "TRIGGER_TARGET_VIEW_UNKNOWN",
      severity: "error",
      path: at("/spec/target/view"),
      value: viewName,
      expected: "name of a declared View",
      candidates: [...viewsByName.keys()],
      suggestion: bestMatch(viewName, [...viewsByName.keys()]),
      message: `Trigger '${name}' targets unknown View '${viewName}'.`,
    });
  }
  if (view.spec.surface !== "public") {
    return validateDiagnostic({
      code: "TRIGGER_TARGET_VIEW_SURFACE",
      severity: "error",
      path: at("/spec/target/view"),
      value: view.spec.surface,
      expected: "a View with surface 'public'",
      message: `Trigger '${name}' targets View '${viewName}' with surface '${view.spec.surface}'; a GET Trigger exposes a public View only.`,
    });
  }
  if (t.spec.source.kind !== "http") return undefined; // Parse refuses this; narrowed for the type.
  const httpPath = t.spec.source.path;
  const pathProblem = httpPathProblem(t, httpPath, filePaths);
  if (pathProblem) return pathProblem;
  // split("/") of a path starting with "/api/" is ["", "api", ...segments].
  const segments = httpPath.split("/").slice(2);
  if (segments.some(segment => segment === "" || segment === "." || segment === ".." || segment.includes("%"))) {
    return validateDiagnostic({
      code: "TRIGGER_PATH_INVALID",
      severity: "error",
      path: at("/spec/source/path"),
      value: httpPath,
      expected: "non-empty segments that are not '.' or '..' and contain no '%', with no trailing '/'",
      message: `GET Trigger '${name}' path '${httpPath}' must not contain empty, '.', '..' or percent-encoded segments or end with '/'.`,
    });
  }
  const first = segments[0]!;
  if (first === "views" || first === "auth" || first.startsWith("{")) {
    const generated = viewsByName.get(segments[1] ?? "");
    const collides =
      first === "views" && segments.length === 2 && generated?.spec.surface === "public"
        ? `; it collides with GET /api/views/${segments[1]}`
        : "";
    return validateDiagnostic({
      code: "TRIGGER_PATH_RESERVED",
      severity: "error",
      path: at("/spec/source/path"),
      value: httpPath,
      expected: "a first segment after '/api/' that is a literal other than 'views' or 'auth'",
      message:
        `GET Trigger '${name}' path '${httpPath}' must start with a literal segment other than 'views' or 'auth' ` +
        `after '/api/'; Core reserves those for generated routes${collides}.`,
    });
  }
  const properties = view.spec.input?.properties ?? {};
  const seen = new Set<string>();
  for (const segment of segments) {
    if (!segment.startsWith("{")) continue;
    const param = segment.slice(1, -1);
    const reason = seen.has(param)
      ? "appears more than once"
      : !Object.hasOwn(properties, param)
        ? `is not a property of View '${viewName}' input`
        : !hasType(properties[param], PATH_PARAM_TYPES)
          ? `is not a ${PATH_PARAM_TYPES.join(", ")} input of View '${viewName}'`
          : undefined;
    seen.add(param);
    if (reason) {
      return validateDiagnostic({
        code: "TRIGGER_PATH_PARAM_INVALID",
        severity: "error",
        path: at("/spec/source/path"),
        value: param,
        expected: `a scalar top-level input property of View '${viewName}', used once`,
        candidates: Object.keys(properties),
        message: `GET Trigger '${name}' path parameter '{${param}}' ${reason}.`,
      });
    }
  }
  const collision = claimRoute(t, "GET", httpPath, httpRoutes, filePaths);
  if (!collision) httpRoutes.set(routeKey("GET", httpPath), name);
  return collision;
}

/** The http grammar every Trigger shares: the `/api/` prefix, and literal or whole-`{name}` segments. */
function httpPathProblem(t: TriggerManifest, httpPath: string, filePaths?: ManifestFilePaths): Diagnostic | undefined {
  // describe writes `{name}` as `:name`, so a literal `:name` segment or a brace outside a whole `{name}` segment
  // would read as another route; refused so describe templates name exactly one route.
  const ambiguous = httpPath
    .split("/")
    .find(segment => !/^\{[^{}/]+\}$/.test(segment) && (segment.startsWith(":") || /[{}]/.test(segment)));
  if (ambiguous !== undefined) {
    return validateDiagnostic({
      code: "TRIGGER_PATH_INVALID",
      severity: "error",
      path: manifestPath("Trigger", t.metadata.name, "/spec/source/path", filePaths),
      value: httpPath,
      expected: "literal segments not starting with ':', and parameters as whole '{name}' segments",
      message:
        `Trigger '${t.metadata.name}' has path segment '${ambiguous}' — describe writes a '{name}' parameter ` +
        `as ':name', so this segment would be read as another route. Use '{name}' for a parameter.`,
    });
  }
  if (!httpPath.startsWith("/api/")) {
    return validateDiagnostic({
      code: "TRIGGER_PATH_INVALID",
      severity: "error",
      path: manifestPath("Trigger", t.metadata.name, "/spec/source/path", filePaths),
      value: httpPath,
      expected: "path starting with '/api/'",
      message:
        `Trigger '${t.metadata.name}' has path '${httpPath}' — http Trigger ` +
        `paths MUST start with '/api/' so adapters can route public ` +
        `pages and Procedure endpoints without ambiguity.`,
    });
  }
  return undefined;
}

/** Parameter names do not change which requests match: `/api/{a}/x` and `/api/{b}/x` are one route, and the second is unreachable. */
function routeKey(method: string, httpPath: string): string {
  return `${method} ${httpPath.replace(/\{[^}]+\}/g, "{}")}`;
}

function claimRoute(
  t: TriggerManifest,
  method: string,
  httpPath: string,
  httpRoutes: ReadonlyMap<string, string>,
  filePaths?: ManifestFilePaths,
): Diagnostic | undefined {
  const prior = httpRoutes.get(routeKey(method, httpPath));
  if (!prior) return undefined;
  return validateDiagnostic({
    code: "TRIGGER_PATH_COLLISION",
    severity: "error",
    path: manifestPath("Trigger", t.metadata.name, "/spec/source", filePaths),
    value: `${method} ${httpPath}`,
    expected: `unique (method, path) across all http Triggers, parameter names aside (also declared by '${prior}')`,
    message: `Trigger '${t.metadata.name}' shares route ${method} ${httpPath} with Trigger '${prior}'; only one of them could ever match.`,
  });
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
  const exposed = new Set(
    triggers.flatMap(t =>
      "procedure" in t.spec.target && t.spec.source.kind === "mcp" ? [t.spec.target.procedure] : [],
    ),
  );
  const claim = (kind: "View" | "Procedure", name: string) => {
    const segment = mcpToolNameSegment(name);
    if ((kind === "View" || exposed.has(name)) && (segment.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(segment))) {
      out.push(
        validateDiagnostic({
          code: "MCP_TOOL_NAME_COLLISION",
          severity: "error",
          path: manifestPath(kind, name, "/metadata/name", filePaths),
          value: segment,
          expected: "an MCP tool name of at most 128 characters from [A-Za-z0-9_.-]",
          message: `${kind} '${name}' cannot be an MCP tool name: it must be at most 128 characters from [A-Za-z0-9_.-].`,
        }),
      );
      return;
    }
    const prior = seen.get(segment);
    if (prior && prior !== `${kind} ${name}`) {
      out.push(
        validateDiagnostic({
          code: "MCP_TOOL_NAME_COLLISION",
          severity: "error",
          path: manifestPath(kind, name, "/metadata/name", filePaths),
          value: segment,
          expected: `${kind} name unique after kebab→snake mangling (collides with ${prior})`,
          message: `${kind} '${name}' mangles to MCP tool name '${segment}', which already comes from ${prior}.`,
        }),
      );
    } else if (!prior) seen.set(segment, `${kind} ${name}`);
  };
  for (const view of views) if (view.spec.surface !== "internal") claim("View", view.metadata.name);
  for (const procedure of procedures) claim("Procedure", procedure.metadata.name);
  const mcpTriggers = new Map<string, string>();
  for (const trigger of triggers) {
    const source = trigger.spec.source;
    if (source.kind !== "mcp" || !("procedure" in trigger.spec.target)) continue;
    const tool = mcpToolNameSegment(trigger.spec.target.procedure);
    const key = `${source.surface}\0${tool}`;
    const prior = mcpTriggers.get(key);
    if (prior) {
      out.push(
        validateDiagnostic({
          code: "MCP_TOOL_NAME_COLLISION",
          severity: "error",
          path: manifestPath("Trigger", trigger.metadata.name, "/spec/source", filePaths),
          value: tool,
          expected: `one MCP Trigger per surface and tool name (already bound by '${prior}')`,
          message: `Trigger '${trigger.metadata.name}' and Trigger '${prior}' both bind '${tool}' on the ${source.surface} MCP surface; invocation would lose Trigger identity.`,
        }),
      );
    } else {
      mcpTriggers.set(key, trigger.metadata.name);
    }
  }
  return out;
}

function hasType(schema: JsonSchema | undefined, types: readonly string[]): boolean {
  const declared = schema?.type;
  const list = Array.isArray(declared) ? declared : declared === undefined ? [] : [declared];
  return (
    list.length > 0 &&
    list.every(type => types.includes(type) || type === "null") &&
    list.some(type => types.includes(type))
  );
}
