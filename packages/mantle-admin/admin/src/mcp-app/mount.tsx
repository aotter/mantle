import { StrictMode, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { applyHostContext, connectHost, type HostApi } from "./postmessage";
import { readCatalog, type ToolResult } from "../../../src/app/bridge";
import type { AdminHost } from "../app/hooks";
import { AdminHooksProvider } from "../app/hooks-context";
import { toolName } from "../app/slots";
import { createMcpAppTransport } from "../app/transport";
import { CustomPage } from "../app/custom-page";
import type { AdminDefinition } from "../app/define-admin";
import { MantleApp } from "./app";
import { appLabels } from "./locale";

declare const __MANTLE_VERSION__: string;

/** Internal: the Admin MCP App's calendar (`@aotter/mantle-admin/build` swaps it for the kit's in this build only). */
export { Calendar } from "./native-date";

/** The host's `tools/call` answers fresh data each time, and a failed call is not retried behind the person's back. */
const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 10_000 } } });

function Root({ admin }: { admin: AdminDefinition }) {
  // the server embeds it once, when it builds the surface
  const catalog = useMemo(() => readCatalog(), []);
  const [client] = useState(newQueryClient);
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
  // a host that sends no theme gets the system's: the same `.dark` class a host theme sets, so tokens and `dark:` follow it
  const hostTheme = context?.theme;
  useEffect(() => {
    if (hostTheme) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)"), root = document.documentElement;
    const follow = () => { root.classList.toggle("dark", query.matches); root.style.colorScheme = query.matches ? "dark" : "light"; };
    follow();
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [hostTheme]);
  const adminHost = useMemo<AdminHost | null>(() => host && {
    context: { ...context }, capabilities: { ...host.capabilities },
    openLink: host.openLink, sendMessage: host.sendMessage, requestDisplayMode: host.requestDisplayMode,
    updateModelContext: params => host.updateModelContext({ ...(params.content ? { content: [...params.content] } : {}), ...(params.structuredContent ? { structuredContent: { ...params.structuredContent } } : {}) }),
  }, [host, context]);
  // the data hooks of the application's components call the host's server tools; without them they read `unavailable`
  const transport = useMemo(() => adminHost && createMcpAppTransport({ ...(host?.call ? { call: host.call } : {}), host: adminHost }), [host, adminHost]);
  const locale = context?.locale;
  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error.message}</p>;
  if (!host || !adminHost || !transport) return <p role="status" className="p-4 text-sm">Connecting to the MCP host…</p>;
  const hostTool = context?.toolInfo?.tool.name;
  // Explicit headers share the browser composition; omitted headers keep existing element-only MCP pages.
  const pages: { [tool: string]: ReactNode } = {};
  for (const page of admin.pages) if (page.mcp) pages[toolName(page.mcp.renders)] ??= <CustomPage page={page} surface="mcp-app" language={locale ?? "en"} />;
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
  return (
    <QueryClientProvider client={client}>
      <AdminHooksProvider meta={admin.meta} transport={transport} layers={admin.layers}>
        {toggle}
        <MantleApp catalog={catalog} host={host} result={result} input={input} cancelled={cancelled} pages={pages} {...(hostTool ? { hostTool } : {})} {...(locale ? { locale } : {})} {...(context?.timeZone ? { timeZone: context.timeZone } : {})} />
      </AdminHooksProvider>
    </QueryClientProvider>
  );
}

/**
 * Internal: what `@aotter/mantle-admin/build`'s `mcp-app.html` runs. It renders the entry's `defineAdmin(...)` for an MCP host:
 * its components in the `mcp-app` surface (slots that render in both), its pages declared with `mcp`, its data hooks through
 * the host's tools.
 */
export function mountMcpApp(admin: AdminDefinition): void {
  createRoot(document.getElementById("root")!).render(<StrictMode><Root admin={admin} /></StrictMode>);
}
