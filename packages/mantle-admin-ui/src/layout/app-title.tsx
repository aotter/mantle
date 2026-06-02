import * as React from "react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { AotterMantleMark } from "../brand/aotter-mantle";
import { usePreferences } from "../app/preferences";
import { t } from "../app/i18n";
import type { AdminBrand } from "./types";

interface AppTitleProps {
  brand: AdminBrand;
}

export function AppTitle({ brand }: AppTitleProps): React.ReactElement {
  const { setOpenMobile } = useSidebar();
  const { language } = usePreferences();
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
            <span className="bg-primary/10 text-primary flex aspect-square size-8 items-center justify-center rounded-lg ring-1 ring-border">
              <AotterMantleMark className="size-5" />
            </span>
            <div data-sidebar-label className="grid flex-1 text-start text-sm leading-tight">
              <span className="truncate font-semibold">{t(language, "admin.consoleTitle")}</span>
            </div>
          </a>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
