import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  ClipboardList,
  Folder,
  Globe,
  Home,
  Images,
  Settings as SettingsIcon,
  Users,
  Wrench,
} from "lucide-react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { api } from "../lib/api";
import { fieldLabel } from "../lib/field-label";
import { operationsQueryOptions, viewsManifestQueryOptions } from "../lib/queries";
import { resolveLocalizedText } from "../lib/localized-text";
import {
  EDITORIAL_STATUSES,
  PUBLISHING_STATUSES,
  type AdminUser,
  type Collection,
  type SiteInfo,
  type SidebarStatus,
  type StaffOperation,
  type ViewManifestInfo,
} from "../lib/types";
import { useAdminLocation } from "../app/router";
import { usePreferences, type AdminLanguage } from "../app/preferences";
import { AppSidebar } from "./app-sidebar";
import { Header } from "./header";
import { Main } from "./main";
import { SkipToMain } from "./skip-to-main";
import { statusLabel } from "../features/content/status";
import { t } from "../app/i18n";
import type { AdminBrand, NavGroupData, NavItem, NavLink } from "./types";

interface AuthenticatedLayoutProps {
  children: React.ReactNode;
}

const DEFAULT_BRAND: AdminBrand = {
  title: "CMS",
  href: "/admin",
};

export function AuthenticatedLayout({ children }: AuthenticatedLayoutProps): React.ReactElement {
  const { pathname, search } = useAdminLocation();
  const { language } = usePreferences();

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
  // One extra query each (#426), cached under their own query keys so
  // they don't refetch alongside unrelated collection/site changes.
  const operationsQuery = useQuery<StaffOperation[]>(operationsQueryOptions());
  const viewsQuery = useQuery<ViewManifestInfo[]>(viewsManifestQueryOptions());

  const resolvedBrand = React.useMemo<AdminBrand>(
    () => ({
      ...DEFAULT_BRAND,
      title: site.data?.brand ?? DEFAULT_BRAND.title,
      image: site.data?.faviconUrl,
    }),
    [site.data],
  );

  const canonical = site.data?.canonicalLocale ?? null;
  const groups = React.useMemo<ReadonlyArray<NavGroupData>>(
    () =>
      buildNavGroups(
        collectionsQuery.data ?? [],
        operationsQuery.data ?? [],
        viewsQuery.data ?? [],
        language,
        canonical,
        me.data?.role ?? null,
      ),
    [collectionsQuery.data, operationsQuery.data, viewsQuery.data, language, canonical, me.data?.role],
  );
  return (
    <SidebarProvider>
      <SkipToMain />
      <AppSidebar
        brand={resolvedBrand}
        groups={groups}
        pathname={pathname}
        search={search}
        user={{
          login: me.data?.login ?? null,
          image: me.data?.image ?? null,
          role: me.data?.role ?? null,
        }}
      />
      <SidebarInset>
        <Header
          fixed
          site={resolvedBrand}
          publicUrl={site.data?.publicUrl}
        />
        <Main>{children}</Main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function buildNavGroups(
  collections: ReadonlyArray<Collection>,
  operations: ReadonlyArray<StaffOperation>,
  views: ReadonlyArray<ViewManifestInfo>,
  language: AdminLanguage,
  canonical: string | null,
  role: AdminUser["role"],
): ReadonlyArray<NavGroupData> {
  const primaryCollections = collections.filter((collection) => !collection.parent);
  const contentCollections = primaryCollections.filter((c) => c.lifecycle !== "operational");
  const operationalCollections = primaryCollections.filter((c) => c.lifecycle === "operational");
  const hasEditorial = collections.some((c) => c.lifecycle === "editorial");
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
    items: contentCollections.map((c) => collectionNavItem(c, language, canonical)),
  };

  const recordsGroup: NavGroupData | null =
    operationalCollections.length > 0
      ? {
          title: t(language, "nav.operations"),
          items: operationalCollections.map((c) => collectionNavItem(c, language, canonical)),
        }
      : null;

  // 「操作」— one item per UNBOUND staff-operable Procedure (#426,
  // narrowed #433). Operations with `rowBindings` already surface from
  // the entry-row "⋯" menu of the bound collection, so listing them in
  // the sidebar too is redundant (operator review Q1). Only operations
  // with NO row bindings get a sidebar item; empty → group hidden.
  const unboundOperations = operations.filter((op) => op.rowBindings.length === 0);
  const opsGroup: NavGroupData | null =
    unboundOperations.length > 0
      ? {
          title: t(language, "nav.ops"),
          items: unboundOperations.map((op) => ({
            title: resolveLocalizedText(op.title, language, canonical) ?? fieldLabel(op.name),
            icon: Wrench,
            url: `/admin/ops#${op.name}`,
          })),
        }
      : null;

  // 「報表」— one item per read-only View (#426). `title` (#443) falls
  // back to the humanized name, exactly as before this field existed.
  const reportsGroup: NavGroupData | null =
    views.length > 0
      ? {
          title: t(language, "nav.reports"),
          items: views.map((v) => ({
            title: resolveLocalizedText(v.title, language, canonical) ?? fieldLabel(v.name),
            icon: BarChart3,
            url: `/admin/views/${encodeURIComponent(v.name)}`,
          })),
        }
      : null;

  const moreGroup: NavGroupData = {
    title: t(language, "nav.more"),
    items: [
      // Deep links to /admin/approvals stay live regardless; the nav
      // entry only shows up when there's an editorial collection with
      // an approval queue behind it.
      ...(hasEditorial
        ? [{ title: t(language, "nav.approvals"), url: "/admin/approvals", icon: ClipboardList }]
        : []),
      { title: t(language, "nav.media"), url: "/admin/media", icon: Images },
      { title: t(language, "nav.settings"), url: "/admin/settings", icon: SettingsIcon },
      // Staff management is owner-only server-side; hide the entry for
      // everyone else rather than render a guaranteed 403.
      ...(role === "owner"
        ? [{ title: t(language, "nav.staff"), url: "/admin/staff", icon: Users }]
        : []),
    ],
  };

  return [
    homeGroup,
    contentGroup,
    ...(recordsGroup ? [recordsGroup] : []),
    ...(opsGroup ? [opsGroup] : []),
    ...(reportsGroup ? [reportsGroup] : []),
    moreGroup,
  ];
}

function collectionNavItem(c: Collection, language: AdminLanguage, canonical: string | null): NavItem {
  // Leading icon is always Folder so every content row reads the
  // same. The Globe sits in the trailing `marker` slot to mark
  // collections that fold a translation-child schema underneath
  // — POC sidebar contract.
  const base = {
    title: resolveLocalizedText(c.title, language, canonical) ?? fieldLabel(c.name),
    icon: Folder,
    marker: c.hasTranslations ? Globe : undefined,
  };
  const statuses = statusesFor(c);
  // Operational records (lifecycle: operational) have no status buckets —
  // a plain link beats a collapsible with one child.
  if (statuses.length === 0) {
    return { ...base, url: `/admin/c/${c.name}` };
  }
  return {
    ...base,
    items: [
      {
        title: t(language, "collection.filter.all"),
        url: `/admin/c/${c.name}`,
      },
      ...statuses.map<NavLink>((status) => ({
        title: statusLabel(language, status),
        url: `/admin/c/${c.name}?status=${status}`,
      })),
    ],
  };
}

function statusesFor(c: Collection): ReadonlyArray<SidebarStatus> {
  if (c.lifecycle === "editorial") return EDITORIAL_STATUSES;
  if (c.lifecycle === "operational") return [];
  return PUBLISHING_STATUSES;
}
