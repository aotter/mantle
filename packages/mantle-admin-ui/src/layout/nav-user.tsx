import * as React from "react";
import { ChevronsUpDown, LogOut, Settings, Unplug } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@aotter/mantle-ui/kit";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aotter/mantle-ui/kit";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@aotter/mantle-ui/kit";
import { usePreferences } from "@/app/preferences";
import { t } from "@/app/i18n";
import { signOut } from "@/lib/auth";
import { initialsFor } from "@/lib/initials";
import { isAdminPreview } from "@/app/frame-policy";

export interface NavUserProps {
  login: string | null;
  image: string | null;
  role: "owner" | "editor" | "contributor" | null;
}

export function NavUser({ login, image, role }: NavUserProps): React.ReactElement {
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
            align="start"
            side="top"
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
            {!isAdminPreview() ? <><DropdownMenuItem asChild>
              <a href="/admin/connected-apps">
                <Unplug aria-hidden />
                {t(language, "oauth.connectedApps")}
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => signOut()}>
              <LogOut aria-hidden />
              {t(language, "common.signOut")}
            </DropdownMenuItem>
            </> : null}
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
