import * as React from "react";
import { LogOut, Settings } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import { signOut } from "../lib/auth";
import { usePreferences } from "../app/preferences";
import { t } from "../app/i18n";

/**
 * Compact avatar-only profile dropdown for the top-right of the
 * Header. Mirrors satnaing's `<ProfileDropdown>` shape — the larger
 * NavUser in the sidebar footer carries the full identity card; this
 * one is the always-visible escape hatch for account-level actions.
 *
 * The Avatar helper is duplicated with NavUser by design at v0.1 —
 * the two components have different ergonomic constraints (size,
 * alignment).
 */
export interface ProfileDropdownProps {
  login: string | null;
  role: "owner" | "editor" | "contributor" | null;
}

export function ProfileDropdown({
  login,
  role,
}: ProfileDropdownProps): React.ReactElement {
  const { language } = usePreferences();
  const initial = (login ?? "?").charAt(0).toUpperCase();
  const avatarUrl = login
    ? `https://github.com/${encodeURIComponent(login)}.png?size=80`
    : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className={cn(
          "relative inline-flex size-8 items-center justify-center rounded-full",
          "outline-hidden ring-1 ring-border",
          "hover:ring-primary/40 transition-all",
          "data-[state=open]:ring-primary",
        )}
      >
        <Avatar avatarUrl={avatarUrl} initial={initial} />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={6} className="w-56">
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
        "shrink-0 inline-flex items-center justify-center rounded-full overflow-hidden",
        "bg-primary/15 text-foreground/80",
        size,
      )}
      aria-hidden
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          className="size-full object-cover"
          decoding="async"
        />
      ) : (
        <span className={cn("font-medium", text)}>{initial}</span>
      )}
    </span>
  );
}
