import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  BookOpenText,
  Database,
  Folder,
  Globe,
  Home,
  Images,
  LayoutDashboard,
  Wrench,
  Settings as SettingsIcon,
  ContactRound,
  Users,
  Workflow,
  Puzzle,
} from "lucide-react";

import { SidebarInset, SidebarProvider } from "@aotter/mantle-ui/kit";
import { api } from "../lib/api";
import { isPrimaryNavCollection } from "../lib/collection-nav";
import { fieldLabel } from "../lib/field-label";
import { optionLabel } from "../lib/enum-options";
import { operationsQueryOptions, viewsManifestQueryOptions } from "../lib/queries";
import { resolveLocalizedText } from "../lib/localized-text";
import {
  PUBLISHING_STATUSES,
  type AdminUser,
  type Collection,
  type SiteInfo,
  type SiteIcon,
  type SidebarStatus,
  type AdminOperation,
  type ViewManifestInfo,
  type NavPlacement,
} from "../lib/types";
import { useAdminLocation } from "../app/router";
import { usePreferences, type AdminLanguage } from "../app/preferences";
import { AppSidebar } from "./app-sidebar";
import { Header } from "./header";
import { PageHeaderActionsHostContext } from "./page-header-actions";
import { Main } from "./main";
import { Skeleton } from "@aotter/mantle-ui/kit";
import { SkipToMain } from "./skip-to-main";
import { statusLabel } from "../features/content/status";
import { t } from "../app/i18n";
import { FormActionBarHostContext } from "../ui/page";
import { Slot } from "../app/slots";
import type { ShellProps } from "../app/slot-props";
import { ShellContext, type ShellContextValue } from "./shell-context";
import type { AdminBrand, NavGroupData, NavItem, NavLink } from "./types";

interface AuthenticatedLayoutProps {
  children: React.ReactNode;
  workspace?: "content" | "developer";
}

/**
 * The frame of every page. The content workspace goes through the `Shell` slot; the developer workspace (`/admin/dev`)
 * is Admin's own tool and stays fixed.
 */
export function AuthenticatedLayout({
  children,
  workspace = "content",
}: AuthenticatedLayoutProps): React.ReactElement {
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
  const operationsQuery = useQuery<AdminOperation[]>({
    ...operationsQueryOptions(),
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
        ? t(language, "developer.workspaceTitle")
        : site.data?.brand ?? t(language, "admin.consoleTitle"),
      href: workspace === "developer" ? "/admin/dev" : "/admin",
      image: workspace === "developer" ? null : preferredAdminIcon(site.data?.icons),
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
          me.data?.admin === true,
          (operationsQuery.data ?? []).some((operation) =>
            (operation.interactions ?? []).length === 0 && !operation.uiSchema?.["collectionAction"]),
          site.data?.capabilities,
          site.data?.extensions,
          site.data?.navGroups,
        ),
    [collectionsQuery.data, viewsQuery.data, operationsQuery.data, language, canonical, me.data?.admin, workspace, site.data?.capabilities, site.data?.extensions, site.data?.navGroups],
  );
  return workspace === "developer"
    ? <ShellFrame workspace="developer" nav={groups} brand={resolvedBrand}>{children}</ShellFrame>
    : <Slot name="Shell" Default={ShellFrame} props={{ children, nav: groups, brand: resolvedBrand }} />;
}

/** Admin's own shell: sidebar, header, the routed `children` and the status bar. */
function ShellFrame({ children, nav, brand, workspace = "content" }: ShellProps & { workspace?: "content" | "developer" }): React.ReactElement {
  const [formActionBarHost, setFormActionBarHost] = React.useState<HTMLDivElement | null>(null);
  const [pageHeaderActionsHost, setPageHeaderActionsHost] = React.useState<HTMLDivElement | null>(null);
  const { pathname } = useAdminLocation();
  const fullBleed = workspace === "developer" && pathname.startsWith("/admin/dev");
  const { language } = usePreferences();
  const me = useQuery<AdminUser>({ queryKey: ["me"], queryFn: () => api.get<AdminUser>("/me"), retry: false });
  const site = useQuery<SiteInfo>({ queryKey: ["site"], queryFn: () => api.get<SiteInfo>("/site") });
  const collectionsQuery = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => (await api.get<{ collections: Collection[] }>("/collections")).collections,
    enabled: workspace === "content",
  });
  const viewsQuery = useQuery<ViewManifestInfo[]>({ ...viewsManifestQueryOptions(), enabled: workspace === "content" });
  const canonical = site.data?.canonicalLocale ?? null;
  const collectionName = pathname.match(/^\/admin\/c\/([^/]+)/)?.[1];
  const viewName = pathname.match(/^\/admin\/views\/([^/]+)/)?.[1];
  const resource = collectionName
    ? collectionsQuery.data?.find((collection) => collection.name === decodeURIComponent(collectionName))
    : viewsQuery.data?.find((view) => view.name === decodeURIComponent(viewName ?? ""));
  const pageTitle = resource
    ? resolveLocalizedText(resource.title, language, canonical) ?? fieldLabel(resource.name)
    : undefined;
  const shell = React.useMemo<ShellContextValue>(() => ({
    brand,
    publicUrl: site.data?.publicUrl,
    actionsHostRef: setPageHeaderActionsHost,
    user: { login: me.data?.login ?? null, image: me.data?.image ?? null, role: me.data?.role ?? null },
    workspaceLink: workspace === "developer"
      ? { href: "/admin", label: t(language, "common.contentAdmin"), icon: LayoutDashboard }
      : me.data?.admin === true
      ? { href: "/admin/dev", label: t(language, "developer.workspaceTitle"), icon: Wrench }
      : undefined,
  }), [brand, site.data?.publicUrl, me.data?.login, me.data?.image, me.data?.role, me.data?.admin, workspace, language]);
  return (
    <ShellContext.Provider value={shell}>
    <FormActionBarHostContext.Provider value={formActionBarHost}>
    <PageHeaderActionsHostContext.Provider value={pageHeaderActionsHost}>
      <SidebarProvider className="h-svh min-h-0 overflow-hidden">
        <SkipToMain />
        <Slot name="Sidebar" Default={AppSidebar} props={{ brand, groups: nav }} />
        <SidebarInset className="min-h-0 overflow-hidden">
          <Slot name="Header" Default={Header} props={{ title: pageTitle }} />
          <Main className={fullBleed
            ? "min-h-0 max-w-none overflow-hidden px-0 py-0 pt-14 pb-10 sm:px-0"
            : `min-h-0 overflow-y-auto overscroll-contain pt-20 ${workspace === "developer" ? "pb-14" : "pb-20"}`}>
            <React.Suspense fallback={<div aria-busy="true"><Skeleton className="h-40 w-full" /></div>}>{children}</React.Suspense>
          </Main>
          <footer
            data-slot="status-bar"
            className={`absolute inset-x-0 bottom-0 z-30 flex items-center border-t px-4 sm:px-6 ${workspace === "developer" ? "min-h-10 py-1.5" : "min-h-16 py-3"}`}
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
                @aotter/mantle@{__MANTLE_VERSION__}
              </a>
            </div>
          </footer>
        </SidebarInset>
      </SidebarProvider>
    </PageHeaderActionsHostContext.Provider>
    </FormActionBarHostContext.Provider>
    </ShellContext.Provider>
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
  admin: boolean,
  hasGlobalOperations = false,
  capabilities?: SiteInfo["capabilities"],
  extensions?: SiteInfo["extensions"],
  navGroups?: SiteInfo["navGroups"],
): ReadonlyArray<NavGroupData> {
  // Sidebar placement (`uiSchema.nav` and navGroups): presentation only, so the server's visibility filtering stands.
  // Without any placement this yields Admin's default groups: content, operations, reports, more.
  type Placed = { order: number | undefined; item: NavItem };
  const buckets = new Map<string, Placed[]>();
  const place = (group: string, order: number | undefined, item: NavItem) => { const list = buckets.get(group) ?? []; list.push({ order, item }); buckets.set(group, list); };
  for (const c of collections.filter(isPrimaryNavCollection)) {
    const nav = (c.uiSchema?.["nav"] ?? {}) as NavPlacement;
    if (!nav.hidden) place(nav.group ?? (c.lifecycle === "publishing" ? "content" : "operations"), nav.order, collectionNavItem(c, language, canonical));
  }
  // the manifest lists admin Views only: public and member Views belong to the application surface
  for (const v of views) {
    if (v.nav?.hidden) continue;
    place(v.nav?.group ?? "reports", v.nav?.order, {
      title: resolveLocalizedText(v.title, language, canonical) ?? fieldLabel(v.name),
      icon: BarChart3,
      url: `/admin/views/${encodeURIComponent(v.name)}`,
    });
  }
  // extension pages that ask for a place; settings pages sit with Admin's own settings in More
  for (const extension of extensions ?? []) for (const page of extension.contributes?.pages ?? []) {
    if (page.nav && page.nav.group !== "settings") place(page.nav.group, page.nav.order, {
      title: resolveLocalizedText(page.title, language, canonical) ?? page.id,
      url: `/admin/x/${encodeURIComponent(extension.id)}/${encodeURIComponent(page.id)}`,
      icon: Puzzle,
    });
  }
  // within a group: ordered entries first by order, then the rest in Admin's order (a stable sort)
  const itemsOf = (group: string) => (buckets.get(group) ?? []).sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity)).map((p) => p.item);
  // project groups sort among the built-in ones (more is always last); a stable sort keeps declaration order
  const titled = [
    { id: "content", title: t(language, "nav.content"), order: 10 },
    { id: "operations", title: t(language, "nav.operations"), order: 20 },
    { id: "reports", title: t(language, "nav.reports"), order: 30 },
    ...(navGroups ?? []).map((g) => ({ id: g.id, title: resolveLocalizedText(g.title, language, canonical) ?? g.id, order: g.order ?? 50 })),
  ].sort((a, b) => a.order - b.order);
  const homeGroup: NavGroupData = {
    items: [
      {
        title: t(language, "nav.home"),
        url: "/admin",
        icon: Home,
      },
      ...(hasGlobalOperations
        ? [{ title: t(language, "ops.title"), url: "/admin/operations", icon: Workflow }]
        : []),
    ],
  };
  // an empty group is not shown, except Content while nothing is placed anywhere (More included): its empty state is the start of the console
  const placedGroups: NavGroupData[] = titled
    .filter((g) => buckets.has(g.id) || (buckets.size === 0 && g.id === "content"))
    .map((g) => ({ title: g.title, items: itemsOf(g.id) }));

  const moreGroup: NavGroupData = {
    title: t(language, "nav.more"),
    items: [
      ...(admin
        ? [
            // Media stays when it is off: its page is the setup guide
            { title: t(language, "nav.media"), url: "/admin/media", icon: Images },
            { title: t(language, "nav.members"), url: "/admin/members", icon: ContactRound },
          ]
        : []),
      ...(admin
        ? [
            ...(capabilities?.siteSettings === false ? [] : [{ title: t(language, "nav.settings"), url: "/admin/settings", icon: SettingsIcon }]),
            { title: t(language, "nav.admin"), url: "/admin/admin", icon: Users },
          ]
        : []),
      // extension settings and settings pages (ADR-lite 1376) next to Admin's own settings, already filtered to this
      // admin member's role by the server; a stable sort keeps declaration order within one order
      ...(extensions ?? []).flatMap((extension) => [
        ...(extension.contributes?.pages ?? []).filter((p) => p.nav?.group === "settings").map((p) => ({ ...p, order: p.nav!.order ?? 0 })),
        ...(extension.contributes?.settings ?? []).map((s) => ({ ...s, order: 0 })),
      ].map((c) => ({
        order: c.order,
        title: resolveLocalizedText(c.title, language, canonical) ?? c.id,
        url: `/admin/x/${encodeURIComponent(extension.id)}/${encodeURIComponent(c.id)}`,
        icon: SettingsIcon,
      })))
        .sort((a, b) => a.order - b.order)
        .map(({ order: _order, ...item }) => item),
      ...itemsOf("more"),
    ],
  };

  return [
    homeGroup,
    ...placedGroups,
    ...(moreGroup.items.length > 0 ? [moreGroup] : []),
  ];
}

export function buildDeveloperNavGroups(language: AdminLanguage): ReadonlyArray<NavGroupData> {
  return [{
    title: t(language, "nav.build"),
    items: [
      { title: t(language, "nav.overview"), icon: LayoutDashboard, items: [
        { title: t(language, "logic.execution"), url: "/admin/dev/overview/flow" },
        { title: t(language, "model.relationships"), url: "/admin/dev/overview/relationships" },
      ] },
      { title: t(language, "nav.model"), icon: Database, items: [
        { title: t(language, "model.schemas"), url: "/admin/dev/model/schemas" },
        { title: t(language, "model.views"), url: "/admin/dev/model/views" },
      ] },
      { title: t(language, "nav.logic"), icon: Workflow, items: [
        { title: t(language, "logic.triggers"), url: "/admin/dev/logic/triggers" },
        { title: t(language, "logic.procedures"), url: "/admin/dev/logic/procedures" },
      ] },
      { title: t(language, "nav.docs"), icon: BookOpenText, items: [
        { title: t(language, "docs.api"), url: "/admin/dev/docs/api" },
        { title: t(language, "docs.mcp"), url: "/admin/dev/docs/mcp" },
        { title: t(language, "docs.webmcp"), url: "/admin/dev/docs/webmcp" },
      ] },
    ],
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
  if (c.lifecycle !== "publishing" && c.filter) {
    return {
      ...base,
      items: [
        { title: t(language, "collection.filter.all"), url: `/admin/c/${c.name}` },
        ...c.filter.values.map<NavLink>((value) => ({
          title: optionLabel(c.schema?.properties?.[c.filter!.field], value, language, canonical),
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
  if (c.lifecycle !== "publishing") return [];
  return PUBLISHING_STATUSES;
}
