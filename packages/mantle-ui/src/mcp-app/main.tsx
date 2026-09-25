import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { InteractionApp } from "./app.js";
import type { CallTool, ToolResult } from "./bridge.js";
import "./styles.css";

function Root() {
  const [result, setResult] = useState<ToolResult | null>(null);
  const [input, setInput] = useState<Record<string, unknown> | null>(null);
  const { app, error } = useApp({
    appInfo: { name: "mantle-interaction", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (created) => {
      created.ontoolinput = (params) => setInput(params.arguments ?? {});
      created.ontoolresult = (params) => setResult(params as ToolResult);
    },
  });
  useHostStyles(app, app?.getHostContext());
  const call = useMemo<CallTool | null>(() => app
    ? (name, args, signal) => app.callServerTool({ name, arguments: args }, signal ? { signal } : undefined) as Promise<ToolResult>
    : null, [app]);
  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error.message}</p>;
  if (!call) return null;
  return <InteractionApp call={call} result={result} input={input} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
