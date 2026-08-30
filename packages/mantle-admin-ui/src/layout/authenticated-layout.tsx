import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  BarChart3,
  Folder,
  Globe,
  Home,
  Images,
  Network,
  SquareTerminal,
  Settings as SettingsIcon,
  ContactRound,
  Users,
} from "lucide-react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { api } from "../lib/api";
import { fieldLabel } from "../lib/field-label";
import { viewsManifestQueryOptions } from "../lib/queries";
import { resolveLocalizedText } from "../lib/localized-text";
import {
  PUBLISHING_STATUSES,
  type AdminUser,
  type Collection,
  type SiteInfo,
  type SiteIcon,
  type SidebarStatus,
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
import { FormActionBarHostContext } from "../ui/page";
import type { AdminBrand, NavGroupData, NavItem, NavLink } from "./types";

interface AuthenticatedLayoutProps {
  children: React.ReactNode;
  workspace?: "content" | "developer";
}

export function AuthenticatedLayout({
  children,
  workspace = "content",
}: AuthenticatedLayoutProps): React.ReactElement {
  const [formActionBarHost, setFormActionBarHost] = React.useState<HTMLDivElement | null>(null);
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
    enabled: workspace === "content",
  });
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const viewsQuery = useQuery<ViewManifestInfo[]>({
    ...viewsManifestQueryOptions(),
    enabled: workspace === "content",
  });

  React.useEffect(() => {
    if (!site.data?.icons.length) return;
    document.querySelectorAll("link[rel~='icon']").forEach((link) => link.remove());
    for (const icon of site.data.icons) {
      const link = document.createElement("link");
      link.rel = "icon";
      link.href = icon.src;
      if (icon.mimeType) link.type = icon.mimeType;
      if (icon.sizes) link.sizes.add(...icon.sizes);
      if (icon.theme) link.media = `(prefers-color-scheme: ${icon.theme})`;
      document.head.append(link);
    }
  }, [site.data?.icons]);

  const resolvedBrand = React.useMemo<AdminBrand>(
    () => ({
      title: workspace === "developer"
        ? t(language, "developer.consoleTitle")
        : site.data?.brand ?? t(language, "admin.consoleTitle"),
      href: workspace === "developer" ? "/admin/dev/logic" : "/admin",
      image: preferredAdminIcon(site.data?.icons),
    }),
    [language, site.data, workspace],
  );

  const canonical = site.data?.canonicalLocale ?? null;
  const groups = React.useMemo<ReadonlyArray<NavGroupData>>(
    () => workspace === "developer"
      ? buildDeveloperNavGroups(language)
      : buildNavGroups(
          collectionsQuery.data ?? [],
          viewsQuery.data ?? [],
          language,
          canonical,
          me.data?.role ?? null,
        ),
    [collectionsQuery.data, viewsQuery.data, language, canonical, me.data?.role, workspace],
  );
  const collectionName = pathname.match(/^\/admin\/c\/([^/]+)/)?.[1];
  const viewName = pathname.match(/^\/admin\/views\/([^/]+)/)?.[1];
  const resource = collectionName
    ? collectionsQuery.data?.find((collection) => collection.name === decodeURIComponent(collectionName))
    : viewsQuery.data?.find((view) => view.name === decodeURIComponent(viewName ?? ""));
  const pageTitle = resource
    ? resolveLocalizedText(resource.title, language, canonical) ?? fieldLabel(resource.name)
    : undefined;
  return (
    <FormActionBarHostContext.Provider value={formActionBarHost}>
      <SidebarProvider className="h-svh min-h-0 overflow-hidden">
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
        <SidebarInset className="min-h-0 overflow-hidden">
          <Header
            className="absolute inset-x-0 top-0 z-30"
            site={resolvedBrand}
            publicUrl={site.data?.publicUrl}
            pageTitle={pageTitle}
            workspaceLink={workspace === "developer"
              ? { href: "/admin", label: t(language, "common.contentAdmin"), icon: ArrowLeft }
              : me.data?.role === "owner"
              ? { href: "/admin/dev/logic", label: t(language, "developer.consoleTitle"), icon: SquareTerminal }
              : undefined}
          />
          <Main className="min-h-0 overflow-y-auto overscroll-contain pt-20 pb-20">{children}</Main>
          <footer
            data-slot="status-bar"
            className="absolute inset-x-0 bottom-0 z-30 flex min-h-16 items-center border-t px-4 py-3 sm:px-6"
          >
            <div
              ref={setFormActionBarHost}
              data-slot="status-bar-action-host"
              className="contents"
            />
            <div
              data-slot="status-bar-meta"
              className="ms-auto flex items-center justify-end"
            >
              <a
                href={`https://www.npmjs.com/package/@aotter/mantle/v/${__MANTLE_VERSION__}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-md px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                @aotter/mantle-{__MANTLE_VERSION__}
              </a>
            </div>
          </footer>
        </SidebarInset>
      </SidebarProvider>
    </FormActionBarHostContext.Provider>
  );
}

function preferredAdminIcon(icons: readonly SiteIcon[] | undefined): string | undefined {
  return icons?.find((icon) => icon.sizes?.includes("64x64") && !icon.theme)?.src
    ?? icons?.find((icon) => !icon.theme)?.src
    ?? icons?.[0]?.src;
}

export function buildNavGroups(
  collections: ReadonlyArray<Collection>,
  views: ReadonlyArray<ViewManifestInfo>,
  language: AdminLanguage,
  canonical: string | null,
  role: AdminUser["role"],
): ReadonlyArray<NavGroupData> {
  const primaryCollections = collections.filter((collection) => !collection.parent);
  const contentCollections = primaryCollections.filter((c) => c.lifecycle !== "operational");
  const operationalCollections = primaryCollections.filter((c) => c.lifecycle === "operational");
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

  // Read-only views get direct sidebar links.
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
      ...(role === "owner" || role === "editor"
        ? [
            { title: t(language, "nav.media"), url: "/admin/media", icon: Images },
            { title: t(language, "nav.members"), url: "/admin/members", icon: ContactRound },
          ]
        : []),
      ...(role === "owner"
        ? [
            { title: t(language, "nav.settings"), url: "/admin/settings", icon: SettingsIcon },
            { title: t(language, "nav.staff"), url: "/admin/staff", icon: Users },
          ]
        : []),
    ],
  };

  return [
    homeGroup,
    contentGroup,
    ...(recordsGroup ? [recordsGroup] : []),
    ...(reportsGroup ? [reportsGroup] : []),
    ...(moreGroup.items.length > 0 ? [moreGroup] : []),
  ];
}

export function buildDeveloperNavGroups(language: AdminLanguage): ReadonlyArray<NavGroupData> {
  return [{
    title: t(language, "nav.build"),
    items: [{ title: t(language, "nav.logic"), url: "/admin/dev/logic", icon: Network }],
  }];
}

function collectionNavItem(c: Collection, language: AdminLanguage, canonical: string | null): NavItem {
  const localized = c.localized || c.hasTranslations;
  const base = {
    title: resolveLocalizedText(c.title, language, canonical) ?? fieldLabel(c.name),
    icon: Folder,
    marker: localized ? Globe : undefined,
    markerLabel: localized ? t(language, "nav.localizedContent") : undefined,
  };
  if (c.lifecycle === "operational" && c.filter) {
    return {
      ...base,
      items: [
        { title: t(language, "collection.filter.all"), url: `/admin/c/${c.name}` },
        ...c.filter.values.map<NavLink>((value) => ({
          title: fieldLabel(value),
          url: `/admin/c/${c.name}?filter_field=${encodeURIComponent(c.filter!.field)}&filter_value=${encodeURIComponent(value)}`,
        })),
      ],
    };
  }
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
  if (c.lifecycle === "operational") return [];
  return PUBLISHING_STATUSES;
}
