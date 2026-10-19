import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { useAdminLocation, useAdminRouter } from "../../app/router";
import { developerConsoleQueryOptions } from "../../lib/queries";
import { ErrorBox } from "../../ui/page";
import { Skeleton } from "@aotter/mantle-ui/kit";
import { AtomGraph } from "./atom-graph";
import { developerDetailHref } from "./developer-route";
import { SchemaDiagram } from "./schema-diagram";
import { DeveloperOperations } from "./developer-operations";

export function DeveloperOverviewView(): React.ReactElement {
  const location = useAdminLocation();
  const { navigate } = useAdminRouter();
  const snapshot = useQuery(developerConsoleQueryOptions());
  const params = new URLSearchParams(location.search);
  const selectedId = params.get("selected");
  const updateQuery = (changes: Record<string, string | null>): void => {
    const next = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    navigate(`${location.pathname}?${next}`);
  };
  const relationships = location.pathname.endsWith("/relationships") || params.get("diagram") === "relationships";

  if (snapshot.isError) return <div className="p-6"><ErrorBox error={snapshot.error} /></div>;
  if (snapshot.isLoading) return <Skeleton className="h-full w-full rounded-none" />;
  if (!snapshot.data) return <></>;

  if (relationships) return <SchemaDiagram snapshot={snapshot.data} onOpen={(id) => navigate(developerDetailHref(id))} />;
  return <div className="flex h-full min-h-0 flex-col">
    <DeveloperOperations operations={snapshot.data.operations} />
    <div className="min-h-0 flex-1"><AtomGraph
      graph={snapshot.data.graph}
      schemas={snapshot.data.dataModel.schemas}
      selectedAtomId={selectedId}
      diagramMode={params.get("diagram")}
      onDiagramModeChange={(diagram) => updateQuery({ diagram, selected: null })}
      onSelect={(selected) => updateQuery({ selected })}
      onOpen={(atom) => navigate(developerDetailHref(atom.id))}
    /></div>
  </div>;
}
