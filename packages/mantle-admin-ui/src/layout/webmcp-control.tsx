import * as React from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { useAdminRouter } from "../app/router";
import { usePreferences } from "../app/preferences";
import { t } from "../app/i18n";
import { queryClient } from "../app/query-client";
import { isAdminPreview } from "../app/frame-policy";
import { api } from "../lib/api";
import { adminPath, callStaffTool, navigationTools, resultPath, type AdminModelContext, type AdminToolCatalog } from "../lib/admin-tools";
import { Button } from "../components/ui/button";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../components/ui/dialog";

export function WebMcpControl(): React.ReactElement | null {
  const { navigate } = useAdminRouter();
  const { language } = usePreferences();
  const [available, setAvailable] = React.useState(false);
  React.useEffect(() => {
    const controller = new AbortController();
    const model = (document as Document & { modelContext?: AdminModelContext }).modelContext;
    if (!model?.registerTool && !isAdminPreview()) return;
    let removeBridge = () => {};
    void (async () => {
      const catalog = await api.get<AdminToolCatalog>("/webmcp");
      if (controller.signal.aborted) return;
      const tools = [...catalog.tools, ...navigationTools];
      if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("Admin navigation tool name collision.");
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
        const path = resultPath(catalog, name, output, input);
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
          if (!controller.signal.aborted) setAvailable(true);
        } catch {
          registration.abort();
          // Browser permission denial must not disable the sandbox host bridge.
          setAvailable(false);
        }
      }
    })().catch(error => {
      if (!controller.signal.aborted) console.error("Admin WebMCP registration failed.", error);
      controller.abort();
      removeBridge();
      setAvailable(false);
    });
    return () => { controller.abort(); removeBridge(); setAvailable(false); };
  }, [navigate]);
  if (!available) return null;
  const prompt = t(language, "webmcp.prompt");
  return <Dialog>
    <DialogTrigger asChild><Button variant="ghost" size="sm" aria-label={t(language, "webmcp.title")}><span className="size-2 rounded-full bg-emerald-500" aria-hidden />WebMCP</Button></DialogTrigger>
    <DialogContent closeLabel={t(language, "common.close")} className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{t(language, "webmcp.title")}</DialogTitle><DialogDescription>{t(language, "webmcp.description")}</DialogDescription></DialogHeader>
      <p className="whitespace-pre-wrap rounded-md border bg-muted p-3 text-sm">{prompt}</p>
      <Button variant="outline" onClick={async () => {
        try { await navigator.clipboard.writeText(prompt); toast.success(t(language, "webmcp.copied")); }
        catch { toast.error(t(language, "webmcp.copyFailed")); }
      }}><Copy aria-hidden />{t(language, "webmcp.copy")}</Button>
    </DialogContent>
  </Dialog>;
}
