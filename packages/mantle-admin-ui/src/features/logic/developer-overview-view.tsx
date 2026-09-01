import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { t } from "../../app/i18n";
import { usePreferences } from "../../app/preferences";
import { useAdminRouter } from "../../app/router";
import { developerConsoleQueryOptions } from "../../lib/queries";
import { ErrorBox } from "../../ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { AtomGraph } from "./atom-graph";

export function DeveloperOverviewView(): React.ReactElement {
  const { language } = usePreferences();
  const { navigate } = useAdminRouter();
  const snapshot = useQuery(developerConsoleQueryOptions());

  if (snapshot.isError) return <div className="p-6"><ErrorBox error={snapshot.error} /></div>;
  if (snapshot.isLoading) return <Skeleton className="h-full w-full rounded-none" />;
  if (!snapshot.data) return <></>;

  return (
    <section className="relative h-full min-h-0" aria-label={t(language, "developer.graph.title")}>
      <AtomGraph
        graph={snapshot.data.graph}
        onOpen={(atom) => navigate(`/admin/dev/model?selected=${encodeURIComponent(atom.id)}`)}
      />
    </section>
  );
}
