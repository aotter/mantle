import { buildMcpToolCatalog, McpJsonRpcDispatcher, projectCallableCapabilities, type McpToolDefinition, type MantleRuntime, type RuntimePlan } from "@aotter/mantle-runtime";
import { mcpToolNameSegment } from "@aotter/mantle-spec";

/** Same catalog and dispatcher as staff MCP; the caller supplies verified session context. */
export async function staffMcp(runtime: MantleRuntime, plan: RuntimePlan): Promise<{ tools: readonly McpToolDefinition[]; routes: Record<string, { path: string; entry?: boolean }>; dispatcher: McpJsonRpcDispatcher }> {
  const site = await runtime.siteConfig?.load();
  const purposes = runtime.media ? site?.media.purposes ?? [] : [];
  const capabilities = projectCallableCapabilities(plan, { surface: "staff" });
  const schemas = [...runtime.schemas.values()];
  const media = runtime.media && purposes.length ? { ...runtime.media, purposes } : undefined;
  const options = { surface: "staff" as const, capabilities };
  const tools = buildMcpToolCatalog(schemas, { ...options, mediaEnabled: !!media, mediaPurposes: purposes });
  const routes: Record<string, { path: string; entry?: boolean }> = {};
  for (const schema of schemas) {
    for (const prefix of ["create_draft_", "update_draft_", "create_record_", "update_record_"]) {
      routes[prefix + mcpToolNameSegment(schema.metadata.name)] = {
        path: `/admin/c/${encodeURIComponent(schema.metadata.name)}`, entry: true,
      };
    }
  }
  for (const capability of capabilities) {
    if (capability.kind === "view") {
      routes[capability.name] = { path: `/admin/views/${encodeURIComponent(capability.ownerName)}` };
    } else {
      const handler = capability.manifest.spec.handler;
      if (handler.kind === "builtin") routes[capability.name] = {
        path: `/admin/c/${encodeURIComponent(handler.schema)}`,
        entry: handler.op !== "delete",
      };
    }
  }
  routes.commit_media_upload = { path: "/admin/media" };
  return {
    tools, routes,
    dispatcher: new McpJsonRpcDispatcher({
      getEntry: runtime.getEntry,
      createDraft: runtime.createDraft, updateDraft: runtime.updateDraft,
      requestPublish: runtime.requestPublish, unpublish: runtime.unpublish,
      archive: runtime.archive, deleteEntry: runtime.deleteEntry,
      executeView: { execute: request => runtime.executeView({ ...request, view: request.view.metadata.name }) },
      invokeTrigger: { execute: request => runtime.invokeTrigger(request) },
      media,
    }, schemas, options),
  };
}
