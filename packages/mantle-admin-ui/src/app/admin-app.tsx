import * as React from "react";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { AuthenticatedLayout } from "../layout/authenticated-layout";
import { api, ApiError } from "../lib/api";
import type { AdminUser } from "../lib/types";
import { useAdminLocation } from "./router";
import { AccessDeniedView, GateError, GateLoading, SignInView } from "../features/auth/auth-views";
import { HomeView } from "../features/console/home-view";
import { CollectionView } from "../features/content/collection-view";
import { EntryEditView } from "../features/content/entry-edit-view";
import { MediaLibraryView } from "../features/media/media-library-view";
import { ViewPage } from "../features/ops/view-page";
import { NotFoundView } from "../features/system/not-found-view";
import { PreferencesView } from "../features/system/preferences-view";
import { SettingsView } from "../features/system/settings-view";
import { StaffView } from "../features/system/staff-view";
import { MembersView } from "../features/system/members-view";
import { ManifestLogicView } from "../features/logic/manifest-logic-view";
import { DeveloperOverviewView } from "../features/logic/developer-overview-view";

export function AdminApp(): React.ReactElement {
  const location = useAdminLocation();

  if (location.pathname === "/admin/sign-in") {
    return <SignInView />;
  }

  return <Gate path={location.pathname} />;
}

function Gate({ path }: { path: string }): React.ReactElement {
  const me = useQuery<AdminUser>({
    queryKey: ["me"],
    queryFn: () => api.get<AdminUser>("/me"),
    retry: false,
  });

  const is401 = me.isError && me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (!is401 || typeof window === "undefined") return;
    const ret = window.location.pathname + window.location.search;
    window.location.href = `/admin/sign-in?return=${encodeURIComponent(ret)}`;
  }, [is401]);
  if (is401) return <GateLoading />;

  if (me.isError && me.error instanceof ApiError && me.error.status === 403) {
    const body = (me.error.body ?? {}) as { login?: string | null };
    return <AccessDeniedView login={body.login ?? null} />;
  }

  if (me.isError) {
    return <GateError error={me.error} />;
  }

  if (me.isLoading) return <GateLoading />;

  const collectionMatch = path.match(/^\/admin\/c\/([^/]+)\/?$/);
  if (collectionMatch) {
    return (
      <AuthenticatedLayout>
        <CollectionView collectionName={decodeURIComponent(collectionMatch[1]!)} />
      </AuthenticatedLayout>
    );
  }

  const entryMatch = path.match(/^\/admin\/c\/([^/]+)\/([^/]+)\/?$/);
  if (entryMatch) {
    const collectionName = decodeURIComponent(entryMatch[1]!);
    const entryId = decodeURIComponent(entryMatch[2]!);
    return (
      <AuthenticatedLayout>
        <EntryEditView collectionName={collectionName} entryId={entryId} />
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

  if (path === "/admin/dev") {
    return (
      <AuthenticatedLayout workspace="developer">
        <DeveloperOverviewView />
      </AuthenticatedLayout>
    );
  }

  if (path === "/admin/dev/logic") {
    return (
      <AuthenticatedLayout workspace="developer">
        <ManifestLogicView />
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
