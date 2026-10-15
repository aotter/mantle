import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useProjectNav } from "../../app/project-nav";
import { usePreferences } from "../../app/preferences";
import { resolveLocalizedText } from "../../lib/localized-text";
import { siteQueryOptions } from "../../lib/queries";
import { PageHeader } from "../../ui/page";
import { NotFoundView } from "./not-found-view";

/** `/admin/p/<path>`: a page the application's `defineAdmin({ pages })` declared. */
export function ProjectPage({ path }: { path: string }): React.ReactElement {
  const { language } = usePreferences();
  const site = useQuery(siteQueryOptions());
  const page = useProjectNav().pages?.find((p) => p.path === path);
  if (!page) return <NotFoundView path={`/admin/p/${path}`} />;
  const title = resolveLocalizedText(page.title, language, site.data?.canonicalLocale ?? null) ?? page.path;
  return (
    <section aria-label={title}>
      <PageHeader title={title} />
      <React.Fragment key={page.path}>{page.element}</React.Fragment>
    </section>
  );
}
