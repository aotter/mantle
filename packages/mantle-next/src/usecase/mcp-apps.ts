/** Generated App assembly consumes the static catalogue, never a runtime plan. */
import type { RuntimePlan } from "@aotter/mantle/spec";
export function emitMcpApps(plan: RuntimePlan): Record<string, string> {
  if (!Object.values(plan.views).some(view => view.surface !== "internal")) return {};
  return { "mcp-app.ts": `import { planApp as assemble } from "@aotter/mantle-next/mcp-apps";
import { mcpAppCatalogues } from "./admin-descriptors.js";
export function planApp(options: Parameters<typeof assemble>[1]): ReturnType<typeof assemble> { return assemble(mcpAppCatalogues[options.surface], options); }
` };
}
