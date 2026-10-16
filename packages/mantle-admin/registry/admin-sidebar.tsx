/**
 * Surface: browser (Admin's own page only; an MCP host never renders it).
 * Slots: Sidebar
 * Rules: read data only through @aotter/mantle-admin/hooks and link with <AdminLink>. Pass the props you
 * received to `renderDefault`; spread them to change some.
 */
import { AdminLink, type SidebarProps, type SlotProps } from "@aotter/mantle-admin/app";

/** The built-in sidebar with a help link above the signed-in user. */
export function AdminSidebar(props: SlotProps<SidebarProps>) {
  const footer = (
    <>
      {props.footer}
      <AdminLink href="https://example.com/help" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground">Help</AdminLink>
    </>
  );
  return props.renderDefault({ ...props, footer });
}
