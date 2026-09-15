import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { t } from "../../app/i18n";
import { usePreferences } from "../../app/preferences";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { developerConsoleQueryOptions } from "../../lib/queries";
import { ErrorBox } from "../../ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AtomGraph } from "./atom-graph";
import { developerDetailHref, developerSelectionHref } from "./developer-route";
import { SchemaDiagram } from "./schema-diagram";

export function DeveloperOverviewView(): React.ReactElement {
  const { language } = usePreferences();
  const location = useAdminLocation();
  const { navigate } = useAdminRouter();
  const snapshot = useQuery(developerConsoleQueryOptions());
  const params = new URLSearchParams(location.search);
  const selectedId = params.get("selected");
  const diagram = params.get("diagram") === "relationships" ? "relationships" : "flow";

  if (snapshot.isError) return <div className="p-6"><ErrorBox error={snapshot.error} /></div>;
  if (snapshot.isLoading) return <Skeleton className="h-full w-full rounded-none" />;
  if (!snapshot.data) return <></>;

  return (
    <section className="h-full min-h-0" aria-label={t(language, "developer.graph.title")}>
      <Tabs value={diagram} onValueChange={(value) => navigate(value === "relationships" ? "/admin/dev?diagram=relationships" : "/admin/dev")} className="grid h-full min-h-0 grid-rows-[2.75rem_minmax(0,1fr)] gap-0">
        <TabsList variant="line" className="h-11 w-full justify-start rounded-none border-b bg-background px-5">
          <TabsTrigger value="flow" className="flex-none">{t(language, "developer.graph.title")}</TabsTrigger>
          <TabsTrigger value="relationships" className="flex-none">{t(language, "model.relationships")}</TabsTrigger>
        </TabsList>
        <TabsContent value="flow" className="relative min-h-0">
          <AtomGraph
            graph={snapshot.data.graph}
            selectedAtomId={selectedId}
            onSelect={(id) => navigate(developerSelectionHref("/admin/dev", id))}
            onOpen={(atom) => navigate(developerDetailHref(atom.id))}
          />
        </TabsContent>
        <TabsContent value="relationships" className="relative min-h-0">
          <SchemaDiagram snapshot={snapshot.data} onOpen={(id) => navigate(developerDetailHref(id))} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
