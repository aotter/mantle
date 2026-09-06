import * as React from "react";
import { ChevronsUpDown, LogOut, Settings, Unplug } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { usePreferences } from "@/app/preferences";
import { t } from "@/app/i18n";
import { signOut } from "@/lib/auth";
import { initialsFor } from "@/lib/initials";

export interface NavUserProps {
  login: string | null;
  image: string | null;
  role: "owner" | "editor" | "contributor" | null;
}

export function NavUser({ login, image, role }: NavUserProps): React.ReactElement {
  const { isMobile } = useSidebar();
  const { language } = usePreferences();
  const initials = initialsFor(login);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
              <UserAvatar src={image} fallback={initials} />
              <div className="grid min-w-0 flex-1 text-start text-sm leading-tight">
                <span className="truncate font-medium">{login ?? t(language, "common.signedIn")}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {role ?? t(language, "common.signedIn")}
                </span>
              </div>
              <ChevronsUpDown className="ms-auto" aria-hidden />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
          >
            <DropdownMenuLabel className="flex items-center gap-2">
              <UserAvatar src={image} fallback={initials} />
              <div className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate font-medium">{login ?? t(language, "common.signedIn")}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {role ?? t(language, "common.signedIn")}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href="/admin/preferences">
                <Settings aria-hidden />
                {t(language, "preferences.page.open")}
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href="/oauth/consents">
                <Unplug aria-hidden />
                {t(language, "oauth.connectedApps")}
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => signOut()}>
              <LogOut aria-hidden />
              {t(language, "common.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function UserAvatar({ src, fallback }: { src: string | null; fallback: string }): React.ReactElement {
  return (
    <Avatar className="size-8 rounded-lg">
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback className="rounded-lg">{fallback}</AvatarFallback>
    </Avatar>
  );
}
