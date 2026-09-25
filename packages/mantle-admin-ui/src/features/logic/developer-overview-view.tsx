import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { useAdminLocation, useAdminRouter } from "../../app/router";
import { developerConsoleQueryOptions } from "../../lib/queries";
import { ErrorBox } from "../../ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { AtomGraph } from "./atom-graph";
import { developerDetailHref, developerSelectionHref } from "./developer-route";
import { SchemaDiagram } from "./schema-diagram";
import { DeveloperOperations } from "./developer-operations";

export function DeveloperOverviewView(): React.ReactElement {
  const location = useAdminLocation();
  const { navigate } = useAdminRouter();
  const snapshot = useQuery(developerConsoleQueryOptions());
  const params = new URLSearchParams(location.search);
  const selectedId = params.get("selected");
  const relationships = location.pathname.endsWith("/relationships") || params.get("diagram") === "relationships";

  if (snapshot.isError) return <div className="p-6"><ErrorBox error={snapshot.error} /></div>;
  if (snapshot.isLoading) return <Skeleton className="h-full w-full rounded-none" />;
  if (!snapshot.data) return <></>;

  if (relationships) return <SchemaDiagram snapshot={snapshot.data} onOpen={(id) => navigate(developerDetailHref(id))} />;
  return <div className="flex h-full min-h-0 flex-col">
    <DeveloperOperations operations={snapshot.data.operations} />
    <div className="min-h-0 flex-1"><AtomGraph
      graph={snapshot.data.graph}
      selectedAtomId={selectedId}
      onSelect={(id) => navigate(developerSelectionHref("/admin/dev/overview/flow", id))}
      onOpen={(atom) => navigate(developerDetailHref(atom.id))}
    /></div>
  </div>;
}
