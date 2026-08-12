import * as React from "react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { AotterMantleMark } from "../brand/aotter-mantle";
import type { AdminBrand } from "./types";

interface AppTitleProps {
  brand: AdminBrand;
}

export function AppTitle({ brand }: AppTitleProps): React.ReactElement {
  const { setOpenMobile } = useSidebar();
  const href = brand.href ?? "/admin";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          size="lg"
          className="data-[slot=sidebar-menu-button]:!p-1.5"
        >
          <a href={href} onClick={() => setOpenMobile(false)}>
            <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <AotterMantleMark className="size-5" />
            </span>
            <div data-sidebar-label className="grid flex-1 text-start text-sm leading-tight">
              <span className="truncate font-semibold">{brand.title}</span>
              {brand.subtitle ? (
                <span className="truncate text-xs text-muted-foreground">{brand.subtitle}</span>
              ) : null}
            </div>
          </a>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
