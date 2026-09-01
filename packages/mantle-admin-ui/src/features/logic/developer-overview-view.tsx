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
      <div className="pointer-events-none absolute start-4 top-4 z-10 max-w-sm rounded-xl border bg-background/90 px-4 py-3 shadow-lg backdrop-blur">
        <div className="flex items-center gap-2">
          <h1 className="font-semibold">{t(language, "developer.graph.title")}</h1>
          <span className="font-mono text-xs text-muted-foreground">{t(language, "developer.graph.counts", { atoms: String(snapshot.data.graph.atoms.length), relations: String(snapshot.data.graph.relations.length) })}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t(language, "developer.graph.direction")}</p>
      </div>
      <AtomGraph
        graph={snapshot.data.graph}
        onSelect={(atom) => navigate(`/admin/dev/model?selected=${encodeURIComponent(atom.id)}`)}
      />
    </section>
  );
}
