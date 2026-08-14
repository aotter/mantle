import * as React from "react";
import { ExternalLink } from "lucide-react";

import { useAdminLocation } from "@/app/router";
import { usePreferences } from "@/app/preferences";
import { t } from "@/app/i18n";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fieldLabel } from "@/lib/field-label";
import type { AdminBrand } from "./types";
import {
  LanguagePreferenceDropdown,
  ThemePreferenceDropdown,
} from "./preference-controls";

interface HeaderProps {
  className?: string;
  site?: AdminBrand;
  publicUrl?: string;
  pageTitle?: string;
}

export function Header({
  className,
  site,
  publicUrl,
  pageTitle,
}: HeaderProps): React.ReactElement {
  const { pathname } = useAdminLocation();
  const { language } = usePreferences();
  const current = pageTitle ?? currentPage(pathname, language);

  return (
    <header
      data-slot="app-header"
      className={cn(
        "flex h-14 shrink-0 items-center gap-2 border-b px-4",
        className,
      )}
    >
      <SidebarTrigger className="-ms-1 md:hidden" aria-label={t(language, "common.toggleSidebar")} />
      <Breadcrumb className="min-w-0" aria-label={t(language, "common.breadcrumb")}>
        <BreadcrumbList className="flex-nowrap">
          <BreadcrumbItem className="hidden sm:block">
            <BreadcrumbLink href="/admin">{site?.title ?? t(language, "admin.consoleTitle")}</BreadcrumbLink>
          </BreadcrumbItem>
          {current ? (
            <>
              <BreadcrumbSeparator className="hidden sm:block" />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">{current}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ms-auto flex shrink-0 items-center gap-1">
        {publicUrl ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon-sm">
                <a
                  href={publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t(language, "common.viewSite")}
                >
                  <ExternalLink aria-hidden />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t(language, "common.viewSite")}</TooltipContent>
          </Tooltip>
        ) : null}
        <LanguagePreferenceDropdown compact />
        <ThemePreferenceDropdown compact />
      </div>
    </header>
  );
}

function currentPage(pathname: string, language: ReturnType<typeof usePreferences>["language"]): string | null {
  if (pathname === "/admin" || pathname === "/admin/") return null;
  const collectionMatch = pathname.match(/^\/admin\/c\/([^/]+)/);
  if (collectionMatch) return fieldLabel(decodeURIComponent(collectionMatch[1]!));
  const parts = pathname.split("/").filter(Boolean);
  const segment = decodeURIComponent(parts[parts.length - 1] ?? "");
  if (pathname === "/admin/media") return t(language, "nav.media");
  if (pathname === "/admin/settings") return t(language, "nav.settings");
  if (pathname === "/admin/staff") return t(language, "nav.staff");
  if (pathname === "/admin/members") return t(language, "nav.members");
  return segment ? fieldLabel(segment) : null;
}
