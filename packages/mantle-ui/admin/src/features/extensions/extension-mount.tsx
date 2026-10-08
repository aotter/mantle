import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AdminExtensionContext, AdminExtensionMounted } from "@aotter/mantle-ui/extension";
import { usePreferences } from "../../app/preferences";
import { useAdminRouter } from "../../app/router";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { extensionApiBase, loadExtensionModule } from "../../lib/extensions";
import type { AdminExtensionInfo, AdminUser } from "../../lib/types";

type Kind = "pages" | "actions" | "panels" | "fields";
/** The per-place part of a renderer's context; Admin adds where the API is, preferences, the caller and `host`. */
export type ExtensionPlace = Pick<AdminExtensionContext, "record" | "selection" | "schema" | "field" | "options" | "onChange">;

/**
 * Renders one contribution: imports the extension's module, calls the renderer for `kind`/`id`, and hands it a context
 * built from Admin's state. A renderer that returns `update` gets later contexts in place; otherwise it mounts again,
 * except for a field value it reported itself. On failure `fallback` (or a short notice) takes its place.
 */
export function ExtensionMount({ extension, kind, id, place, onClose, fallback, className }: {
  extension: AdminExtensionInfo;
  kind: Kind;
  id: string;
  place?: ExtensionPlace;
  onClose?: () => void;
  fallback?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const { language, resolvedTheme } = usePreferences();
  const { navigate } = useAdminRouter();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<AdminUser>("/me") });
  const role = me.data?.role ?? "contributor";
  const element = React.useRef<HTMLDivElement>(null);
  const [failed, setFailed] = React.useState(false);
  const handle = React.useRef<Exclude<AdminExtensionMounted, void> | null>(null);
  const emitted = React.useRef<{ value: unknown } | null>(null);
  const close = React.useRef(onClose);
  close.current = onClose;
  const onChange = place?.onChange;
  const change = React.useRef(onChange);
  change.current = onChange;

  const context = React.useCallback((): AdminExtensionContext => ({
    extension: extension.id,
    contribution: id,
    apiBase: extensionApiBase(extension.id),
    language,
    theme: resolvedTheme,
    caller: { role },
    host: {
      navigate: (path) => { if (typeof path === "string" && path.startsWith("/admin")) navigate(path); },
      notify: (message, kindOf = "info") => { (kindOf === "error" ? toast.error : kindOf === "success" ? toast.success : toast)(String(message)); },
      close: () => close.current?.(),
    },
    ...place,
    ...(onChange ? { onChange: (value: unknown) => { emitted.current = { value }; change.current?.(value); } } : {}),
  }), [extension.id, id, language, resolvedTheme, role, navigate, place, onChange]);

  // everything a renderer sees but the field value, which it may have reported itself
  const rest = JSON.stringify({ language, resolvedTheme, role, ...place, onChange: undefined, field: place?.field ? { ...place.field, value: undefined } : undefined });
  const value = place?.field?.value;
  const [generation, setGeneration] = React.useState(0);
  const latest = React.useRef(context);
  latest.current = context;

  React.useEffect(() => {
    const host = element.current;
    if (!host) return;
    let cancelled = false;
    setFailed(false);
    loadExtensionModule(extension)
      .then(async (module) => {
        const render = module[kind]?.[id];
        if (typeof render !== "function") throw new Error(`no ${kind}.${id} renderer`);
        if (cancelled) return;
        const mounted = await render(host, latest.current());
        if (cancelled) { unmount(mounted); return; }
        handle.current = mounted ?? null;
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(`[mantle admin] extension ${extension.id}/${id} failed`, error);
        setFailed(true);
      });
    return () => {
      cancelled = true;
      const mounted = handle.current ?? undefined;
      handle.current = null;
      // after Admin's own commit: an extension's React root must not unmount while Admin's is rendering
      queueMicrotask(() => {
        unmount(mounted);
        host.replaceChildren();
      });
    };
  }, [extension, kind, id, generation]);

  const previous = React.useRef({ rest, value });
  React.useEffect(() => {
    const before = previous.current;
    previous.current = { rest, value };
    if (before.rest === rest && Object.is(before.value, value)) return;
    // the renderer's own report coming back, consumed once so a later change from elsewhere is never mistaken for it
    const echo = before.rest === rest && emitted.current !== null && Object.is(emitted.current.value, value);
    emitted.current = null;
    const mounted = handle.current;
    // a renderer with `update` always gets the current context, so what it shows is what will be saved
    if (mounted && typeof mounted === "object" && typeof mounted.update === "function") mounted.update(latest.current());
    // without one, its own report needs no remount (which would lose focus); anything else does
    else if (!echo) setGeneration((g) => g + 1);
  }, [rest, value]);

  if (failed) return <>{fallback ?? <p role="alert" className="text-sm text-muted-foreground">{t(language, "extension.failed")}</p>}</>;
  return <div ref={element} className={className} data-extension={`${extension.id}/${id}`} />;
}

function unmount(mounted: AdminExtensionMounted | undefined): void {
  try {
    if (typeof mounted === "function") mounted();
    else if (mounted && typeof mounted.unmount === "function") mounted.unmount();
  } catch (error) {
    console.error("[mantle admin] extension cleanup failed", error);
  }
}
