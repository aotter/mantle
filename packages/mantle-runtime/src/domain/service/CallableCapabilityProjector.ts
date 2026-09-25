import {
  resolveLocalizedText,
  type JsonSchema,
  type ProcedureManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";
import type { RuntimePlan } from "./RuntimePlanCompiler.js";

interface CallableCapabilityBase {
  readonly name: string;
  readonly surface: "staff" | "public";
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ViewCallableCapability extends CallableCapabilityBase {
  readonly kind: "view";
  readonly ownerName: string;
  readonly manifest: ViewManifest;
  /** Operations on the same surface a row of this View can open, with the
   *  row fields they bind (ADR-0029). */
  readonly rowActions?: readonly ViewRowAction[];
}

export interface ViewRowAction {
  /** Capability name of the Procedure on the same surface. */
  readonly capability: string;
  readonly procedure: string;
  readonly bind: readonly { readonly input: string; readonly field: string }[];
  readonly version?: string;
  readonly mutates: boolean;
}

export interface ProcedureCallableCapability extends CallableCapabilityBase {
  readonly kind: "procedure";
  readonly ownerName: string;
  readonly trigger: string;
  readonly manifest: ProcedureManifest;
  readonly outputSchema: JsonSchema;
}

export type RuntimeCallableCapability =
  | ViewCallableCapability
  | ProcedureCallableCapability;

/** Pure callable projection. Discovery and invocation consume this same slice. */
export function projectCallableCapabilities(
  plan: RuntimePlan,
  options: { readonly surface?: "staff" | "public" } = {},
): readonly RuntimeCallableCapability[] {
  const capabilities: RuntimeCallableCapability[] = [];
  const procedureTools = new Map(plan.mcpTools.flatMap((tool) => tool.ownerKind === "Procedure"
    ? [[`${tool.surface}\0${tool.ownerName}`, tool.name] as const]
    : []));
  for (const tool of plan.mcpTools) {
    if (tool.ownerKind !== "View") continue;
    const view = plan.views[tool.ownerName];
    if (!view) continue;
    const manifest = view.manifest;
    const title = resolveLocalizedText(manifest.spec.title, "en");
    const purpose =
      resolveLocalizedText(manifest.spec.description, "en") ??
      `Query ${manifest.spec.surface} View '${view.name}'.`;
    capabilities.push({
      kind: "view",
      name: tool.name,
      ownerName: view.name,
      surface: tool.surface,
      ...(title ? { title } : {}),
      description: `${purpose}${manifest.spec.cache
        ? ` Anonymous REST responses may be shared for up to ${manifest.spec.cache.sharedMaxAge} seconds.`
        : ""}`,
      inputSchema: viewInputSchema(manifest),
      manifest,
      ...rowActionsOf(plan, view.name, tool.surface, procedureTools),
    });
  }
  for (const tool of plan.mcpTools) {
    if (tool.ownerKind !== "Procedure") continue;
    const procedure = plan.procedures[tool.ownerName];
    if (!procedure) continue;
    const title = resolveLocalizedText(procedure.manifest.spec.title, "en");
    const description =
      resolveLocalizedText(procedure.manifest.spec.description, "en") ??
      `Invoke Procedure '${procedure.name}'.`;
    capabilities.push({
      kind: "procedure",
      name: tool.name,
      ownerName: procedure.name,
      trigger: tool.trigger,
      surface: tool.surface,
      ...(title ? { title } : {}),
      description,
      inputSchema: procedure.manifest.spec.input,
      outputSchema: procedure.manifest.spec.output,
      manifest: procedure.manifest,
    });
  }
  return Object.freeze(capabilities
    .filter((capability) => !options.surface || capability.surface === options.surface)
    .sort((a, b) => compareText(`${a.surface}\0${a.name}\0${a.ownerName}`, `${b.surface}\0${b.name}\0${b.ownerName}`))
    .map((capability) => Object.freeze(capability)));
}

/**
 * Schemas the bounded staff `read_entry` may read (ADR-0029 D2): operation
 * targets of Procedures that are themselves tools on the staff surface. A
 * Procedure reachable only over HTTP, a schedule or not at all never widens
 * what reaches a model's context. Translation children are excluded.
 */
export function interactionReadTargets(plan: RuntimePlan, surface: "staff" | "public"): readonly string[] {
  if (surface !== "staff") return [];
  const staffProcedures = new Set(plan.mcpTools.flatMap((tool) =>
    tool.ownerKind === "Procedure" && tool.surface === "staff" ? [tool.ownerName] : []));
  return [...new Set((plan.interactions ?? [])
    .filter((interaction) => interaction.mutates && staffProcedures.has(interaction.procedure))
    .map((interaction) => interaction.schema)
    .filter((schema) => !plan.schemas[schema]?.manifest.spec.translates))].sort();
}

function rowActionsOf(
  plan: RuntimePlan,
  view: string,
  surface: "staff" | "public",
  procedureTools: ReadonlyMap<string, string>,
): { rowActions?: readonly ViewRowAction[] } {
  const actions = (plan.interactions ?? []).flatMap((interaction): ViewRowAction[] => {
    const capability = procedureTools.get(`${surface}\0${interaction.procedure}`);
    if (!capability || !interaction.views.includes(view)) return [];
    return [Object.freeze({
      capability,
      procedure: interaction.procedure,
      bind: interaction.bind,
      ...(interaction.version ? { version: interaction.version } : {}),
      mutates: interaction.mutates,
    })];
  });
  return actions.length > 0 ? { rowActions: Object.freeze(actions) } : {};
}

function viewInputSchema(view: ViewManifest): JsonSchema {
  return {
    type: "object",
    properties: {
      ...(view.spec.params?.properties ?? {}),
      page: { type: "number", description: "Optional 1-based page number." },
      show: { type: "number", description: "Optional page size, capped by the View limit." },
    },
    ...(view.spec.params?.required?.length ? { required: view.spec.params.required } : {}),
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
