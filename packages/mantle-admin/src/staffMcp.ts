import type { MediaPurposePolicy } from "@aotter/mantle-spec";
import { bindCapabilities, type MantleRuntime, type RuntimePlan } from "@aotter/mantle-runtime";
import { createMantleMcpHandler, mcpToolDefinitions, type MantleMcpHandler } from "@aotter/mantle-mcp";

export type StaffTool = ReturnType<typeof mcpToolDefinitions>[number];

/** Same catalog and handler as staff MCP; the caller supplies verified session context. */
export async function staffMcp(runtime: MantleRuntime, plan: RuntimePlan): Promise<{
  tools: readonly StaffTool[];
  routes: Record<string, { path: string; entry?: boolean }>;
  handler: MantleMcpHandler;
}> {
  const site = await runtime.siteConfig?.load();
  const mediaPurposes = runtime.media ? site?.media.purposes ?? [] : [];
  // Operator edits to media purposes rebuild the catalog without a redeploy.
  const key = JSON.stringify(mediaPurposes);
  const cached = cache.get(runtime);
  if (cached?.key === key && cached.plan === plan) return cached.value;
  const value = build(runtime, plan, mediaPurposes);
  cache.set(runtime, { key, plan, value });
  return value;
}

type StaffMcp = Awaited<ReturnType<typeof staffMcp>>;
const cache = new WeakMap<object, { readonly key: string; readonly plan: RuntimePlan; readonly value: StaffMcp }>();

function build(runtime: MantleRuntime, plan: RuntimePlan, mediaPurposes: readonly MediaPurposePolicy[]): StaffMcp {
  const invoker = bindCapabilities(runtime, plan, { surface: "staff", mediaPurposes });
  // Admin opens the page a result lands on. Routes come from each
  // capability's resolved route, never from its tool name.
  const routes: Record<string, { path: string; entry?: boolean }> = {};
  for (const capability of invoker.catalog.capabilities) {
    const route = capability.route;
    if (route.kind === "create" || route.kind === "update") {
      routes[capability.name] = { path: `/admin/c/${encodeURIComponent(route.collection)}`, entry: true };
    } else if (route.kind === "view") {
      routes[capability.name] = { path: `/admin/views/${encodeURIComponent(route.view.metadata.name)}` };
    } else if (route.kind === "procedure") {
      const handler = plan.procedures[plan.triggers[route.trigger]?.target ?? ""]?.manifest.spec.handler;
      if (handler?.kind === "builtin") routes[capability.name] = {
        path: `/admin/c/${encodeURIComponent(handler.schema)}`,
        entry: handler.op !== "delete",
      };
    } else if (route.kind === "mediaCommitUpload") {
      routes[capability.name] = { path: "/admin/media" };
    }
  }
  return {
    tools: mcpToolDefinitions(invoker),
    routes,
    handler: createMantleMcpHandler(invoker, { serverInfo: { name: "aotter.mantle.admin" } }),
  };
}
