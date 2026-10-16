import * as React from "react";
import type { AdminHost, AdminSurface } from "./hooks";
import { toolName as tool } from "../../../src/app/tool-name";

/** What a slot's component receives: the default's props, and `renderDefault` to render what it replaces. */
export type SlotProps<P> = P & {
  /**
   * The next layer: the built-in component, or the plugin below this one. Pass the props you received (spread them to
   * change some); Admin keeps some state of its own in them.
   */
  readonly renderDefault: (props: P) => React.ReactNode;
};

/** A component for a slot; `X` is what Admin adds for the surface (`surface`, in the slots that render in both). */
export type SlotComponent<P, X extends object = object> = (props: SlotProps<P> & X) => React.ReactNode;

/** The components registered for each slot name, innermost (nearest the built-in) first. */
export type AdminLayers = { readonly [name: string]: readonly SlotComponent<never>[] };

interface SurfaceValue {
  readonly surface: AdminSurface;
  readonly host: AdminHost | null;
  readonly layers: AdminLayers;
}

const SurfaceContext = React.createContext<SurfaceValue | null>(null);

/** Internal: where Admin renders and which components replace the built-in ones. `<MantleAdmin>` and the MCP App provide it. */
export function SurfaceProvider(props: React.PropsWithChildren<SurfaceValue>): React.ReactElement {
  const { surface, host, layers } = props;
  const value = React.useMemo(() => ({ surface, host, layers }), [surface, host, layers]);
  return <SurfaceContext.Provider value={value}>{props.children}</SurfaceContext.Provider>;
}

/** The slots that render in both surfaces get `surface` in their props. */
export const isBothSlot = (name: string): boolean => name === "RecordView" || /^(?:cell|input|record\.aside|record\.actions):/.test(name);

/**
 * Render a built-in component through its slot: the registered layers wrap `Default`, the last one outermost. Several
 * names stack in order, the first nearest `Default`. Without a provider, or without a layer for any name, it is `Default`
 * itself. `Default` must be a stable component.
 */
export function Slot<P extends object>({ name, Default, props }: { name: string | readonly string[]; Default: React.ComponentType<P>; props: P }): React.ReactElement {
  const context = React.useContext(SurfaceContext);
  const names = typeof name === "string" ? [name] : name;
  const layers = context ? names.flatMap(each => context.layers[each] ?? []) : [];
  if (!context || layers.length === 0) return <Default {...props} />;
  const extra = isBothSlot(names[0]!) ? { surface: context.surface } : {};
  const at = (index: number) => (next: P): React.ReactNode => {
    if (index < 0) return <Default {...props} {...next} />;
    const Layer = layers[index] as unknown as React.ComponentType<P & { renderDefault: (props: P) => React.ReactNode }>;
    return <Layer {...next} {...extra} renderDefault={at(index - 1)} />;
  };
  return <>{at(layers.length - 1)(props)}</>;
}

/** The built-in component of a slot that has none: it renders nothing, so an application's component adds to the page. */
export function Empty(): null {
  return null;
}

/** The admin MCP tool of a View or Procedure: its name lowercased, kebab to snake (`mcpToolNameSegment` in @aotter/mantle's compiler). */
export const toolName: (name: string) => string = tool;

/**
 * The slots for one column of a View an MCP App shows. The App knows a View by its tool, and a slot names the View, so the
 * registered `cell:view:` names are matched by their tool name.
 */
export function useViewCellNames(tool: string, column: string): readonly string[] {
  const layers = React.useContext(SurfaceContext)?.layers;
  return React.useMemo(() => Object.keys(layers ?? {}).filter(name => {
    const at = name.lastIndexOf(".");
    return name.startsWith("cell:view:") && name.slice(at + 1) === column && toolName(name.slice("cell:view:".length, at)) === tool;
  }), [layers, tool, column]);
}

/** Where this component renders. Branching on it is allowed; both branches must render. */
export function useSurface(): AdminSurface {
  return React.useContext(SurfaceContext)?.surface ?? "browser";
}

const isWeb = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * Open an http(s) URL outside Admin: a new tab in the browser, `ui/open-link` in an MCP host (which blocks navigation
 * from its sandbox, so never `window.open` or `target="_blank"` in a component that renders there). Resolves false when
 * the URL is not http(s), or an MCP host cannot or refuses to open it (the browser cannot tell, so it resolves true).
 *
 * Surface: both.
 */
export function useOpenLink(): (url: string) => Promise<boolean> {
  const host = React.useContext(SurfaceContext)?.host ?? null;
  return React.useCallback(async (url: string) => {
    if (!isWeb(url)) return false;
    if (host) return host.openLink(url);
    // `noopener` makes window.open return null even when the tab opens, so success cannot be read back
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  }, [host]);
}

/**
 * A link that works in both surfaces. In the browser it is an `<a>` (Admin's router takes same-origin `/admin` paths). In an
 * MCP host an http(s) link opens through the host; any other href, such as an `/admin/...` path, has no origin there, so it
 * renders as plain text.
 *
 * Surface: both.
 */
export function AdminLink({ href, children, onClick, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }): React.ReactElement {
  const host = React.useContext(SurfaceContext)?.host ?? null;
  if (!host) return <a href={href} onClick={onClick} {...rest}>{children}</a>;
  if (!isWeb(href)) return <span>{children}</span>;
  return (
    <a href={href} {...rest} onClick={(event) => { onClick?.(event); if (!event.defaultPrevented) { event.preventDefault(); void host.openLink(href); } }}>
      {children}
    </a>
  );
}
