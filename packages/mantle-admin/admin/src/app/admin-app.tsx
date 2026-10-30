import { entriesQueryArgsFromSearch, entriesQuerySearchParams, entriesQueryOptions, viewsManifestQueryOptions, withNavigationTools } from "../lib/queries";
import { canRenderAdmin } from "./frame-policy";
import { usePreferences } from "./preferences";
import { t } from "./i18n";
import * as React from "react";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AuthenticatedLayout } from "../layout/authenticated-layout";
import { api, ApiError } from "../lib/api";
import type { AdminUser, Collection, SiteInfo, AdminOperation, ViewManifestInfo } from "../lib/types";
import type { AdminToolCatalog } from "../lib/admin-tools";

import { useAdminLocation, useAdminRouter } from "./router";
import { useProjectNav } from "./project-nav";
import { landingUrl } from "../layout/authenticated-layout";
import { AccessDeniedView, GateError, GateLoading } from "../features/auth/gate-views";
// signed-out and OAuth pages: not on a signed-in user's first paint (input-otp, the sign-in flow, connected apps)
const auth = () => import("../features/auth/auth-views");
const SignInView = React.lazy(() => auth().then(module => ({ default: module.SignInView })));
const OAuthConsentView = React.lazy(() => auth().then(module => ({ default: module.OAuthConsentView })));
const ConnectedAppsPage = React.lazy(() => auth().then(module => ({ default: module.ConnectedAppsPage })));
const ConnectedAppsView = React.lazy(() => auth().then(module => ({ default: module.ConnectedAppsView })));
import { HomeView } from "../features/console/home-view";
const CollectionView = React.lazy(() => import("../features/content/collection-view").then(module => ({ default: module.CollectionView })));
import { Slot } from "./slots";
import type { CollectionListProps, RecordViewProps } from "./slot-props";
import { hasFoldedChildCollections } from "../lib/collection-nav";
import { NotFoundView } from "../features/system/not-found-view";

const EntryEditView = React.lazy(() => import("../features/content/entry-edit-view").then(module => ({ default: module.EntryEditView })));
const ParentEntryWorkbench = React.lazy(() => import("../features/content/parent-entry-workbench").then(module => ({ default: module.ParentEntryWorkbench })));
const MediaLibraryView = React.lazy(() => import("../features/media/media-library-view").then(module => ({ default: module.MediaLibraryView })));
const OperationsView = React.lazy(() => import("../features/ops/operations-view").then(module => ({ default: module.OperationsView })));
const ViewPage = React.lazy(() => import("../features/ops/view-page").then(module => ({ default: module.ViewPage })));
import { ProjectPage } from "../features/system/project-page";
const PreferencesView = React.lazy(() => import("../features/system/preferences-view").then(module => ({ default: module.PreferencesView })));
const SettingsView = React.lazy(() => import("../features/system/settings-view").then(module => ({ default: module.SettingsView })));
const AdminView = React.lazy(() => import("../features/system/admin-view").then(module => ({ default: module.AdminView })));
const MembersView = React.lazy(() => import("../features/system/members-view").then(module => ({ default: module.MembersView })));

const DeveloperWorkspace = React.lazy(() => import("../features/logic/developer-workspace"));

/**
 * Where the consent view renders: `/admin/oauth/consent` is Admin's own page, which `oauthProvider.consentPage` names
 * when a service mounts Admin; `/oauth/consent` is kept for a service that routes Core's consent URL to this shell.
 */
const CONSENT_PATHS = ["/admin/oauth/consent", "/oauth/consent"];

export function AdminApp({ preview = false }: { preview?: boolean } = {}): React.ReactElement | null {
  const location = useAdminLocation();

  // Static asset URLs can bypass the server's frame-ancestors headers.
  if (typeof window !== "undefined" && !canRenderAdmin(window, preview)) return null;

  if (preview && window.__MANTLE_ADMIN_PREVIEW__?.mode === "design" && !(location.pathname === "/admin/dev" || location.pathname.startsWith("/admin/dev/")) && location.pathname !== "/admin/preferences") {
    return <div className="p-6"><h1 className="text-xl font-semibold">Design workspace</h1><p className="mt-2">This design surface has no running service or business data. The host must provide a runtime surface to use Content Admin.</p><a className="mt-4 inline-block underline" href="/admin/dev">Return to the developer workspace</a></div>;
  }

  if (preview && ["/admin/sign-in", "/admin/connected-apps", ...CONSENT_PATHS].includes(location.pathname)) {
    return <PreviewAccountNotice />;
  }

  if (CONSENT_PATHS.includes(location.pathname)) return <React.Suspense fallback={<GateLoading />}><OAuthConsentView /></React.Suspense>;

  if (location.pathname === "/admin/sign-in") {
    return <React.Suspense fallback={<GateLoading />}><SignInView /></React.Suspense>;
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
  allCollections: Record<string, Collection>;
  site: SiteInfo;
  operations: AdminOperation[];
  views: ViewManifestInfo[];
  webmcp: AdminToolCatalog;
  entries?: import("../lib/types").ListEntriesResult;
}

function Gate({ path, search, preview }: { path: string; search: string; preview: boolean }): React.ReactElement {
  const queryClient = useQueryClient();
  const collectionMatch = path.match(/^\/admin\/c\/([^/]+)\/?$/);
  const params = new URLSearchParams(search);
  const useBootstrap = collectionMatch && !params.has("parent");
  const me = useQuery<AdminUser>({
    queryKey: ["me"],
    queryFn: async () => {
      if (!useBootstrap) return api.get<AdminUser>("/me");
      const args = entriesQueryArgsFromSearch(decodeURIComponent(collectionMatch![1]!), search);
      const data = await api.get<BootstrapPayload>(`/bootstrap?${entriesQuerySearchParams(args)}`);
      if (data.entries) queryClient.setQueryData(entriesQueryOptions(args).queryKey, { pages: [data.entries], pageParams: [undefined] });
      queryClient.setQueryData(["collections"], data.collections);
      queryClient.setQueryData(["site"], data.site);
      queryClient.setQueryData(["operations"], data.operations);
      queryClient.setQueryData(["views-manifest"], data.views);
      queryClient.setQueryData(["admin-webmcp"], withNavigationTools(data.webmcp));
      queryClient.setQueryData(["collection-metadata"], { collections: data.collections, allCollections: data.allCollections });
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
    if (path === "/admin/connected-apps") return <React.Suspense fallback={<GateLoading />}><ConnectedAppsPage /></React.Suspense>;
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
        <Slot name="CollectionList" Default={CollectionPage} props={{ collection: decodeURIComponent(collectionMatch[1]!) }} />
      </AuthenticatedLayout>
    );
  }

  const entryEditMatch = path.match(/^\/admin\/c\/([^/]+)\/([^/]+)\/edit\/?$/);
  if (entryEditMatch) {
    return (
      <AuthenticatedLayout>
        <Slot name="RecordView" Default={RecordPage} props={{ collection: decodeURIComponent(entryEditMatch[1]!), entryId: decodeURIComponent(entryEditMatch[2]!) }} />
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

  if (path === "/admin" || path === "/admin/") return <Landing />;

  if (path === "/admin/setup") {
    return (
      <AuthenticatedLayout>
        <HomePage />
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

  if (path === "/admin/admin") {
    return (
      <AuthenticatedLayout>
        <AdminView />
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

  if (path.startsWith("/admin/dev")) {
    return <React.Suspense fallback={<GateLoading />}><DeveloperWorkspace path={path} /></React.Suspense>;
  }

  const pageMatch = path.match(/^\/admin\/p\/([a-z0-9-]+)\/?$/);
  if (pageMatch) {
    return (
      <AuthenticatedLayout>
        <ProjectPage path={pageMatch[1]!} />
      </AuthenticatedLayout>
    );
  }

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
  if (hasFoldedChildCollections(collectionsQuery.data ?? [], collectionName)) {
    return <ParentEntryWorkbench collectionName={collectionName} entryId={entryId} />;
  }
  return <Slot name="RecordView" Default={RecordPage} props={{ collection: collectionName, entryId }} />;
}

function CollectionPage({ collection }: CollectionListProps): React.ReactElement {
  return <CollectionView collectionName={collection} />;
}

function RecordPage({ collection, entryId }: RecordViewProps): React.ReactElement {
  return <EntryEditView collectionName={collection} entryId={entryId} />;
}

/** `/admin`: the application's landing page (`defineAdmin` `home`) when the caller can see it, otherwise Admin's own home. */
function Landing(): React.ReactElement {
  const project = useProjectNav();
  const { navigate } = useAdminRouter();
  const collections = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => (await api.get<{ collections: Collection[] }>("/collections")).collections,
    enabled: !!project.home,
  });
  const views = useQuery<ViewManifestInfo[]>({ ...viewsManifestQueryOptions(), enabled: !!project.home });
  const url = landingUrl(project, collections.data ?? [], views.data ?? []);
  React.useEffect(() => { if (url) navigate(url, { replace: true }); }, [url, navigate]);
  if (project.home && (url || collections.isPending || views.isPending)) return <GateLoading />;
  return <AuthenticatedLayout><HomePage /></AuthenticatedLayout>;
}

function HomePage(): React.ReactElement {
  const collections = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => (await api.get<{ collections: Collection[] }>("/collections")).collections,
  });
  const site = useQuery<SiteInfo>({ queryKey: ["site"], queryFn: () => api.get<SiteInfo>("/site") });
  return <Slot name="Home" Default={HomeView} props={{ collections: collections.data ?? [], site: site.data }} />;
}
