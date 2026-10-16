/**
 * Surface: both (the browser, and the Admin MCP App in an MCP host's sandboxed iframe).
 * Slots: cell:<schema>.<field>, cell:view:<view>.<column>
 * Rules: read data only through @aotter/mantle-admin/hooks, link only with <AdminLink> or useOpenLink(), make no
 * network calls of your own, keep no auth in cookies or browser storage, open no windows, assume no width, load
 * nothing from a remote origin. Branch on `surface` if you must; both branches have to render.
 */
import { AdminLink, type CellProps, type SurfaceProp } from "@aotter/mantle-admin/app";

const isWeb = (text: string): boolean => /^https?:\/\//i.test(text);

/** One value in a list or report: a pill for text, a link for a web address. Narrow `CellProps` to your field's type. */
export function AdminCell({ value }: CellProps<unknown, object> & SurfaceProp) {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">-</span>;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (isWeb(text)) return <AdminLink href={text} className="text-primary underline-offset-4 hover:underline">{text}</AdminLink>;
  return <span className="inline-block max-w-full truncate rounded-md bg-muted px-2 py-0.5 text-xs font-medium">{text}</span>;
}
