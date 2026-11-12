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

/** Internal: the Admin MCP App's calendar, select and popover (`@aotter/mantle-admin/build` swaps them for the kit's in this build only). */
export { Calendar } from "./native-date";
export {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./native-fields";

/** The host's `tools/call` answers fresh data each time, and a failed call is not retried behind the person's back. */
const newQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 10_000 } } });

type HostHandlers = Parameters<typeof connectHost>[0];

/**
 * Connects to the host now, before React renders, so `ui/notifications/initialized` goes out as early as it can (a view
 * replacing a full-screen one has 15 seconds on Claude). What the host sends waits, in order, for `listen`.
 */
function connectNow(): (handlers: HostHandlers) => void {
  const queue: (readonly [keyof HostHandlers, unknown[]])[] = [];
  let target: HostHandlers | undefined;
  const relay =
    (name: keyof HostHandlers) =>
    (...args: unknown[]) =>
      target ? (target[name] as (...args: unknown[]) => void)(...args) : void queue.push([name, args]);
  connectHost(
    {
      ready: relay("ready"),
      input: relay("input"),
      result: relay("result"),
      cancelled: relay("cancelled"),
      context: relay("context"),
      error: relay("error"),
    },
    window,
    __MANTLE_VERSION__,
  );
  return handlers => {
    target = handlers;
    for (const [name, args] of queue.splice(0)) (handlers[name] as (...args: unknown[]) => void)(...args);
  };
}

function Root({ admin, listen }: { admin: AdminDefinition; listen: (handlers: HostHandlers) => void }) {
  // the server embeds it once, when it builds the surface
  const catalog = useMemo(() => readCatalog(), []);
  const [client] = useState(newQueryClient);
  const [result, setResult] = useState<ToolResult | null>(null);
  const [input, setInput] = useState<Record<string, unknown> | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [context, setContext] = useState<McpUiHostContext | undefined>(undefined);
  const [host, setHost] = useState<HostApi | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // the host answered a display mode request with the mode the App had
  const [refused, setRefused] = useState(false);
  // In the conversation the App fits its content and opens what exceeds the host's cap in full screen. Without full
  // screen (not offered, or refused once) it scrolls inside its frame instead, so no row or form is out of reach.
  const [scroll, setScroll] = useState(false);
  useEffect(
    () =>
      listen({
        ready: (host, context) => {
          setContext(context);
          setHost(host);
        },
        input: setInput,
        result: value => {
          setCancelled(false);
          setResult(value);
        },
        cancelled: () => setCancelled(true),
        context: value => setContext(current => ({ ...current, ...value })),
        error: setError,
      }),
    [listen],
  );
  useEffect(() => {
    if (context)
      applyHostContext(context, document, {
        scroll: scroll || !context.availableDisplayModes?.includes("fullscreen"),
      });
  }, [context, scroll]);
  // a host that sends no theme gets the system's: the same `.dark` class a host theme sets, so tokens and `dark:` follow it
  const hostTheme = context?.theme;
  useEffect(() => {
    if (hostTheme) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)"),
      root = document.documentElement;
    const follow = () => {
      root.classList.toggle("dark", query.matches);
      root.style.colorScheme = query.matches ? "dark" : "light";
    };
    follow();
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [hostTheme]);
  const adminHost = useMemo<AdminHost | null>(
    () =>
      host && {
        context: { ...context },
        capabilities: { ...host.capabilities },
        openLink: host.openLink,
        sendMessage: host.sendMessage,
        requestDisplayMode: host.requestDisplayMode,
        downloadFile: host.downloadFile,
        registerTools: host.registerTools,
        updateModelContext: params =>
          host.updateModelContext({
            ...(params.content ? { content: [...params.content] } : {}),
            ...(params.structuredContent ? { structuredContent: { ...params.structuredContent } } : {}),
          }),
      },
    [host, context],
  );
  // the data hooks of the application's components call the host's server tools; without them they read `unavailable`
  const transport = useMemo(
    () => adminHost && createMcpAppTransport({ ...(host?.call ? { call: host.call } : {}), host: adminHost }),
    [host, adminHost],
  );
  const locale = context?.locale;
  if (error)
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        {error.message}
      </p>
    );
  if (!host || !adminHost || !transport)
    return (
      <p role="status" className="p-4 text-sm">
        Connecting to the MCP host…
      </p>
    );
  const hostTool = context?.toolInfo?.tool.name;
  // Explicit headers share the browser composition; omitted headers keep existing element-only MCP pages.
  const pages: { [tool: string]: ReactNode } = {};
  for (const page of admin.pages)
    if (page.mcp)
      pages[toolName(page.mcp.renders)] ??= <CustomPage page={page} surface="mcp-app" language={locale ?? "en"} />;
  const labels = appLabels(locale);
  // Sent inside the click: Claude refuses a request without a recent click or key press. A refusal answers the mode
  // the App has, so only the mode asked for is a grant.
  const request = (mode: "inline" | "fullscreen") => {
    void host.requestDisplayMode(mode).then(granted => {
      setRefused(granted !== mode);
      if (granted === mode) setContext(current => ({ ...current, displayMode: mode }));
      else if (mode === "fullscreen") setScroll(true);
    });
  };
  // in the conversation, while full screen may open: a row action asks for it, and rows past the host's cap open it
  const expand =
    !scroll && context?.displayMode !== "fullscreen" && context?.availableDisplayModes?.includes("fullscreen")
      ? () => request("fullscreen")
      : undefined;
  const box = context?.containerDimensions as { readonly height?: number; readonly maxHeight?: number } | undefined;
  const maxHeight = expand && box?.height === undefined ? box?.maxHeight : undefined;
  // a long form or many columns: the person may ask the host for the whole screen, when it offers one. `fullscreen` is
  // the side panel too, so the way back names the conversation
  const next = context?.displayMode === "fullscreen" ? "inline" : "fullscreen";
  const toggle = context?.availableDisplayModes?.includes("fullscreen") ? (
    <div className="flex flex-wrap items-center justify-end gap-2 px-3 pt-3">
      <span role="status" className="text-muted-foreground text-xs">
        {refused ? labels.displayRefused : null}
      </span>
      <button type="button" className="rounded-md border px-3 py-1 text-xs" onClick={() => request(next)}>
        {next === "fullscreen" ? labels.fullscreen : labels.toConversation}
      </button>
    </div>
  ) : null;
  return (
    <QueryClientProvider client={client}>
      <AdminHooksProvider meta={admin.meta} transport={transport} layers={admin.layers}>
        {toggle}
        <MantleApp
          catalog={catalog}
          host={host}
          result={result}
          input={input}
          cancelled={cancelled}
          pages={pages}
          {...(expand ? { expand } : {})}
          {...(maxHeight ? { maxHeight } : {})}
          {...(hostTool ? { hostTool } : {})}
          {...(locale ? { locale } : {})}
          {...(context?.timeZone ? { timeZone: context.timeZone } : {})}
        />
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
  const listen = connectNow();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root admin={admin} listen={listen} />
    </StrictMode>,
  );
}
