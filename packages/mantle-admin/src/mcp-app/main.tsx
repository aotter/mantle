import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { applyHostContext, connectHost } from "../app/postmessage.js";
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
  const [call, setCall] = useState<CallTool | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => connectHost({
    ready: (call, context) => { setContext(context); setCall(() => call); },
    input: setInput,
    result: (value) => { setCancelled(false); setResult(value); },
    cancelled: () => setCancelled(true),
    context: (value) => setContext(current => ({ ...current, ...value })),
    error: setError,
  }), []);
  useEffect(() => { if (context) applyHostContext(context); }, [context]);
  const locale = context?.locale;
  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error.message}</p>;
  if (!call) return null;
  const hostTool = context?.toolInfo?.tool.name;
  return <MantleApp catalog={catalog} call={call} result={result} input={input} cancelled={cancelled} {...(hostTool ? { hostTool } : {})} {...(locale ? { locale } : {})} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
