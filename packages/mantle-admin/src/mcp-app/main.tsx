import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AdminHost } from "../../admin/src/app/hooks.js";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { applyHostContext, connectHost, type HostApi } from "../app/postmessage.js";
import { MantleApp } from "./app.js";
import { SurfaceProvider, type AdminLayers } from "../../admin/src/app/slots.js";
import { appLabels } from "./locale.js";
import { readCatalog, type ToolResult } from "../app/bridge.js";
import "./styles.css";

declare const __MANTLE_VERSION__: string;

// the server embeds it once, when it builds the surface
const catalog = readCatalog();
// the prebuilt App renders Admin's own components; an application's overrides arrive when the App is built from its entry
const NO_LAYERS: AdminLayers = {};

function Root() {
  const [result, setResult] = useState<ToolResult | null>(null);
  const [input, setInput] = useState<Record<string, unknown> | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [context, setContext] = useState<McpUiHostContext | undefined>(undefined);
  const [host, setHost] = useState<HostApi | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => connectHost({
    ready: (host, context) => { setContext(context); setHost(host); },
    input: setInput,
    result: (value) => { setCancelled(false); setResult(value); },
    cancelled: () => setCancelled(true),
    context: (value) => setContext(current => ({ ...current, ...value })),
    error: setError,
  }, window, __MANTLE_VERSION__), []);
  useEffect(() => { if (context) applyHostContext(context); }, [context]);
  const adminHost = useMemo<AdminHost | null>(() => host && {
    context: { ...context }, capabilities: { ...host.capabilities },
    openLink: host.openLink, sendMessage: host.sendMessage, requestDisplayMode: host.requestDisplayMode,
    updateModelContext: params => host.updateModelContext({ ...(params.content ? { content: [...params.content] } : {}), ...(params.structuredContent ? { structuredContent: { ...params.structuredContent } } : {}) }),
  }, [host, context]);
  const locale = context?.locale;
  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error.message}</p>;
  if (!host || !adminHost) return null;
  const hostTool = context?.toolInfo?.tool.name;
  const labels = appLabels(locale);
  // a long form or many columns: the person may ask the host for the whole screen, when it offers one
  const next = context?.displayMode === "fullscreen" ? "inline" : "fullscreen";
  const toggle = context?.availableDisplayModes?.includes("fullscreen") ? (
    <div className="flex justify-end px-3 pt-3">
      <button type="button" className="rounded-md border px-3 py-1 text-xs" onClick={() => { void host.requestDisplayMode(next).then(mode => { if (mode) setContext(current => ({ ...current, displayMode: mode })); }); }}>
        {next === "fullscreen" ? labels.fullscreen : labels.exitFullscreen}
      </button>
    </div>
  ) : null;
  return <SurfaceProvider surface="mcp-app" host={adminHost} layers={NO_LAYERS}>{toggle}<MantleApp catalog={catalog} host={host} result={result} input={input} cancelled={cancelled} {...(hostTool ? { hostTool } : {})} {...(locale ? { locale } : {})} {...(context?.timeZone ? { timeZone: context.timeZone } : {})} /></SurfaceProvider>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
