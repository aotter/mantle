import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { MantleApp } from "./app.js";
import { readCatalog, type CallTool, type ToolResult } from "../app/bridge.js";
import "./styles.css";

// the server embeds it once, when it builds the surface
const catalog = readCatalog();

function Root() {
  const [result, setResult] = useState<ToolResult | null>(null);
  const [input, setInput] = useState<Record<string, unknown> | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [context, setContext] = useState<McpUiHostContext | undefined>(undefined);
  const { app, error } = useApp({
    appInfo: { name: "mantle", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (created) => {
      created.ontoolinput = (params) => setInput(params.arguments ?? {});
      created.ontoolresult = (params) => { setCancelled(false); setResult(params as ToolResult); };
      created.ontoolcancelled = () => setCancelled(true);
      created.onhostcontextchanged = (params) => setContext((current) => ({ ...current, ...params }));
    },
  });
  useHostStyles(app, app?.getHostContext());
  useEffect(() => { if (app) setContext(app.getHostContext()); }, [app]);
  const locale = context?.locale;
  useEffect(() => { if (locale) document.documentElement.lang = locale; }, [locale]);
  const call = useMemo<CallTool | null>(() => app
    ? (name, args, signal) => app.callServerTool({ name, arguments: args }, signal ? { signal } : undefined) as Promise<ToolResult>
    : null, [app]);
  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error.message}</p>;
  if (!call) return null;
  const hostTool = context?.toolInfo?.tool.name;
  return <MantleApp catalog={catalog} call={call} result={result} input={input} cancelled={cancelled} {...(hostTool ? { hostTool } : {})} {...(locale ? { locale } : {})} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
