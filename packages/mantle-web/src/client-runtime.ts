import { createMantleRequestHandler, projectCallableCapabilities, type RuntimePlan, type MantleRuntime, type HandlerContext } from "@aotter/mantle-runtime";
import { createMantleClient, type FrontendContract } from "./client.js";

/** Expose only declared public Views and HTTP Triggers, never an internal reader. */
export function projectFrontendContract(plan: RuntimePlan): FrontendContract {
  const views = projectCallableCapabilities(plan, { surface: "public" }).filter(item => item.kind === "view");
  return {
    version: 1, fingerprint: plan.semanticFingerprint,
    views: views.map(view => ({ name: view.ownerName, inputSchema: view.inputSchema, outputSchema: { type: "object", required: ["rows", "page", "show", "hasMore"], properties: { rows: { type: "array", items: { type: "object" } }, page: { type: "number" }, show: { type: "number" }, hasMore: { type: "boolean" } } }, requires: plan.views[view.ownerName]?.manifest.spec.requires })),
    calls: plan.httpRoutes.map(route => {
      const procedure = plan.procedures[route.procedure]!.manifest.spec;
      return { name: route.trigger, procedure: route.procedure, method: route.method, path: route.path, inputSchema: procedure.input, outputSchema: procedure.output, requires: procedure.requires };
    }),
  };
}

/** One client per SSR request. No network request, SQL access or auth shortcut. */
export function createRuntimeClient(options: { origin: string; plan: RuntimePlan; getRuntime: () => Promise<MantleRuntime>; context: HandlerContext }) {
  const handle = createMantleRequestHandler(options);
  return createMantleClient({ origin: options.origin, contract: projectFrontendContract(options.plan), fetch: async input => {
    const request = input instanceof Request ? input : new Request(input);
    request.signal.throwIfAborted();
    return await handle(request, options.context) ?? new Response(null, { status: 404 });
  } });
}
