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
import { cn } from "@/lib/utils";
import { fieldLabel } from "@/lib/field-label";
import type { AdminBrand } from "./types";
import {
  LanguagePreferenceDropdown,
  ThemePreferenceDropdown,
} from "./preference-controls";

interface HeaderProps {
  fixed?: boolean;
  className?: string;
  site?: AdminBrand;
  publicUrl?: string;
}

export function Header({
  fixed = false,
  className,
  site,
  publicUrl,
}: HeaderProps): React.ReactElement {
  const { pathname } = useAdminLocation();
  const { language } = usePreferences();
  const current = currentPage(pathname, language);

  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4",
        fixed && "sticky top-0 z-20",
        className,
      )}
    >
      <SidebarTrigger className="-ms-1 md:hidden" />
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap">
          <BreadcrumbItem className="hidden sm:block">
            <BreadcrumbLink href="/admin">{site?.title ?? "Admin"}</BreadcrumbLink>
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
          <Button asChild variant="ghost" size="icon-sm">
            <a
              href={publicUrl}
              target="_blank"
              rel="noreferrer"
              title={t(language, "common.viewSite")}
              aria-label={t(language, "common.viewSite")}
            >
              <ExternalLink aria-hidden />
            </a>
          </Button>
        ) : null}
        <LanguagePreferenceDropdown compact />
        <ThemePreferenceDropdown compact />
      </div>
    </header>
  );
}

function currentPage(pathname: string, language: ReturnType<typeof usePreferences>["language"]): string | null {
  if (pathname === "/admin" || pathname === "/admin/") return null;
  const parts = pathname.split("/").filter(Boolean);
  const segment = decodeURIComponent(parts[parts.length - 1] ?? "");
  if (pathname === "/admin/media") return t(language, "nav.media");
  if (pathname === "/admin/settings") return t(language, "nav.settings");
  if (pathname === "/admin/staff") return t(language, "nav.staff");
  if (pathname === "/admin/approvals") return t(language, "nav.approvals");
  return segment ? fieldLabel(segment) : null;
}
