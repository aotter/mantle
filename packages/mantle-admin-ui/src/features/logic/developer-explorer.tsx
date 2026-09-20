import * as React from "react";
import { Braces, ListTree, PanelRight } from "lucide-react";

import { t } from "../../app/i18n";
import { usePreferences } from "../../app/preferences";
import type { DeveloperConsoleSnapshot } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DeveloperRelations } from "./developer-relations";
import { developerSelectionHref } from "./developer-route";

export function DeveloperExplorer({ label, sidebarLabel, sidebar, selectedId, graph, children }: { label: string; sidebarLabel: string; sidebar: React.ReactNode; selectedId: string; graph: DeveloperConsoleSnapshot["graph"]; children: React.ReactNode }): React.ReactElement {
  const { language } = usePreferences();
  const [relationsOpen, setRelationsOpen] = React.useState(false);
  const relationCount = graph.relations.filter(({ sourceId, targetId }) => sourceId === selectedId || targetId === selectedId).length;
  return (
    <section className="@container/explorer h-full min-h-0" aria-label={label}>
      <div className="grid h-full min-h-0 grid-cols-1 @min-[42rem]/explorer:grid-cols-[15rem_minmax(0,1fr)]">
        <div className="hidden min-h-0 @min-[42rem]/explorer:block">{sidebar}</div>
        <div className="grid min-h-0 grid-cols-1 @min-[64rem]/explorer:grid-cols-[minmax(28rem,1fr)_24rem]">
          <div className="relative min-h-0 min-w-0">
            <div className="absolute end-4 top-2.5 z-20 flex items-center gap-1">
              <Sheet key={`objects:${selectedId}`}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SheetTrigger asChild><Button type="button" variant="ghost" size="icon-sm" className="@min-[42rem]/explorer:hidden" aria-label={sidebarLabel}><ListTree aria-hidden /></Button></SheetTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{sidebarLabel}</TooltipContent>
                </Tooltip>
                <SheetContent side="left" closeLabel={t(language, "common.close")} className="w-[19rem] gap-0 bg-sidebar p-0 sm:max-w-[19rem]">
                  <SheetHeader className="sr-only"><SheetTitle>{sidebarLabel}</SheetTitle><SheetDescription>{sidebarLabel}</SheetDescription></SheetHeader>
                  {sidebar}
                </SheetContent>
              </Sheet>
              <Sheet open={relationsOpen} onOpenChange={setRelationsOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SheetTrigger asChild><Button type="button" variant="ghost" size="sm" className="@min-[64rem]/explorer:hidden" aria-label={`${t(language, "model.relationships")} ${relationCount}`}><PanelRight aria-hidden /><span className="font-mono text-xs">{relationCount}</span></Button></SheetTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t(language, "model.relationships")}</TooltipContent>
                </Tooltip>
                <SheetContent side="right" closeLabel={t(language, "common.close")} className="w-full gap-0 p-0 sm:max-w-[26rem]">
                  <SheetHeader className="sr-only"><SheetTitle>{t(language, "model.relationships")}</SheetTitle><SheetDescription>{t(language, "model.relationships")}</SheetDescription></SheetHeader>
                  <DeveloperRelations selectedId={selectedId} graph={graph} onNavigate={() => setRelationsOpen(false)} />
                </SheetContent>
              </Sheet>
              <Tooltip>
                <TooltipTrigger asChild><Button asChild variant="ghost" size="icon-sm"><a href={developerSelectionHref("/admin/dev", selectedId)} aria-label={t(language, "model.openGraph")}><Braces aria-hidden /></a></Button></TooltipTrigger>
                <TooltipContent>{t(language, "model.openGraph")}</TooltipContent>
              </Tooltip>
            </div>
            <main className="h-full min-w-0 overflow-y-auto @min-[64rem]/explorer:border-e">{children}</main>
          </div>
          <div className="hidden min-h-0 @min-[64rem]/explorer:block"><DeveloperRelations selectedId={selectedId} graph={graph} /></div>
        </div>
      </div>
    </section>
  );
}
