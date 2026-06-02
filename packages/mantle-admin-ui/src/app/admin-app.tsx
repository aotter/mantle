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
import { EditorView } from "../features/editor/editor-view";
import { MediaLibraryView } from "../features/media/media-library-view";
import { ApprovalsView } from "../features/system/approvals-view";
import { DeveloperLogsView } from "../features/system/developer-logs-view";
import { NotFoundView } from "../features/system/not-found-view";
import { PreferencesView } from "../features/system/preferences-view";
import { SettingsView } from "../features/system/settings-view";

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

  if (path === "/admin/editor") {
    return (
      <AuthenticatedLayout>
        <EditorView />
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

  if (path === "/admin/approvals") {
    return (
      <AuthenticatedLayout>
        <ApprovalsView />
      </AuthenticatedLayout>
    );
  }

  if (path === "/admin/developer-logs") {
    return (
      <AuthenticatedLayout>
        <DeveloperLogsView />
      </AuthenticatedLayout>
    );
  }

  return (
    <AuthenticatedLayout>
      <NotFoundView path={path} />
    </AuthenticatedLayout>
  );
}
