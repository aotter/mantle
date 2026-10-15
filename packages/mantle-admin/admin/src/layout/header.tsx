import * as React from "react";
import { WebMcpControl } from "./webmcp-control";
import { ExternalLink } from "lucide-react";

import { useAdminLocation } from "@/app/router";
import { usePreferences } from "@/app/preferences";
import { t } from "@/app/i18n";
import { Button } from "@aotter/mantle-ui/kit";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@aotter/mantle-ui/kit";
import { SidebarTrigger } from "@aotter/mantle-ui/kit";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aotter/mantle-ui/kit";
import { fieldLabel } from "@/lib/field-label";
import type { HeaderProps } from "../app/slot-props";
import { useShell } from "./shell-context";
import {
  LanguagePreferenceDropdown,
  ThemePreferenceDropdown,
} from "./preference-controls";

export function Header({ title, actions }: HeaderProps): React.ReactElement {
  const { pathname } = useAdminLocation();
  const { language } = usePreferences();
  const { publicUrl, workspaceLink, actionsHostRef, brand: site } = useShell();
  const current = title ?? currentPage(pathname, language);

  return (
    <header
      data-slot="app-header"
      className="group/header absolute inset-x-0 top-0 z-30 flex h-14 shrink-0 items-center gap-1 border-b px-2 sm:gap-2 sm:px-4"
    >
      <SidebarTrigger className="-ms-1 md:hidden" aria-label={t(language, "common.toggleSidebar")} />
      <Breadcrumb className="min-w-0 max-sm:group-has-[[data-slot=page-header-actions]:not(:empty)]/header:hidden" aria-label={t(language, "common.breadcrumb")}>
        <BreadcrumbList className="flex-nowrap">
          <BreadcrumbItem className="hidden sm:block">
            <BreadcrumbLink href={site?.href ?? "/admin"}>{site?.title ?? t(language, "admin.consoleTitle")}</BreadcrumbLink>
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
      <div ref={actionsHostRef} data-slot="page-header-actions" className="flex min-w-0 shrink items-center" />
      <div className="ms-auto flex shrink-0 items-center gap-1">
        {actions}
        {workspaceLink ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon-sm">
                <a href={workspaceLink.href} aria-label={workspaceLink.label}>
                  <workspaceLink.icon aria-hidden />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{workspaceLink.label}</TooltipContent>
          </Tooltip>
        ) : null}
        {publicUrl ? (
          <span className="hidden sm:inline-flex"><Tooltip>
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
          </Tooltip></span>
        ) : null}
        <LanguagePreferenceDropdown compact />
        <ThemePreferenceDropdown compact />
        <WebMcpControl />
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
  if (pathname === "/admin/operations") return t(language, "ops.title");
  if (pathname === "/admin/media") return t(language, "nav.media");
  if (pathname === "/admin/connected-apps") return t(language, "oauth.connectedApps");
  if (pathname === "/admin/settings") return t(language, "nav.settings");
  if (pathname === "/admin/admin") return t(language, "nav.admin");
  if (pathname === "/admin/members") return t(language, "nav.members");
  if (pathname === "/admin/dev" || pathname.startsWith("/admin/dev/overview/")) return t(language, "nav.overview");
  if (pathname === "/admin/dev/model" || pathname.startsWith("/admin/dev/model/")) return t(language, "model.title");
  if (pathname === "/admin/dev/logic" || pathname.startsWith("/admin/dev/logic/")) return t(language, "logic.title");
  if (pathname === "/admin/dev/docs" || pathname.startsWith("/admin/dev/docs/")) return t(language, "docs.title");
  return segment ? fieldLabel(segment) : null;
}
