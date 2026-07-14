import * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarSeparator,
  SidebarTrigger,
} from "../ui/sidebar";
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
  user: { login: string | null; role: "owner" | "editor" | "contributor" | null };
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
    <Sidebar side={direction === "rtl" ? "right" : "left"}>
      <SidebarHeader>
        <div className="sidebar-chrome-row">
          <AppTitle brand={brand} />
          <SidebarTrigger />
        </div>
      </SidebarHeader>
      <SidebarSeparator />
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
      <SidebarSeparator />
      <SidebarFooter>
        <NavUser login={user.login} role={user.role} />
      </SidebarFooter>
    </Sidebar>
  );
}
