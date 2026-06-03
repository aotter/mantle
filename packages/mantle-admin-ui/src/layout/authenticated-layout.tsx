import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ClipboardList,
  Images,
  Folder,
  Globe,
  Home,
  PlaySquare,
  TerminalSquare,
  Settings as SettingsIcon,
} from "lucide-react";

import { LayoutProvider } from "../context/layout-provider";
import { SidebarInset, SidebarProvider } from "../ui/sidebar";
import { api } from "../lib/api";
import {
  EDITORIAL_STATUSES,
  SIMPLE_STATUSES,
  type AdminUser,
  type Collection,
  type SiteInfo,
  type SidebarStatus,
} from "../lib/types";
import { useAdminLocation } from "../app/router";
import { usePreferences, type AdminLanguage } from "../app/preferences";
import { AppSidebar } from "./app-sidebar";
import { Header } from "./header";
import { Main } from "./main";
import { SkipToMain } from "./skip-to-main";
import { statusLabel } from "../features/content/status";
import { readSidebarOpenCookie } from "../context/layout-provider";
import { t } from "../app/i18n";
import { AdminAttribution } from "../brand/aotter-mantle";
import type { AdminBrand, NavGroupData, NavItem, NavLink } from "./types";
import { collectionTitle } from "../features/content/collection-labels";
import { GuideOverlay, useGuideOverlay } from "../features/console/guide-overlay";

interface AuthenticatedLayoutProps {
  brand?: AdminBrand;
  fixed?: boolean;
  fluid?: boolean;
  children: React.ReactNode;
}

const DEFAULT_BRAND: AdminBrand = {
  title: "CMS",
  subtitle: "admin",
  href: "/admin",
};

export function AuthenticatedLayout({
  brand = DEFAULT_BRAND,
  fixed = false,
  fluid = false,
  children,
}: AuthenticatedLayoutProps): React.ReactElement {
  const { pathname, search } = useAdminLocation();
  const { language } = usePreferences();
  const guide = useGuideOverlay();

  const me = useQuery<AdminUser>({
    queryKey: ["me"],
    queryFn: () => api.get<AdminUser>("/me"),
    retry: false,
  });
  const collectionsQuery = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await api.get<{ collections: Collection[] }>("/collections");
      return res.collections;
    },
  });
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });

  const resolvedBrand = React.useMemo<AdminBrand>(
    () => ({
      ...brand,
      title: site.data?.brand ?? brand.title,
      subtitle: site.data?.canonicalLocale ?? brand.subtitle,
    }),
    [brand, site.data],
  );

  const groups = React.useMemo<ReadonlyArray<NavGroupData>>(
    () => buildNavGroups(collectionsQuery.data ?? [], language),
    [collectionsQuery.data, language],
  );

  return (
    <LayoutProvider>
      <SidebarProvider defaultOpen={readSidebarOpenCookie() ?? true}>
        <SkipToMain />
        <AppSidebar
          brand={resolvedBrand}
          groups={groups}
          pathname={pathname}
          search={search}
          user={{
            login: me.data?.login ?? null,
            role: me.data?.role ?? null,
          }}
        />
        <SidebarInset>
          <Header
            fixed
            site={resolvedBrand}
            publicUrl={site.data?.publicUrl}
            onOpenGuide={guide.showGuide}
            user={{
              login: me.data?.login ?? null,
              role: me.data?.role ?? null,
            }}
          />
          <Main fixed={fixed} fluid={fluid}>
            {children}
          </Main>
        </SidebarInset>
          <AdminAttribution />
          {guide.open ? (
            <GuideOverlay language={guide.language} onClose={guide.closeGuide} />
          ) : null}
        </SidebarProvider>
      </LayoutProvider>
  );
}

function buildNavGroups(
  collections: ReadonlyArray<Collection>,
  language: AdminLanguage,
): ReadonlyArray<NavGroupData> {
  const primaryCollections = collections.filter((collection) => !collection.parent);
  const homeGroup: NavGroupData = {
    items: [
      {
        title: t(language, "nav.home"),
        url: "/admin",
        icon: Home,
      },
    ],
  };

  const contentGroup: NavGroupData = {
    title: t(language, "nav.content"),
    items: primaryCollections.map<NavItem>((c) => ({
      title: collectionTitle(c, language),
      // Leading icon is always Folder so every content row reads the
      // same. The Globe sits in the trailing `marker` slot to mark
      // collections that fold a translation-child schema underneath
      // — POC sidebar contract.
      icon: Folder,
      marker: c.hasTranslations ? Globe : undefined,
      items: [
        {
          title: t(language, "collection.filter.all"),
          url: `/admin/c/${c.name}`,
        },
        ...statusesFor(c).map<NavLink>((status) => ({
          title: statusLabel(language, status),
          url: `/admin/c/${c.name}?status=${status}`,
        })),
      ],
    })),
  };

  const moreGroup: NavGroupData = {
    title: t(language, "nav.more"),
    items: [
      { title: t(language, "nav.media"), url: "/admin/media", icon: Images },
      { title: t(language, "nav.approvals"), url: "/admin/approvals", icon: ClipboardList },
      { title: t(language, "nav.actions"), url: "/admin/actions", icon: PlaySquare },
      { title: t(language, "nav.developerLogs"), url: "/admin/developer-logs", icon: TerminalSquare },
      { title: t(language, "nav.settings"), url: "/admin/settings", icon: SettingsIcon },
    ],
  };

  return [homeGroup, contentGroup, moreGroup];
}

function statusesFor(c: Collection): ReadonlyArray<SidebarStatus> {
  return c.lifecycle === "editorial" ? EDITORIAL_STATUSES : SIMPLE_STATUSES;
}
