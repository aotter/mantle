import * as React from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { useAdminRouter } from "../app/router";
import { usePreferences } from "../app/preferences";
import { t } from "../app/i18n";
import { queryClient } from "../app/query-client";
import { adminWebMcpQueryOptions } from "../lib/queries";
import { isAdminPreview } from "../app/frame-policy";
import { adminPath, callStaffTool, resultPath, type AdminModelContext, type AdminToolCatalog } from "../lib/admin-tools";
import { Button } from "@aotter/mantle-ui/kit";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@aotter/mantle-ui/kit";

export function WebMcpControl(): React.ReactElement | null {
  const { navigate } = useAdminRouter();
  const { language } = usePreferences();
  const [catalog, setCatalog] = React.useState<AdminToolCatalog | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    const model = (document as Document & { modelContext?: AdminModelContext }).modelContext;
    if (!model?.registerTool && !isAdminPreview()) return;
    let removeBridge = () => {};
    void (async () => {
      const catalog = await queryClient.fetchQuery(adminWebMcpQueryOptions());
      if (controller.signal.aborted) return;
      const tools = catalog.tools;
      const execute = async (name: string, input: Record<string, unknown>, signal = controller.signal, navigation = true) => {
        signal.throwIfAborted();
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Tool input must be an object.");
        if (!tools.some(tool => tool.name === name)) throw new TypeError("Unknown staff tool.");
        if (name === "admin_get_context") return { path: location.pathname + location.search, tools };
        if (name === "admin_navigate") {
          const path = adminPath(input.path);
          navigate(path);
          return { path };
        }
        const { result, output } = await callStaffTool(name, input, signal);
        await queryClient.invalidateQueries();
        const path = resultPath(catalog, name, output);
        if (navigation && path) navigate(path);
        return result;
      };
      // Only the explicitly sandboxed same-origin parent can use this bridge.
      if (isAdminPreview()) {
        const onMessage = (event: MessageEvent) => {
          if (event.source !== window.parent || event.origin !== location.origin || event.data?.type !== "mantle:admin-tools:request" || event.data?.protocolVersion !== 1 || !event.ports[0]) return;
          const port = event.ports[0];
          const message = event.data;
          void (async () => {
            try {
              const result = message.method === "list" ? { tools } : message.method === "call"
                ? await execute(message.name, message.input, controller.signal, message.navigation !== false)
                : (() => { throw new TypeError("Unknown Admin bridge method."); })();
              port.postMessage({ ok: true, result });
            } catch (error) {
              port.postMessage({ ok: false, error: { message: error instanceof Error ? error.message : "Admin tool failed.", ...(error && typeof error === "object" && "body" in error ? { diagnostic: error.body } : {}) } });
            } finally { port.close(); }
          })();
        };
        window.addEventListener("message", onMessage);
        removeBridge = () => window.removeEventListener("message", onMessage);
      }
      if (model?.registerTool) {
        const registration = new AbortController();
        controller.signal.addEventListener("abort", () => registration.abort(), { once: true });
        try {
          for (const tool of tools) {
            controller.signal.throwIfAborted();
            await model.registerTool({ ...tool, execute: async (input, context) => {
              try { return await execute(tool.name, input, context?.signal); }
              catch (error) {
                return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Admin tool failed." }],
                  ...(error && typeof error === "object" && "body" in error ? { structuredContent: { diagnostic: error.body } } : {}) };
              }
            } }, { signal: registration.signal });
          }
          if (!controller.signal.aborted) setCatalog(catalog);
        } catch {
          registration.abort();
          // Browser permission denial must not disable the sandbox host bridge.
          setCatalog(null);
        }
      }
    })().catch(error => {
      if (!controller.signal.aborted) console.error("Admin WebMCP registration failed.", error);
      controller.abort();
      removeBridge();
      setCatalog(null);
    });
    return () => { controller.abort(); removeBridge(); setCatalog(null); };
  }, [navigate]);
  if (!catalog) return null;
  const translatedPrompt = t(language, "webmcp.prompt");
  const prompt = translatedPrompt.match(/^.*?admin_get_context[^.!?。！？]*[.!?。！？]?/u)?.[0] ?? translatedPrompt;
  return <Dialog>
    <DialogTrigger asChild><Button variant="ghost" size="sm" aria-label={t(language, "webmcp.title")}><span className="size-2 rounded-full bg-emerald-500" aria-hidden />WebMCP</Button></DialogTrigger>
    <DialogContent closeLabel={t(language, "common.close")} className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{t(language, "webmcp.title")}</DialogTitle><DialogDescription>WebMCP · {catalog.tools.length}</DialogDescription></DialogHeader>
      <details className="rounded-md border px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">{catalog.tools.length} WebMCP tools</summary>
        <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto border-t pt-2">{catalog.tools.map(tool => <li key={tool.name}><code className="text-xs font-semibold">{tool.name}</code><p className="text-xs text-muted-foreground">{tool.description}</p></li>)}</ul>
      </details>
      <p className="whitespace-pre-wrap rounded-md border bg-muted p-3 text-sm">{prompt}</p>
      <Button variant="outline" onClick={async () => {
        try { await navigator.clipboard.writeText(prompt); toast.success(t(language, "webmcp.copied")); }
        catch { toast.error(t(language, "webmcp.copyFailed")); }
      }}><Copy aria-hidden />{t(language, "webmcp.copy")}</Button>
    </DialogContent>
  </Dialog>;
}
