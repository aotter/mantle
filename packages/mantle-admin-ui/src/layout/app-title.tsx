import * as React from "react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initialsFor } from "@/lib/initials";
import type { AdminBrand } from "./types";

interface AppTitleProps {
  brand: AdminBrand;
}

export function AppTitle({ brand }: AppTitleProps): React.ReactElement {
  const { setOpenMobile } = useSidebar();
  const href = brand.href ?? "/admin";
  return (
    <SidebarMenu className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          className="p-1"
        >
          <a href={href} onClick={() => setOpenMobile(false)}>
            <Avatar className="size-7 rounded-md">
              {brand.image ? <AvatarImage src={brand.image} alt="" /> : null}
              <AvatarFallback className="rounded-md text-xs">
                {initialsFor(brand.title)}
              </AvatarFallback>
            </Avatar>
            <span className="truncate font-semibold">{brand.title}</span>
          </a>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
