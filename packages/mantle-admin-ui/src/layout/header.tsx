import * as React from "react";
import { CircleHelp, ExternalLink } from "lucide-react";
import { ProfileDropdown } from "./profile-dropdown";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { usePreferences } from "../app/preferences";
import { t } from "../app/i18n";
import type { AdminBrand } from "./types";
import { SidebarTrigger } from "../ui/sidebar";
import {
  LanguagePreferenceDropdown,
  ThemePreferenceDropdown,
} from "./preference-controls";

interface HeaderProps {
  fixed?: boolean;
  className?: string;
  /** Toolbar items rendered between the sidebar trigger and the
   *  trailing ProfileDropdown — `me-auto` on the first child pushes
   *  the dropdown to the far right (mirrors satnaing's pattern of
   *  `<TopNav className="me-auto" /> <Search /> <ProfileDropdown />`). */
  children?: React.ReactNode;
  /** Identity for the trailing ProfileDropdown. `null`s render the
   *  initial-fallback avatar. */
  user?: {
    login: string | null;
    role: "owner" | "editor" | "contributor" | null;
  };
  site?: AdminBrand;
  publicUrl?: string;
  onOpenGuide?: () => void;
}

export function Header({
  fixed = false,
  className,
  children,
  user,
  site,
  publicUrl,
  onOpenGuide,
}: HeaderProps): React.ReactElement {
  const { language } = usePreferences();
  const [scrolled, setScrolled] = React.useState(false);
  React.useEffect(() => {
    if (!fixed) return;
    const onScroll = () => setScrolled(window.scrollY > 10);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [fixed]);

  return (
    <header
      data-slot="header"
      data-scrolled={scrolled || undefined}
      className={cn(
        "admin-statusbar z-20 flex h-14 shrink-0 items-center gap-3 px-4",
        fixed
          ? "sticky top-0 w-[inherit] transition-shadow"
          : "border-b border-border/40",
        scrolled && "shadow-sm",
        className,
      )}
    >
      {/* Mobile-only entry to the off-canvas sidebar. On md+ the sidebar
          is docked and carries its own collapse trigger in its header, so
          this stays hidden there to avoid two triggers side by side. */}
      <SidebarTrigger className="-ms-1 md:hidden" />
      {site ? (
        <div className="admin-site-status" aria-label="Current admin site">
          <span>{site.title}</span>
          {site.subtitle ? <small>{site.subtitle}</small> : null}
        </div>
      ) : null}
      {publicUrl ? (
        <Button asChild variant="secondary" size="sm" className="shrink-0">
          <a href={publicUrl} target="_blank" rel="noreferrer" title={t(language, "common.viewSite")}>
            <ExternalLink className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">{t(language, "common.viewSite")}</span>
          </a>
        </Button>
      ) : null}
      {children}
      {user ? (
        // `flex items-center` on the wrapper kills the inline-flex
        // baseline descent gap — without it the wrap div is taller
        // than the trigger by ~8px (line-height carry) and the
        // avatar lands above center.
        <div
          className={cn(
            "flex items-center gap-2",
            children ? "" : "ms-auto",
          )}
        >
          {onOpenGuide ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onOpenGuide}
              data-tour="guide-button"
              title={t(language, "guide.open")}
              aria-label={t(language, "guide.open")}
            >
              <CircleHelp className="size-4" aria-hidden />
              <span className="hidden sm:inline">{t(language, "guide.open")}</span>
            </Button>
          ) : null}
          <LanguagePreferenceDropdown />
          <ThemePreferenceDropdown />
          <ProfileDropdown login={user.login} role={user.role} />
        </div>
      ) : null}
    </header>
  );
}
