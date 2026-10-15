import * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  SidebarTrigger,
} from "@aotter/mantle-ui/kit";
import { usePreferences } from "../app/preferences";
import { t } from "../app/i18n";
import { Slot } from "../app/slots";
import { useAdminLocation } from "../app/router";
import { AppTitle } from "./app-title";
import { NavGroup } from "./nav-group";
import { NavUser } from "./nav-user";
import { useShell } from "./shell-context";
import type { SidebarProps } from "../app/slot-props";

export function AppSidebar({ brand, groups, footer }: SidebarProps): React.ReactElement {
  const { direction, language } = usePreferences();
  const location = useAdminLocation();
  const { user } = useShell();
  // the workspace entry is the overview flow
  const pathname = location.pathname === "/admin/dev" ? "/admin/dev/overview/flow" : location.pathname;
  const search = location.search;
  return (
    <Sidebar
      side={direction === "rtl" ? "right" : "left"}
      collapsible="icon"
      dir={direction}
      mobileTitle={t(language, "common.mobileSidebar")}
      mobileDescription={t(language, "common.mobileSidebarDescription")}
      closeLabel={t(language, "common.close")}
    >
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-2 py-0">
        <div className="flex min-w-0 items-center gap-1">
          <Slot name="Brand" Default={AppTitle} props={brand} />
          <SidebarTrigger
            className="shrink-0 group-data-[collapsible=icon]:mx-auto"
            aria-label={t(language, "common.toggleSidebar")}
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {groups.filter((group) => group.items.length > 0).map((group, idx) => (
          <NavGroup
            key={group.title ?? `g-${idx}`}
            group={group}
            pathname={pathname}
            search={search}
          />
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        {footer}
        <NavUser login={user.login} image={user.image} role={user.role} />
      </SidebarFooter>
      <SidebarRail aria-label={t(language, "common.toggleSidebar")} />
    </Sidebar>
  );
}
