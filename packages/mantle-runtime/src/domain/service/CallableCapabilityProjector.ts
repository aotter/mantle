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
  for (const tool of plan.mcpTools) {
    if (tool.ownerKind !== "View") continue;
    const view = plan.views[tool.ownerName];
    if (!view) continue;
    const manifest = view.manifest;
    const title = resolveLocalizedText(manifest.spec.title, "en");
    capabilities.push({
      kind: "view",
      name: tool.name,
      ownerName: view.name,
      surface: tool.surface,
      ...(title ? { title } : {}),
      description: `Query ${manifest.spec.surface} View '${view.name}'.`,
      inputSchema: viewInputSchema(manifest),
      manifest,
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
