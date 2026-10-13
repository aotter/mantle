/**
 * ADR-0046 decision 8: the static capability catalog (`catalog.json`). One entry per exposed target and surface, read by a host or
 * gateway without calling the application. It holds no SQL and no data; `hash` (SHA-256, supplied by the build) is the only
 * environment dependency, so this stays a pure function of the plan.
 */
import { mcpTools, mcpToolNameSegment, resolveLocalizedText, type JsonSchema, type PlanLowered, type RuntimePlan } from "@aotter/mantle/compiler";
import { staffRolesOf } from "../domain/visibility.js";
import { publishingInput } from "./publishing.js";

export interface CatalogEntry {
  /** `view:<name>` or `procedure:<name>`, the host authorization seam's target ids (decision 5). */
  readonly target: string;
  /** `mcp:public`, `mcp:staff` or `rest`. */
  readonly surface: string;
  /** The MCP tool name, or the REST route as `<METHOD> <path>`. */
  readonly tool: string;
  readonly title?: string;
  readonly description: string;
  /** Canonical input JSON Schema, including a View's `limit` and `cursor`. */
  readonly inputSchema: JsonSchema;
  /** `sha256:` of the canonical `inputSchema`: the same for a target on every surface, and only this target's changes with its input. */
  readonly inputHash: string;
  readonly annotations: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean; readonly openWorldHint?: boolean };
  /** Roles `requires` names (`ctx.staff`); a staff surface without a `requires` names every staff role. Empty: no role is required. */
  readonly roles: readonly string[];
  /** OAuth scopes `requires` names. */
  readonly scopes: readonly string[];
  /** Whether a signed-in caller is required at all. */
  readonly authenticated: boolean;
  /** The caller attributes the target's SQL reads (including through a Schema scope). */
  readonly attributes: readonly string[];
}
export interface Catalog {
  readonly catalog: 1;
  /** The declared vocabulary a host may assign (decision 1). */
  readonly auth: { readonly roles: readonly string[]; readonly attributes: Readonly<Record<string, { readonly type: string; readonly multiple: boolean }>> };
  readonly targets: readonly CatalogEntry[];
}

const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
/** Key-sorted JSON: equal schemas hash equally whatever their key order. */
export const canonical = (v: unknown): string => JSON.stringify(sortKeys(v));
const paging = (input: JsonSchema | undefined): JsonSchema => ({ type: "object", ...input, properties: { ...input?.properties, limit: { type: "integer", minimum: 1, maximum: 500 }, cursor: { type: "string" } }, additionalProperties: false } as JsonSchema);

export function buildCatalog(plan: RuntimePlan, lowered: PlanLowered, hash: (text: string) => string): Catalog {
  const staff = staffRolesOf(plan);
  const entries: CatalogEntry[] = [];
  const attrsOf = (kind: "view" | "procedure", name: string): string[] => {
    const statements = kind === "view" ? Object.entries(lowered.views[name] ?? {}).filter(([mode]) => mode !== "trusted").map(([, s]) => s) : (lowered.procedures[name]?.caller ?? []);
    return [...new Set(statements.flatMap(s => s.binds).flatMap(b => b.k === "attr" ? [String(b.name)] : []))].sort();
  };
  const add = (kind: "view" | "procedure", name: string, surface: string, tool: string, operation: { title?: unknown; description?: unknown; requires?: RuntimePlan["views"][string]["requires"] }, input: JsonSchema, annotations: CatalogEntry["annotations"], defaultRoles: readonly string[] = []) => {
    const predicates = operation.requires?.auth?.all ?? [];
    const roles = [...new Set(predicates.flatMap(p => typeof p === "object" && "ctx.staff" in p ? p["ctx.staff"] as string[] : []))].sort();
    const title = resolveLocalizedText(operation.title as never, "en", "en") ?? undefined;
    entries.push({
      target: `${kind}:${name}`, surface, tool, ...(title ? { title } : {}),
      description: resolveLocalizedText(operation.description as never, "en", "en") ?? title ?? name,
      inputSchema: input, inputHash: "sha256:" + hash(canonical(input)), annotations,
      roles: roles.length ? roles : [...defaultRoles],
      scopes: [...new Set(predicates.flatMap(p => typeof p === "object" && "ctx.auth.scope" in p ? [p["ctx.auth.scope"]] : []))].sort(),
      authenticated: predicates.length > 0 || surface === "mcp:staff",
      attributes: attrsOf(kind, name),
    });
  };
  for (const surface of ["public", "staff"] as const) {
    for (const t of mcpTools(plan, surface)) {
      const view = t.kind === "view";
      add(t.kind, t.source, `mcp:${surface}`, t.name, { title: plan[view ? "views" : "procedures"][t.source]!.title, description: plan[view ? "views" : "procedures"][t.source]!.description, requires: t.requires },
        view ? paging(plan.views[t.source]!.input) : t.inputSchema, t.annotations ?? {}, surface === "staff" ? staff : []);
    }
  }
  for (const schema of Object.values(plan.schemas)) if (schema.publishing) for (const verb of ["publish", "unpublish", "archive"]) {
    entries.push({ target: `procedure:${schema.name}.${verb}`, surface: "mcp:staff", tool: mcpToolNameSegment(`${verb}_${schema.name}`), description: `${verb} a ${schema.name} entry`, inputSchema: publishingInput, inputHash: "sha256:" + hash(canonical(publishingInput)), annotations: {}, roles: [...staff], scopes: [], authenticated: true, attributes: [] });
  }
  for (const [name, view] of Object.entries(plan.views)) if (view.surface === "public") add("view", name, "rest", `GET /api/views/${name}`, view, paging(view.input), { readOnlyHint: true });
  for (const t of Object.values(plan.triggers)) if (t.source.kind === "http") {
    const p = plan.procedures[t.procedure]!;
    add("procedure", t.procedure, "rest", `${t.source.method} ${t.source.path}`, p, p.input, p.mcp ?? {});
  }
  entries.sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : a.tool < b.tool ? -1 : 1);
  return { catalog: 1, auth: { roles: ["staff", ...(plan.auth?.roles ?? [])], attributes: plan.auth?.attributes ?? {} }, targets: entries };
}
