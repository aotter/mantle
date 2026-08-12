import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
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
import { FormActionBarHostContext } from "../ui/page";
import type { AdminBrand, NavGroupData, NavItem, NavLink } from "./types";

interface AuthenticatedLayoutProps {
  children: React.ReactNode;
}

export function AuthenticatedLayout({ children }: AuthenticatedLayoutProps): React.ReactElement {
  const [formActionBarHost, setFormActionBarHost] = React.useState<HTMLDivElement | null>(null);
  const [hasFormActions, setHasFormActions] = React.useState(false);
  const { pathname, search } = useAdminLocation();
  const { language } = usePreferences();

  React.useLayoutEffect(() => {
    if (!formActionBarHost) return;
    const sync = (): void => setHasFormActions(formActionBarHost.childElementCount > 0);
    const observer = new MutationObserver(sync);
    observer.observe(formActionBarHost, { childList: true });
    sync();
    return () => observer.disconnect();
  }, [formActionBarHost]);

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
  const operationsQuery = useQuery<StaffOperation[]>(operationsQueryOptions());
  const viewsQuery = useQuery<ViewManifestInfo[]>(viewsManifestQueryOptions());

  const resolvedBrand = React.useMemo<AdminBrand>(
    () => ({
      title: site.data?.brand ?? t(language, "admin.consoleTitle"),
      href: "/admin",
      image: site.data?.faviconUrl,
    }),
    [language, site.data],
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
            {!hasFormActions ? (
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
            ) : null}
          </footer>
        </SidebarInset>
      </SidebarProvider>
    </FormActionBarHostContext.Provider>
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

  // Bound operations already live in their collection's row menu.
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
        ? [{ title: t(language, "nav.media"), url: "/admin/media", icon: Images }]
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
    ...(opsGroup ? [opsGroup] : []),
    ...(reportsGroup ? [reportsGroup] : []),
    ...(moreGroup.items.length > 0 ? [moreGroup] : []),
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
  if (c.lifecycle === "editorial") return EDITORIAL_STATUSES;
  if (c.lifecycle === "operational") return [];
  return PUBLISHING_STATUSES;
}
