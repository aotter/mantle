import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useProjectNav } from "../../app/project-nav";
import { usePreferences } from "../../app/preferences";
import { CustomPage } from "../../app/custom-page";
import { siteQueryOptions } from "../../lib/queries";
import { NotFoundView } from "./not-found-view";

/** `/admin/p/<path>`: a page the application's `defineAdmin({ pages })` declared. */
export function ProjectPage({ path }: { path: string }): React.ReactElement {
  const { language } = usePreferences();
  const site = useQuery(siteQueryOptions());
  const page = useProjectNav().pages?.find((p) => p.path === path);
  if (!page) return <NotFoundView path={`/admin/p/${path}`} />;
  return <CustomPage page={page} surface="browser" language={language} canonicalLocale={site.data?.canonicalLocale ?? null} />;
}
