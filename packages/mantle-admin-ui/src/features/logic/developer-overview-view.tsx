import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { t } from "../../app/i18n";
import { usePreferences } from "../../app/preferences";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { developerConsoleQueryOptions } from "../../lib/queries";
import { ErrorBox } from "../../ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { AtomGraph } from "./atom-graph";
import { developerSelectionHref } from "./developer-route";

export function DeveloperOverviewView(): React.ReactElement {
  const { language } = usePreferences();
  const location = useAdminLocation();
  const { navigate } = useAdminRouter();
  const snapshot = useQuery(developerConsoleQueryOptions());
  const selectedId = new URLSearchParams(location.search).get("selected");

  if (snapshot.isError) return <div className="p-6"><ErrorBox error={snapshot.error} /></div>;
  if (snapshot.isLoading) return <Skeleton className="h-full w-full rounded-none" />;
  if (!snapshot.data) return <></>;

  return (
    <section className="relative h-full min-h-0" aria-label={t(language, "developer.graph.title")}>
      <AtomGraph
        graph={snapshot.data.graph}
        selectedAtomId={selectedId}
        onSelect={(id) => navigate(developerSelectionHref("/admin/dev", id))}
        onOpen={(atom) => navigate(developerSelectionHref("/admin/dev/model", atom.id))}
      />
    </section>
  );
}
