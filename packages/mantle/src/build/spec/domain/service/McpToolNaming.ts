import { INPUT_RULE_KEYWORDS, resolveLocalizedText, type AuthorizationRequirements, type JsonSchema, type LocalizedText, type ProcedureMcpAnnotations } from "../model/ManifestGrammar.js";
import type { PlanProcedure, RuntimePlan } from "../model/RuntimePlan.js";
import { rootRefChain } from "./RootRefChain.js";

/**
 * A View or Procedure name → MCP tool name: lowercase, kebab to snake. The one place the rule lives; the graph validator's
 * collision check and the MCP surface both use it.
 */
export function mcpToolNameSegment(name: string): string {
  return name.toLowerCase().replace(/-/g, "_");
}

/** A tool title from a name when the manifest declares none: `add-item`, `addItem` and `add_item` read `Add item`. */
export function toolTitle(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_.\s]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const viewAnnotations = { readOnlyHint: true, destructiveHint: false } as const;
/**
 * A Procedure's tool hints: declared ones win; otherwise it writes, and is destructive unless its SQL only inserts. A ref handler
 * is opaque, so destructive. Hints only: authorization never reads them.
 */
export function procedureAnnotations(p: PlanProcedure): ProcedureMcpAnnotations {
  const readOnlyHint = p.mcp?.readOnlyHint ?? false;
  return { readOnlyHint, destructiveHint: !readOnlyHint && ("ref" in p.handler || overwrites(p.handler.sql.stmts)), ...p.mcp };
}
/** Any DELETE, UPDATE or upsert DO UPDATE, a writable CTE included. */
const overwrites = (node: unknown): boolean => !!node && typeof node === "object" &&
  ("DeleteStmt" in node || "UpdateStmt" in node || (node as { onConflictClause?: { action?: string } }).onConflictClause?.action === "ONCONFLICT_UPDATE" || Object.values(node).some(overwrites));

/** One MCP tool and the Procedure or View it comes from. */
export interface McpTool {
  readonly name: string;
  readonly kind: "procedure" | "view";
  readonly source: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: ProcedureMcpAnnotations;
  readonly requires: AuthorizationRequirements | undefined;
}

/**
 * The tools an MCP surface lists (ADR-0032 decision 9): each Procedure bound by an `mcp` Trigger of the surface and each View of it,
 * never a Schema. Generated MCP and Admin catalogues use these declarations; publishing transitions are added by the generator.
 */
export function mcpTools(plan: RuntimePlan, surface: "public" | "admin", locale = "en"): McpTool[] {
  const text = (t: LocalizedText | undefined) => resolveLocalizedText(t, locale, "en") ?? undefined;
  const tools = new Map<string, McpTool>();
  const add = (tool: McpTool) => {
    const prior = tools.get(tool.name);
    if (prior && (prior.kind !== tool.kind || prior.source !== tool.source)) throw new TypeError(`MCP tool '${tool.name}' comes from both '${prior.source}' and '${tool.source}'.`);
    tools.set(tool.name, tool);
  };
  for (const t of Object.values(plan.triggers)) {
    if (t.source.kind !== "mcp" || t.source.surface !== surface) continue;
    const p = plan.procedures[t.procedure]!;
    const title = text(p.title);
    add({
      name: mcpToolNameSegment(t.procedure), kind: "procedure", source: t.procedure, title: title ?? toolTitle(t.procedure),
      description: text(p.description) ?? title ?? t.procedure, inputSchema: p.input,
      // structuredContent must be an object
      ...(p.output.type === "object" ? { outputSchema: p.output } : {}),
      annotations: procedureAnnotations(p), requires: p.requires,
    });
  }
  for (const [name, v] of Object.entries(plan.views)) {
    if (v.surface !== surface) continue;
    // Validation applies every schema of a root `$ref` chain to the input: the tool merges their properties and required, and keeps
    // each schema's rules, under `allOf` when more than one declares any, since they all hold.
    const chain = (v.input ? rootRefChain(v.input) ?? [v.input] : []).reverse();
    const props = Object.assign({}, ...chain.map((s) => s.properties ?? {})) as Record<string, JsonSchema>;
    const required = [...new Set(chain.flatMap((s) => s.required ?? []))];
    if ("limit" in props || "cursor" in props) throw new TypeError(`View '${name}' declares an input named limit or cursor; the MCP tool reserves both for paging.`);
    // Input rules stay: describe keeps them, AI tool catalogues turn them into sentences.
    const rules = chain.map((s) => Object.fromEntries(INPUT_RULE_KEYWORDS.flatMap((k) => s[k] === undefined ? [] : [[k, s[k]]]))).filter((r) => Object.keys(r).length);
    const defs = v.input ? referencedDefs(v.input, props) : {};
    const title = text(v.title);
    add({
      name: mcpToolNameSegment(name), kind: "view", source: name, title: title ?? toolTitle(name), description: text(v.description) ?? title ?? name,
      inputSchema: { type: "object", properties: { ...props, limit: { type: "integer", minimum: 1, maximum: 500 }, cursor: { type: "string" } }, ...(required.length ? { required } : {}),
        ...(rules.length > 1 ? { allOf: rules } : rules[0]), ...(Object.keys(defs).length ? { $defs: defs } : {}) } as JsonSchema,
      annotations: viewAnnotations, requires: v.requires,
    });
  }
  return [...tools.values()];
}

/** The root `$defs` entries that `$ref`s under `node` reach, transitively: lifted properties keep resolving in the tool's schema. */
function referencedDefs(root: JsonSchema, node: unknown, found: Record<string, JsonSchema> = {}): Record<string, JsonSchema> {
  if (!node || typeof node !== "object") return found;
  // The pointer is decoded as `lookupLocalRef` decodes it.
  const ref = (node as JsonSchema).$ref, [head, segment] = typeof ref === "string" && ref.startsWith("#/") ? decoded(ref.slice(2)).split("/") : [];
  const key = head === "$defs" ? segment?.replace(/~1/g, "/").replace(/~0/g, "~") : undefined;
  if (key !== undefined && !Object.hasOwn(found, key) && root.$defs && Object.hasOwn(root.$defs, key)) {
    found[key] = root.$defs[key]!;
    referencedDefs(root, found[key], found);
  }
  for (const child of Object.values(node)) referencedDefs(root, child, found);
  return found;
}
const decoded = (pointer: string): string => { try { return decodeURIComponent(pointer); } catch { return ""; } };
