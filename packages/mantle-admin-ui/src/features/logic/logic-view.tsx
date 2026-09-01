import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronRight, Link2, Search, Workflow, Zap, type LucideIcon } from "lucide-react";

import { t } from "../../app/i18n";
import { usePreferences } from "../../app/preferences";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { resolveLocalizedText } from "../../lib/localized-text";
import { developerConsoleQueryOptions } from "../../lib/queries";
import type {
  DeveloperAtom,
  DeveloperConsoleSnapshot,
  DeveloperProcedureModel,
  DeveloperTriggerModel,
  JsonSchema,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import { ErrorBox } from "../../ui/page";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SidebarContent, SidebarHeader, SidebarInput } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { atomKindTone, audienceLabel, focusSlice, traceAtomIds } from "./atom-graph";
import { CodeTab, FactGrid, flattenSchemaFields } from "./data-model-view";
import { DeveloperRelations } from "./developer-relations";
import { developerDetailHref, developerSelectionHref } from "./developer-route";

type LogicItem =
  | { kind: "Trigger"; id: string; model: DeveloperTriggerModel }
  | { kind: "Procedure"; id: string; model: DeveloperProcedureModel };

export function LogicView(): React.ReactElement {
  const { language } = usePreferences();
  const location = useAdminLocation();
  const { navigate } = useAdminRouter();
  const [search, setSearch] = React.useState("");
  const snapshot = useQuery(developerConsoleQueryOptions());
  const items: LogicItem[] = snapshot.data ? [
    ...snapshot.data.logic.triggers.map((model) => ({ kind: "Trigger" as const, id: `Trigger:${model.name}`, model })),
    ...snapshot.data.logic.procedures.map((model) => ({ kind: "Procedure" as const, id: `Procedure:${model.name}`, model })),
  ] : [];
  const params = new URLSearchParams(location.search);
  const selected = items.find(({ id }) => id === params.get("selected")) ?? items[0] ?? null;
  const manifestOpen = params.get("tab") === "manifest";
  const manifestFocus = manifestOpen ? params.get("pointer") : null;
  const query = search.trim().toLowerCase();
  const visibleItems = query
    ? items.filter((item) => `${item.kind} ${item.model.name} ${item.kind === "Procedure" ? resolveLocalizedText(item.model.title, language) ?? "" : item.model.source.kind}`.toLowerCase().includes(query))
    : items;

  if (snapshot.isError) return <div className="p-6"><ErrorBox error={snapshot.error} /></div>;
  if (snapshot.isLoading) return <Skeleton className="h-full w-full rounded-none" />;
  if (!snapshot.data || !selected) return <></>;

  return (
    <section className="grid h-full min-h-0 grid-cols-[15rem_minmax(0,1fr)]" aria-label={t(language, "logic.title")}>
      <LogicSidebar items={visibleItems} selectedId={selected.id} search={search} onSearch={setSearch} onSelect={(id) => navigate(developerSelectionHref("/admin/dev/logic", id))} />
      <div className="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(28rem,1fr)_24rem] xl:grid-rows-1">
        <main className="min-w-0 overflow-y-auto border-b xl:border-e xl:border-b-0">
          <LogicDefinition key={`${selected.id}:${manifestFocus ?? ""}`} item={selected} snapshot={snapshot.data} manifestOpen={manifestOpen} manifestFocus={manifestFocus} onNavigate={(id) => navigate(developerDetailHref(id))} />
        </main>
        <DeveloperRelations selectedId={selected.id} graph={snapshot.data.graph} />
      </div>
    </section>
  );
}

function LogicSidebar({ items, selectedId, search, onSearch, onSelect }: { items: LogicItem[]; selectedId: string; search: string; onSearch: (value: string) => void; onSelect: (id: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  return (
    <aside className="flex min-h-0 flex-col border-e bg-sidebar text-sidebar-foreground" aria-label={t(language, "logic.objects")}>
      <SidebarHeader className="border-b border-sidebar-border">
        <label className="relative">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <span className="sr-only">{t(language, "logic.search")}</span>
          <SidebarInput value={search} onChange={(event) => onSearch(event.currentTarget.value)} placeholder={t(language, "logic.search")} className="ps-8" />
        </label>
      </SidebarHeader>
      <SidebarContent className="gap-0 p-2">
        <LogicGroup title={t(language, "logic.triggers")} icon={Zap} items={items.filter((item) => item.kind === "Trigger")} selectedId={selectedId} onSelect={onSelect} />
        <LogicGroup title={t(language, "logic.procedures")} icon={Workflow} items={items.filter((item) => item.kind === "Procedure")} selectedId={selectedId} onSelect={onSelect} />
      </SidebarContent>
    </aside>
  );
}

function LogicGroup({ title, icon: Icon, items, selectedId, onSelect }: { title: string; icon: LucideIcon; items: LogicItem[]; selectedId: string; onSelect: (id: string) => void }): React.ReactElement {
  return (
    <Collapsible defaultOpen className="group/logic mb-1">
      <CollapsibleTrigger className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
        <Icon className="size-4" aria-hidden />
        <span className="flex-1 text-start">{title}</span>
        <span className="font-mono text-[10px] text-sidebar-foreground/60">{items.length}</span>
        <ChevronRight className="size-4 transition-transform group-data-[state=open]/logic:rotate-90" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent className="ms-4 border-s border-sidebar-border ps-2">
        {items.map((item) => (
          <button key={item.id} type="button" onClick={() => onSelect(item.id)} aria-pressed={item.id === selectedId} className={cn("mt-1 flex h-8 w-full items-center gap-2 rounded-md px-2 text-start hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring", item.id === selectedId && "bg-sidebar-accent font-medium text-sidebar-accent-foreground")}>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{item.model.name}</span>
            <span className="shrink-0 font-mono text-[9px] uppercase text-sidebar-foreground/55">{item.kind === "Trigger" ? item.model.source.kind : item.model.handler.kind}</span>
          </button>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function LogicDefinition({ item, snapshot, manifestOpen, manifestFocus, onNavigate }: { item: LogicItem; snapshot: DeveloperConsoleSnapshot; manifestOpen: boolean; manifestFocus: string | null; onNavigate: (id: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  const procedure = item.kind === "Procedure" ? item.model : snapshot.logic.procedures.find(({ name }) => name === item.model.target) ?? null;
  const title = item.kind === "Procedure" ? resolveLocalizedText(item.model.title, language) : null;
  const description = item.kind === "Procedure" ? resolveLocalizedText(item.model.description, language) : null;
  const atom = snapshot.graph.atoms.find(({ id }) => id === item.id);
  const summary = description || (item.kind === "Trigger"
    ? t(language, "developer.graph.summary.trigger", { audience: audienceLabel(language, item.model.audience), transport: item.model.source.kind.toUpperCase(), target: item.model.target })
    : item.model.handler.kind === "builtin"
    ? t(language, "developer.graph.summary.builtin", { op: item.model.handler.op, schema: item.model.handler.schema })
    : t(language, "developer.graph.summary.ref", { ref: item.model.handler.ref }));
  const [tab, setTab] = React.useState(manifestOpen ? "manifest" : "overview");
  return (
    <>
      <div className="flex min-h-14 items-center gap-3 border-b px-5 py-3">
        <span className={cn("inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", atomKindTone[item.kind])}>{item.kind}</span>
        <h1 className="min-w-0 truncate font-mono text-sm font-semibold">{item.model.name}</h1>
        {title && title !== item.model.name ? <span className="truncate text-sm text-muted-foreground">{title}</span> : null}
      </div>
      <Tabs value={tab} onValueChange={setTab} className="gap-0">
        <TabsList variant="line" className="h-10 w-full justify-start rounded-none border-b px-5">
          <TabsTrigger value="overview" className="flex-none px-3">{t(language, "logic.overview")}</TabsTrigger>
          <TabsTrigger value="contract" className="flex-none px-3">{t(language, "logic.contract")}</TabsTrigger>
          <TabsTrigger value="manifest" className="flex-none px-3">{t(language, "model.manifest")}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-6 p-5">
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{summary}</p>
          {atom ? <ExecutionStrip selectedId={item.id} graph={snapshot.graph} onNavigate={onNavigate} /> : null}
          <section className="space-y-3">
            <h2 className="text-sm font-medium">{t(language, "logic.configuration")}</h2>
            <FactGrid entries={item.kind === "Trigger" ? triggerFacts(language, item.model) : procedureFacts(language, item.model)} />
          </section>
          {procedure ? <Authorization predicates={procedure.authorization} guard={procedure.guard} /> : null}
        </TabsContent>
        <TabsContent value="contract" className="space-y-7 p-5">
          {item.kind === "Trigger" && procedure ? <p className="text-sm text-muted-foreground">{t(language, "logic.contractFrom", { target: procedure.name })}</p> : null}
          {procedure ? (
            <>
              <ContractTable title={t(language, "logic.input")} schema={procedure.input} onNavigate={onNavigate} />
              <ContractTable title={t(language, "logic.output")} schema={procedure.output} onNavigate={onNavigate} />
            </>
          ) : <p className="text-sm text-muted-foreground">{t(language, "logic.noContract")}</p>}
        </TabsContent>
        <TabsContent value="manifest"><CodeTab value={item.model.manifest} label={t(language, "model.compiledManifest")} focus={manifestFocus} /></TabsContent>
      </Tabs>
    </>
  );
}

function ExecutionStrip({ selectedId, graph, onNavigate }: { selectedId: string; graph: DeveloperConsoleSnapshot["graph"]; onNavigate: (id: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  const slice = focusSlice(graph, selectedId);
  const atoms = new Map(graph.atoms.map((atom) => [atom.id, atom]));
  const trace = traceAtomIds(graph, slice.nodeIds, slice.startId).map((id) => atoms.get(id)).filter((atom): atom is DeveloperAtom => Boolean(atom));
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">{t(language, "logic.execution")}</h2>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/20 p-3">
        {trace.map((atom, index) => (
          <React.Fragment key={atom.id}>
            {index ? <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
            <button type="button" onClick={() => onNavigate(atom.id)} className={cn("min-w-0 max-w-52 rounded-lg border bg-card px-3 py-2 text-start shadow-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", atom.id === selectedId && "ring-2 ring-primary/50")}>
              <span className={cn("inline-flex rounded border px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wider", atomKindTone[atom.kind])}>{atom.kind}</span>
              <span className="mt-1 block truncate font-mono text-xs font-semibold">{atom.name}</span>
            </button>
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function Authorization({ predicates, guard }: { predicates: unknown[]; guard: string | null }): React.ReactElement {
  const { language } = usePreferences();
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">{t(language, "logic.authorization")}</h2>
      <div className="rounded-lg border bg-card p-3">
        {predicates.length ? <div className="flex flex-wrap gap-2">{predicates.map((predicate, index) => <Badge key={index} variant="secondary" className="font-mono text-[10px]">{formatPredicate(predicate)}</Badge>)}</div> : <p className="text-sm text-muted-foreground">{t(language, "logic.noAuthorization")}</p>}
        {guard ? <p className="mt-3 text-xs text-muted-foreground">{t(language, "logic.guard")}: <code className="text-foreground">{guard}</code></p> : null}
      </div>
    </section>
  );
}

function ContractTable({ title, schema, onNavigate }: { title: string; schema: JsonSchema; onNavigate: (id: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  const fields = flattenSchemaFields(schema);
  return (
    <section>
      <h2 className="mb-3 text-sm font-medium">{title}</h2>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader><TableRow><TableHead>{t(language, "model.path")}</TableHead><TableHead>{t(language, "model.type")}</TableHead><TableHead>{t(language, "model.required")}</TableHead><TableHead>{t(language, "model.constraints")}</TableHead></TableRow></TableHeader>
          <TableBody>
            {fields.map((field) => (
              <TableRow key={field.path}>
                <TableCell><span className="font-mono text-xs">{field.path}</span>{field.reference ? <button type="button" className="ms-2 inline-flex rounded p-0.5 text-violet-600 hover:bg-violet-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-violet-300" onClick={() => onNavigate(`Schema:${field.reference}`)} aria-label={t(language, "model.marker.reference", { target: field.reference })}><Link2 className="size-3.5" aria-hidden /></button> : null}</TableCell>
                <TableCell><Badge variant="secondary" className="font-mono text-[10px]">{field.type}</Badge></TableCell>
                <TableCell>{field.required ? t(language, "common.yes") : "—"}</TableCell>
                <TableCell className="max-w-md whitespace-normal text-xs text-muted-foreground">{field.constraints.length ? field.constraints.join(" · ") : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!fields.length ? <p className="p-4 text-sm text-muted-foreground">{t(language, "model.noFields")}</p> : null}
      </div>
    </section>
  );
}

function triggerFacts(language: ReturnType<typeof usePreferences>["language"], model: DeveloperTriggerModel): Array<[string, string]> {
  const base: Array<[string, string]> = [
    [t(language, "logic.target"), model.target],
    [t(language, "developer.graph.fact.audience"), audienceLabel(language, model.audience)],
    [t(language, "developer.graph.fact.transport"), model.source.kind.toUpperCase()],
  ];
  if (model.source.kind === "http") return [...base, [t(language, "logic.method"), model.source.method], [t(language, "model.path"), model.source.path]];
  if (model.source.kind === "mcp") return [...base, [t(language, "logic.surface"), model.source.surface]];
  return [...base, [t(language, "developer.graph.fact.schema"), model.source.schema], [t(language, "logic.hooks"), model.source.on.join(", ")], [t(language, "logic.errorPolicy"), model.source.errorPolicy ?? "—"]];
}

function procedureFacts(language: ReturnType<typeof usePreferences>["language"], model: DeveloperProcedureModel): Array<[string, string]> {
  const base: Array<[string, string]> = [
    [t(language, "developer.graph.fact.audience"), audienceLabel(language, model.audience)],
    [t(language, "developer.graph.fact.handler"), model.handler.kind === "builtin" ? t(language, "developer.graph.builtin") : model.handler.ref],
  ];
  return model.handler.kind === "builtin" ? [
    ...base,
    [t(language, "developer.graph.fact.operation"), model.handler.op],
    [t(language, "developer.graph.fact.schema"), model.handler.schema],
    [t(language, "developer.graph.fact.match"), model.handler.match?.join(" + ") ?? "—"],
  ] : base;
}

function formatPredicate(predicate: unknown): string {
  return typeof predicate === "string" ? predicate : JSON.stringify(predicate);
}
