import * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { usePreferences } from "../app/preferences";
import { AppTitle } from "./app-title";
import { NavGroup } from "./nav-group";
import { NavUser } from "./nav-user";
import type { AdminBrand, NavGroupData } from "./types";

interface AppSidebarProps {
  brand: AdminBrand;
  groups: ReadonlyArray<NavGroupData>;
  pathname: string;
  search: string;
  user: {
    login: string | null;
    image: string | null;
    role: "owner" | "editor" | "contributor" | null;
  };
}

export function AppSidebar({
  brand,
  groups,
  pathname,
  search,
  user,
}: AppSidebarProps): React.ReactElement {
  const { direction } = usePreferences();
  return (
    <Sidebar
      side={direction === "rtl" ? "right" : "left"}
      collapsible="icon"
      dir={direction}
    >
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-2 py-0">
        <div className="flex min-w-0 items-center gap-1">
          <AppTitle brand={brand} />
          <SidebarTrigger className="shrink-0 group-data-[collapsible=icon]:mx-auto" />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((group, idx) => (
          <NavGroup
            key={group.title ?? `g-${idx}`}
            group={group}
            pathname={pathname}
            search={search}
          />
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <NavUser login={user.login} image={user.image} role={user.role} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
