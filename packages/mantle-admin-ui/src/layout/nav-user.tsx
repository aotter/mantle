import * as React from "react";
import { ChevronsUpDown, LogOut, Settings } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { cn } from "../lib/utils";
import { signOut } from "../lib/auth";
import { usePreferences } from "../app/preferences";
import { t } from "../app/i18n";

export interface NavUserProps {
  login: string | null;
  role: "owner" | "editor" | "contributor" | null;
}

export function NavUser({ login, role }: NavUserProps): React.ReactElement {
  const { isMobile } = useSidebar();
  const { language } = usePreferences();
  const initial = (login ?? "?").charAt(0).toUpperCase();
  const avatarUrl = login
    ? `https://github.com/${encodeURIComponent(login)}.png?size=80`
    : null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-accent/40"
            >
              <Avatar avatarUrl={avatarUrl} initial={initial} />
              <div data-sidebar-label className="grid flex-1 text-start text-sm leading-tight">
                <span className="truncate font-semibold">{login ?? "—"}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {role ?? t(language, "common.signedIn")}
                </span>
              </div>
              <ChevronsUpDown
                data-sidebar-label
                className="ms-auto size-4 text-muted-foreground"
                aria-hidden
              />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side={isMobile ? "bottom" : "right"}
            sideOffset={6}
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
          >
            <DropdownMenuLabel className="flex items-center gap-3 py-2">
              <Avatar avatarUrl={avatarUrl} initial={initial} large />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {login ?? "—"}
                </span>
                <span className="label-eyebrow truncate">
                  {role ?? t(language, "common.signedIn")}
                </span>
              </div>
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            <DropdownMenuItem asChild>
              <a href="/admin/preferences" className="flex items-center gap-2">
                <Settings className="size-4" aria-hidden />
                {t(language, "preferences.page.open")}
              </a>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem
              asChild
              className="text-destructive focus:text-destructive focus:bg-destructive/10"
            >
              <button
                type="button"
                onClick={signOut}
                className="flex w-full cursor-pointer items-center gap-2"
              >
                <LogOut className="size-4" aria-hidden />
                {t(language, "common.signOut")}
              </button>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function Avatar({
  avatarUrl,
  initial,
  large = false,
}: {
  avatarUrl: string | null;
  initial: string;
  large?: boolean;
}): React.ReactElement {
  const size = large ? "size-9" : "size-8";
  const text = large ? "text-sm" : "text-xs";
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center justify-center rounded-lg",
        "bg-primary/15 text-foreground/80 ring-1 ring-border",
        size,
      )}
      aria-hidden
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          className="size-full rounded-lg object-cover"
          decoding="async"
        />
      ) : (
        <span className={cn("font-medium", text)}>{initial}</span>
      )}
    </span>
  );
}
