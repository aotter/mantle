import {
  validateDiagnostic,
  type Diagnostic,
} from "../kernel/diagnostic.js";
import { checkSiteLocales } from "../domain/service/CrossSchemaChecker.js";
import {
  linkManifestSet,
  type LinkedManifestSet,
} from "../domain/service/ManifestLinker.js";
import type { McpInputCheckOptions, ValidateManifestsRequest } from "./dto/ValidateManifestsRequest.js";
import type { JsonSchema } from "../domain/model/ManifestGrammar.js";
import type { ValidateManifestsResponse } from "./dto/ValidateManifestsResponse.js";

/** Link one parser-owned value and apply optional authoring checks. */
export class ValidateManifestsUseCase {
  execute(request: ValidateManifestsRequest): ValidateManifestsResponse {
    const linked = linkManifestSet(request.parsed);
    const diagnostics: Diagnostic[] = [...linked.diagnostics];
    if (linked.ok && request.siteLocales !== undefined) {
      diagnostics.push(...checkSiteLocales({
        schemas: linked.value.schemas.map((schema) => schema.manifest),
        phase: "validate",
        siteLocales: request.siteLocales,
      }));
    }
    if (linked.ok && request.handlerSource !== undefined) {
      diagnostics.push(...checkHandlerRefsInSource(linked.value, request.handlerSource));
    }
    if (linked.ok && request.mcpInput !== false) {
      diagnostics.push(...checkMcpToolInputShapes(linked.value, request.mcpInput ?? {}));
    }
    if (linked.ok && request.sqlViewSandbox) {
      diagnostics.push(...checkSqlViewTables(linked.value, request.sqlViewSandbox));
    }
    const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    return {
      diagnostics,
      errorCount,
      warningCount: diagnostics.length - errorCount,
      ...(linked.ok ? { linked: linked.value } : {}),
    };
  }

  static run(request: ValidateManifestsRequest): ValidateManifestsResponse {
    return new ValidateManifestsUseCase().execute(request);
  }
}

const NATIVE_COLUMNS = [
  "_mantle_id", "_mantle_status", "_mantle_version",
  "_mantle_created_at", "_mantle_updated_at", "_mantle_author_id",
] as const;

function checkSqlViewTables(
  linked: LinkedManifestSet,
  sandbox: NonNullable<ValidateManifestsRequest["sqlViewSandbox"]>,
): Diagnostic[] {
  const views = linked.views.filter((view) => view.manifest.spec.sql);
  if (views.length === 0) return [];
  try {
    for (const { manifest } of linked.schemas) {
      const columns = [...NATIVE_COLUMNS, ...Object.keys(manifest.spec.schema.properties ?? {})];
      sandbox.exec(`CREATE TABLE ${quoteSqlIdentifier(manifest.metadata.name)} (${columns.map((name) => `${quoteSqlIdentifier(name)} BLOB`).join(", ")})`);
    }
  } catch (error) {
    return views.map((view) => sqlViewDiagnostic(view, error));
  }
  return views.flatMap((view) => {
    const sql = view.manifest.spec.sql!;
    try {
      if (referencesSqliteInternalSource(sql)) {
        throw new Error("SQLite internal tables are not declared Schema tables");
      }
      sandbox.exec(`SELECT * FROM (${sql}) AS "_mantle_sql_view_check" LIMIT 0`);
      return [];
    } catch (error) {
      return [sqlViewDiagnostic(view, error)];
    }
  });
}

function sqlViewDiagnostic(
  view: LinkedManifestSet["views"][number],
  error: unknown,
): Diagnostic {
  const path = "/spec/sql";
  return validateDiagnostic({
    code: "INVALID_MANIFEST_ENVELOPE",
    severity: "error",
    path,
    source: { ...view.source, path },
    value: view.manifest.spec.sql,
    expected: "one read-only SELECT over tables declared by a Schema in this manifest",
    message: `View '${view.manifest.metadata.name}' SQL is not valid against the declared Schema tables: ${error instanceof Error ? error.message : String(error)}`,
  });
}

interface SqlToken {
  readonly kind: "identifier" | "quotedIdentifier" | "punctuation";
  readonly value: string;
}

function referencesSqliteInternalSource(sql: string): boolean {
  const tokens = tokenizeSql(sql);
  const sourceDepths = new Set<number>();
  const expectingSource = new Set<number>();
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "punctuation") {
      if (token.value === "(") {
        expectingSource.delete(depth);
        depth += 1;
      } else if (token.value === ")") {
        sourceDepths.delete(depth);
        expectingSource.delete(depth);
        depth = Math.max(0, depth - 1);
      } else if (token.value === "," && sourceDepths.has(depth)) {
        expectingSource.add(depth);
      }
      continue;
    }
    const word = token.value.toLowerCase();
    if (token.kind === "identifier" && (word === "from" || word === "join")) {
      sourceDepths.add(depth);
      expectingSource.add(depth);
      continue;
    }
    if (token.kind === "identifier" && ["where", "group", "having", "order", "limit", "union", "intersect", "except", "window"].includes(word)) {
      sourceDepths.delete(depth);
      expectingSource.delete(depth);
      continue;
    }
    if (!expectingSource.has(depth)) continue;
    const qualified = tokens[index + 1]?.value === "." ? tokens[index + 2]?.value : undefined;
    if (isSqliteInternalSource(word) || (qualified && isSqliteInternalSource(qualified.toLowerCase()))) {
      return true;
    }
    expectingSource.delete(depth);
  }
  return false;
}

function isSqliteInternalSource(name: string): boolean {
  return name.startsWith("pragma_") || [
    "dbstat", "sqlite_schema", "sqlite_master", "sqlite_temp_schema", "sqlite_temp_master",
  ].includes(name);
}

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (let index = 0; index < sql.length;) {
    const char = sql[index]!;
    if (/\s/u.test(char)) {
      index += 1;
    } else if (sql.startsWith("--", index)) {
      index = sql.indexOf("\n", index + 2);
      if (index < 0) break;
    } else if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 2;
    } else if (char === "'") {
      index = quotedSqlEnd(sql, index, "'", "'");
    } else if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      const end = quotedSqlEnd(sql, index, close, close);
      tokens.push({ kind: "quotedIdentifier", value: sql.slice(index + 1, end - 1).replaceAll(close + close, close) });
      index = end;
    } else if (/[A-Za-z_]/u.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/u.test(sql[end]!)) end += 1;
      tokens.push({ kind: "identifier", value: sql.slice(index, end) });
      index = end;
    } else {
      if ("(),.".includes(char)) tokens.push({ kind: "punctuation", value: char });
      index += 1;
    }
  }
  return tokens;
}

function quotedSqlEnd(sql: string, start: number, close: string, escape: string): number {
  for (let index = start + 1; index < sql.length; index += 1) {
    if (sql[index] !== close) continue;
    if (sql[index + 1] === escape) {
      index += 1;
      continue;
    }
    return index + 1;
  }
  return sql.length;
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function checkHandlerRefsInSource(
  linked: LinkedManifestSet,
  sourceText: string,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const procedure of linked.procedures) {
    const handler = procedure.manifest.spec.handler;
    if (handler.kind !== "ref") continue;
    const escaped = handler.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = new RegExp(`["'\`]${escaped}["'\`]`);
    const propertyKey = new RegExp(`(?:^|[\\s{,;])${escaped}\\s*:`, "m");
    if (quoted.test(sourceText) || propertyKey.test(sourceText)) continue;
    const path = "/spec/handler/ref";
    out.push(validateDiagnostic({
      code: "HANDLER_NOT_REGISTERED",
      severity: "warning",
      path,
      source: { ...procedure.source, path },
      value: handler.ref,
      expected: `'${handler.ref}' to appear in the handlers map as an object-property key`,
      message: `Procedure '${procedure.manifest.metadata.name}' handler.ref '${handler.ref}' was not found in any handler source file.`,
    }));
  }
  return out;
}

/**
 * A Procedure's HTTP input schema is reused verbatim as its MCP tool schema,
 * so shapes that are fine for a typed client can strand a cold agent (#971).
 * Advisory only, and only for Procedures reachable from an MCP Trigger.
 */
function checkMcpToolInputShapes(
  linked: LinkedManifestSet,
  options: McpInputCheckOptions,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const unionAmbiguity = options.unionAmbiguity ?? true;
  const maxArrayItems = options.maxArrayItems === undefined ? 100 : options.maxArrayItems;
  const exposed = new Set(
    linked.triggers
      .filter((trigger) => trigger.manifest.spec.source.kind === "mcp")
      .map((trigger) => trigger.manifest.spec.target.procedure),
  );
  for (const procedure of linked.procedures) {
    const name = procedure.manifest.metadata.name;
    if (!exposed.has(name)) continue;
    const input = procedure.manifest.spec.input;
    const diagnostic = (code: "MCP_TOOL_INPUT_UNION_AMBIGUOUS" | "MCP_TOOL_INPUT_UNBOUNDED", path: string, value: unknown, expected: string, message: string) =>
      validateDiagnostic({
        code,
        severity: "warning",
        path,
        source: { ...procedure.source, path },
        value,
        expected,
        message,
      });

    // The v0.1 grammar accepts `oneOf` only (`anyOf` is rejected at parse), so
    // that is the one union keyword to inspect.
    if (unionAmbiguity && Array.isArray(input.oneOf) && input.oneOf.length > 0) {
      const advertised = new Set(input.required ?? []);
      const hidden = new Set<string>();
      for (const branch of input.oneOf) {
        for (const field of branch.required ?? []) if (!advertised.has(field)) hidden.add(field);
      }
      const path = "/spec/input/oneOf";
      const advertisedText = `[${[...advertised].sort().join(", ")}]`;
      out.push(diagnostic(
        "MCP_TOOL_INPUT_UNION_AMBIGUOUS",
        path,
        [...hidden].sort(),
        "one MCP tool per branch, or a top-level required set that is true for every branch",
        hidden.size
          ? `Procedure '${name}' is an MCP tool whose input is a top-level oneOf; its advertised required set ` +
            `${advertisedText} hides [${[...hidden].sort().join(", ")}], which some branch needs, so a caller satisfying ` +
            `the schema can still be rejected. MCP clients render oneOf poorly; prefer separate tools (e.g. create/update).`
          : `Procedure '${name}' is an MCP tool whose input is a top-level oneOf. MCP clients render oneOf poorly and ` +
            `cannot tell an agent which branch it is filling; prefer separate tools (e.g. create/update).`,
      ));
    }

    if (maxArrayItems !== null) {
      for (const [field, property] of Object.entries(input.properties ?? {})) {
        const schema = property as JsonSchema;
        const path = `/spec/input/properties/${field}`;
        const types = new Set(Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []);
        if (types.has("array")) {
          const bound = typeof schema.maxItems === "number" ? schema.maxItems : undefined;
          if (bound === undefined || bound > maxArrayItems) {
            out.push(diagnostic(
              "MCP_TOOL_INPUT_UNBOUNDED",
              path,
              bound ?? null,
              `maxItems <= ${maxArrayItems} on an MCP tool array input`,
              `Procedure '${name}' is an MCP tool with array input '${field}' ${bound === undefined ? "without maxItems" : `allowing ${bound} items`}; ` +
                `an agent must serialise the whole array into one tools/call.`,
            ));
          }
        } else if (types.has("object")
          // Free-form means no declared shape at all: a typed map
          // (`additionalProperties: { type: string }`) declares its values.
          && (schema.additionalProperties === undefined || schema.additionalProperties === true)
          && Object.keys(schema.properties ?? {}).length === 0) {
          out.push(diagnostic(
            "MCP_TOOL_INPUT_UNBOUNDED",
            path,
            null,
            "declared properties, or a narrower tool that does not take a free-form document",
            `Procedure '${name}' is an MCP tool with free-form object input '${field}' (no declared properties); ` +
              `its size is unbounded and an agent gets no shape to fill.`,
          ));
        }
      }
    }
  }
  return out;
}
