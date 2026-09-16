import { canRenderAdmin } from "./frame-policy";
import { usePreferences } from "./preferences";
import { t } from "./i18n";
import * as React from "react";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AuthenticatedLayout } from "../layout/authenticated-layout";
import { api, ApiError } from "../lib/api";
import type { AdminUser, Collection, ListEntriesResult, SiteInfo, StaffOperation, ViewManifestInfo } from "../lib/types";
import type { AdminToolCatalog } from "../lib/admin-tools";
import { entriesQueryOptions, entriesQuerySearchParams, withNavigationTools } from "../lib/queries";
import { useAdminLocation } from "./router";
import {
  AccessDeniedView,
  ConnectedAppsPage,
  ConnectedAppsView,
  GateError,
  GateLoading,
  OAuthConsentView,
  SignInView,
} from "../features/auth/auth-views";
import { HomeView } from "../features/console/home-view";
import { CollectionView } from "../features/content/collection-view";
import { EntryEditView } from "../features/content/entry-edit-view";
import { ParentEntryWorkbench, shouldOpenParentWorkbench } from "../features/content/parent-entry-workbench";
import { MediaLibraryView } from "../features/media/media-library-view";
import { OperationsView } from "../features/ops/operations-view";
import { ViewPage } from "../features/ops/view-page";
import { NotFoundView } from "../features/system/not-found-view";
import { PreferencesView } from "../features/system/preferences-view";
import { SettingsView } from "../features/system/settings-view";
import { StaffView } from "../features/system/staff-view";
import { MembersView } from "../features/system/members-view";
import { DataModelView } from "../features/logic/data-model-view";
import { DeveloperOverviewView } from "../features/logic/developer-overview-view";
import { LogicView } from "../features/logic/logic-view";
import { InterfaceDocsView } from "../features/logic/interface-docs-view";

export function AdminApp({ preview = false }: { preview?: boolean } = {}): React.ReactElement | null {
  const location = useAdminLocation();

  // Static asset URLs can bypass the server's frame-ancestors headers.
  if (typeof window !== "undefined" && !canRenderAdmin(window, preview)) return null;

  if (preview && ["/admin/sign-in", "/admin/connected-apps", "/oauth/consent"].includes(location.pathname)) {
    return <PreviewAccountNotice />;
  }

  if (location.pathname === "/oauth/consent") return <OAuthConsentView />;

  if (location.pathname === "/admin/sign-in") {
    return <SignInView />;
  }

  return <Gate path={location.pathname} search={location.search} preview={preview} />;
}

function PreviewAccountNotice(): React.ReactElement {
  const { language } = usePreferences();
  return <div className="p-6"><h1 className="text-xl font-semibold">{t(language, "preview.accountTitle")}</h1><p className="mt-2">{t(language, "preview.accountBody")}</p></div>;
}

interface BootstrapPayload {
  me: AdminUser;
  collections: Collection[];
  site: SiteInfo;
  operations: StaffOperation[];
  views: ViewManifestInfo[];
  webmcp: AdminToolCatalog;
  entries: ListEntriesResult;
}

function Gate({ path, search, preview }: { path: string; search: string; preview: boolean }): React.ReactElement {
  const queryClient = useQueryClient();
  const collectionMatch = path.match(/^\/admin\/c\/([^/]+)\/?$/);
  const params = new URLSearchParams(search);
  const collectionName = collectionMatch ? decodeURIComponent(collectionMatch[1]!) : null;
  const bootstrapArgs = collectionName && !params.has("parent") ? {
    collectionName,
    status: params.get("status") ?? undefined,
    searchTerm: params.get("search")?.trim() ?? "",
    filterField: params.get("filter_field") ?? undefined,
    filterValue: params.get("filter_value") ?? undefined,
    sortField: params.get("sort") || "updatedAt",
    sortDirection: params.get("direction") === "asc" ? "asc" as const : "desc" as const,
    cursor: params.get("cursor") || undefined,
    cursorDirection: params.get("cursor_direction") === "backward" ? "backward" as const : "forward" as const,
  } : null;
  const me = useQuery<AdminUser>({
    queryKey: ["me"],
    queryFn: async () => {
      if (!bootstrapArgs) return api.get<AdminUser>("/me");
      const entriesOptions = entriesQueryOptions(bootstrapArgs);
      const data = await api.get<BootstrapPayload>(`/bootstrap?${entriesQuerySearchParams(bootstrapArgs).toString()}`);
      queryClient.setQueryData(["collections"], data.collections);
      queryClient.setQueryData(["site"], data.site);
      queryClient.setQueryData(["operations"], data.operations);
      queryClient.setQueryData(["views-manifest"], data.views);
      queryClient.setQueryData(["admin-webmcp"], withNavigationTools(data.webmcp));
      queryClient.setQueryData(entriesOptions.queryKey, data.entries);
      return data.me;
    },
    retry: false,
  });

  const is401 = me.isError && me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (!is401 || preview || typeof window === "undefined") return;
    const ret = window.location.pathname + window.location.search;
    window.location.href = `/admin/sign-in?return=${encodeURIComponent(ret)}`;
  }, [is401, preview]);
  if (is401) return preview ? <GateError error={me.error} /> : <GateLoading />;

  if (me.isError && me.error instanceof ApiError && me.error.status === 403) {
    if (path === "/admin/connected-apps") return <ConnectedAppsPage />;
    const body = (me.error.body ?? {}) as { login?: string | null };
    return <AccessDeniedView login={body.login ?? null} />;
  }

  if (me.isError) {
    return <GateError error={me.error} />;
  }

  if (me.isLoading) return <GateLoading />;

  if (collectionMatch) {
    return (
      <AuthenticatedLayout>
        <CollectionView collectionName={decodeURIComponent(collectionMatch[1]!)} />
      </AuthenticatedLayout>
    );
  }

  const entryEditMatch = path.match(/^\/admin\/c\/([^/]+)\/([^/]+)\/edit\/?$/);
  if (entryEditMatch) {
    return (
      <AuthenticatedLayout>
        <EntryEditView
          collectionName={decodeURIComponent(entryEditMatch[1]!)}
          entryId={decodeURIComponent(entryEditMatch[2]!)}
        />
      </AuthenticatedLayout>
    );
  }

  const entryMatch = path.match(/^\/admin\/c\/([^/]+)\/([^/]+)\/?$/);
  if (entryMatch) {
    const collectionName = decodeURIComponent(entryMatch[1]!);
    const entryId = decodeURIComponent(entryMatch[2]!);
    return (
      <AuthenticatedLayout>
        <EntryLanding collectionName={collectionName} entryId={entryId} />
      </AuthenticatedLayout>
    );
  }

  if (path === "/admin" || path === "/admin/") {
    return (
      <AuthenticatedLayout>
        <HomeView />
      </AuthenticatedLayout>
    );
  }

  if (path === "/admin/operations") return <AuthenticatedLayout><OperationsView /></AuthenticatedLayout>;

  if (path === "/admin/media") {
    return (
      <AuthenticatedLayout>
        <MediaLibraryView />
      </AuthenticatedLayout>
    );
  }

  if (path === "/admin/preferences") {
    return (
      <AuthenticatedLayout>
        <PreferencesView />
      </AuthenticatedLayout>
    );
  }

  if (path === "/admin/connected-apps") {
    return (
      <AuthenticatedLayout>
        <ConnectedAppsView />
      </AuthenticatedLayout>
    );
  }

  if (path === "/admin/settings") {
    return (
      <AuthenticatedLayout>
        <SettingsView />
      </AuthenticatedLayout>
    );
  }

  if (path === "/admin/staff") {
    return (
      <AuthenticatedLayout>
        <StaffView />
      </AuthenticatedLayout>
    );
  }

  if (path === "/admin/members") {
    return (
      <AuthenticatedLayout>
        <MembersView />
      </AuthenticatedLayout>
    );
  }

  if (path.startsWith("/admin/dev")) return <DeveloperWorkspace path={path} />;

  const viewMatch = path.match(/^\/admin\/views\/([^/]+)\/?$/);
  if (viewMatch) {
    return (
      <AuthenticatedLayout>
        <ViewPage name={decodeURIComponent(viewMatch[1]!)} />
      </AuthenticatedLayout>
    );
  }

  return (
    <AuthenticatedLayout>
      <NotFoundView path={path} />
    </AuthenticatedLayout>
  );
}

function EntryLanding({
  collectionName,
  entryId,
}: {
  collectionName: string;
  entryId: string;
}): React.ReactElement {
  const collectionsQuery = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await api.get<{ collections: Collection[] }>("/collections");
      return res.collections;
    },
  });
  if (collectionsQuery.isLoading) return <GateLoading />;
  if (shouldOpenParentWorkbench(collectionsQuery.data, collectionName)) {
    return <ParentEntryWorkbench collectionName={collectionName} entryId={entryId} />;
  }
  return <EntryEditView collectionName={collectionName} entryId={entryId} />;
}

function DeveloperWorkspace({ path }: { path: string }): React.ReactElement {
  const view = path === "/admin/dev" || path.startsWith("/admin/dev/overview/") ? <DeveloperOverviewView />
    : path === "/admin/dev/model" || path.startsWith("/admin/dev/model/") ? <DataModelView />
    : path === "/admin/dev/logic" || path.startsWith("/admin/dev/logic/") ? <LogicView />
    : path === "/admin/dev/docs" || path.startsWith("/admin/dev/docs/") ? <InterfaceDocsView />
    : <NotFoundView path={path} />;
  return <AuthenticatedLayout workspace="developer">{view}</AuthenticatedLayout>;
}
