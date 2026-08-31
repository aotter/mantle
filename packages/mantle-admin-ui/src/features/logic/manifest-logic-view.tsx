import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  Database,
  Eye,
  Network,
  Search,
  TriangleAlert,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { api } from "../../lib/api";
import type {
  DeveloperConsoleSnapshot,
  ManifestLogicEdge,
  ManifestLogicGraph,
  ManifestLogicKind,
  ManifestLogicNode,
} from "../../lib/types";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { cn } from "../../lib/utils";
import { ErrorBox, PageHeader } from "../../ui/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

const KINDS: readonly ManifestLogicKind[] = ["Trigger", "Procedure", "Schema", "View"];

const KIND_META: Record<ManifestLogicKind, { icon: LucideIcon; tone: string; dot: string }> = {
  Trigger: { icon: Zap, tone: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300", dot: "bg-amber-500" },
  Procedure: { icon: Braces, tone: "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300", dot: "bg-violet-500" },
  Schema: { icon: Database, tone: "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300", dot: "bg-sky-500" },
  View: { icon: Eye, tone: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
};

export interface LogicNeighborhood {
  selected: ManifestLogicNode | null;
  incoming: Array<{ edge: ManifestLogicEdge; node: ManifestLogicNode }>;
  outgoing: Array<{ edge: ManifestLogicEdge; node: ManifestLogicNode }>;
}

export function logicNeighborhood(graph: ManifestLogicGraph, selectedId: string): LogicNeighborhood {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return {
    selected: byId.get(selectedId) ?? null,
    incoming: graph.edges.flatMap((edge) => edge.to === selectedId && byId.has(edge.from)
      ? [{ edge, node: byId.get(edge.from)! }]
      : []),
    outgoing: graph.edges.flatMap((edge) => edge.from === selectedId && byId.has(edge.to)
      ? [{ edge, node: byId.get(edge.to)! }]
      : []),
  };
}

export function ManifestLogicView(): React.ReactElement {
  const { language } = usePreferences();
  const location = useAdminLocation();
  const { navigate } = useAdminRouter();
  const [search, setSearch] = React.useState("");
  const [kind, setKind] = React.useState<ManifestLogicKind | "all">("all");
  const graph = useQuery<DeveloperConsoleSnapshot>({
    queryKey: ["developer-console"],
    queryFn: () => api.get<DeveloperConsoleSnapshot>("/developer-console"),
  });
  const requestedId = new URLSearchParams(location.search).get("selected");
  const selected = graph.data?.nodes.find((node) => node.id === requestedId) ?? graph.data?.nodes[0] ?? null;
  const normalizedSearch = search.trim().toLowerCase();
  const visibleNodes = (graph.data?.nodes ?? []).filter((node) =>
    (kind === "all" || node.kind === kind)
    && (!normalizedSearch || `${node.name} ${node.detail} ${node.kind}`.toLowerCase().includes(normalizedSearch)),
  );
  const selectNode = (id: string): void => {
    navigate(`/admin/dev/logic?selected=${encodeURIComponent(id)}`, { replace: true });
  };

  return (
    <>
      <PageHeader
        eyebrow={t(language, "logic.eyebrow")}
        title={t(language, "logic.title")}
        description={t(language, "logic.description")}
        actions={<Button asChild variant="outline"><a href="/admin/dev"><ArrowLeft className="size-4" aria-hidden />{t(language, "logic.back")}</a></Button>}
      />
      {graph.isError ? <ErrorBox error={graph.error} /> : null}
      {graph.isLoading ? <Skeleton className="h-[36rem] w-full rounded-xl" /> : null}
      {graph.data && selected ? (
        <section className="overflow-hidden rounded-xl border bg-card/55" aria-label={t(language, "logic.canvasLabel")}>
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <Network className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-sm font-medium">{t(language, "logic.workbench")}</span>
            <Badge variant="secondary">{graph.data.nodes.length} {t(language, "logic.nodes")}</Badge>
            <Badge variant="outline">{graph.data.edges.length} {t(language, "logic.relations")}</Badge>
            <code className="ms-auto hidden max-w-48 truncate text-[10px] text-muted-foreground lg:block" title={graph.data.fingerprint}>{graph.data.fingerprint}</code>
          </div>

          <div className="grid min-h-[36rem] lg:grid-cols-[13rem_minmax(20rem,1fr)_15.5rem]">
            <aside className="border-b lg:border-b-0 lg:border-e" aria-label={t(language, "logic.nodeList")}>
              <div className="space-y-3 border-b p-3">
                <label className="relative block">
                  <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <span className="sr-only">{t(language, "logic.search")}</span>
                  <Input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder={t(language, "logic.search")} className="ps-9" />
                </label>
                <div className="flex flex-wrap gap-1">
                  <FilterButton active={kind === "all"} onClick={() => setKind("all")}>{t(language, "logic.all")}</FilterButton>
                  {KINDS.map((item) => <FilterButton key={item} active={kind === item} onClick={() => setKind(item)}>{item}</FilterButton>)}
                </div>
              </div>
              <div className="max-h-72 overflow-auto p-2 lg:max-h-[calc(100svh-20rem)]">
                {visibleNodes.length ? visibleNodes.map((node) => (
                  <NodeListButton key={node.id} node={node} selected={node.id === selected.id} onSelect={selectNode} />
                )) : <p className="p-4 text-center text-sm text-muted-foreground">{t(language, "logic.noResults")}</p>}
              </div>
            </aside>

            <div className="min-w-0 border-b bg-muted/20 p-4 lg:border-b-0 lg:border-e">
              <div className="mb-4">
                <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{t(language, "logic.oneHop")}</div>
                <p className="mt-1 text-sm text-muted-foreground">{t(language, "logic.oneHopBody")}</p>
              </div>
              <NeighborhoodMap graph={graph.data} selectedId={selected.id} onSelect={selectNode} />
            </div>

            <Inspector snapshot={graph.data} selected={selected} />
          </div>
        </section>
      ) : null}
    </>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.ReactElement {
  return <button type="button" onClick={onClick} aria-pressed={active} className={cn("rounded-md border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground")}>{children}</button>;
}

function NodeListButton({ node, selected, onSelect }: { node: ManifestLogicNode; selected: boolean; onSelect: (id: string) => void }): React.ReactElement {
  const meta = KIND_META[node.kind];
  return (
    <button type="button" onClick={() => onSelect(node.id)} aria-pressed={selected} className={cn("mb-1 flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected ? "border-border bg-accent text-accent-foreground" : "hover:bg-muted/70")}>
      <span className={cn("size-2 shrink-0 rounded-full", meta.dot)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs font-medium" title={node.name}>{node.name}</span>
        <span className="block truncate text-[11px] text-muted-foreground" title={`${node.kind} · ${node.detail}`}>{node.kind} · {node.detail}</span>
      </span>
    </button>
  );
}

function NeighborhoodMap({ graph, selectedId, onSelect }: { graph: ManifestLogicGraph; selectedId: string; onSelect: (id: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  const neighborhood = logicNeighborhood(graph, selectedId);
  if (!neighborhood.selected) return <></>;
  return (
    <div className="flex min-h-[27rem] flex-col justify-center">
      <div className="mx-auto w-full max-w-sm">
        <LogicNodeCard node={neighborhood.selected} selected onSelect={onSelect} />
      </div>
      <div className="mx-auto my-3 h-7 border-s border-dashed border-muted-foreground/50" aria-hidden />
      <div className="grid gap-4 sm:grid-cols-2">
        <RelationColumn label={t(language, "logic.dependsOn")} relations={neighborhood.incoming} onSelect={onSelect} />
        <RelationColumn label={t(language, "logic.usedBy")} relations={neighborhood.outgoing} onSelect={onSelect} />
      </div>
    </div>
  );
}

function RelationColumn({ label, relations, onSelect }: { label: string; relations: Array<{ edge: ManifestLogicEdge; node: ManifestLogicNode }>; onSelect: (id: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  return (
    <div className="min-w-0">
      <div className="mb-2 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="space-y-3">
        {relations.length ? relations.map(({ edge, node }) => (
          <div key={edge.id}>
            <div className="mb-1 text-center text-[10px] text-muted-foreground">{edge.label}</div>
            <LogicNodeCard node={node} onSelect={onSelect} />
          </div>
        )) : <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">{t(language, "logic.noRelations")}</div>}
      </div>
    </div>
  );
}

function LogicNodeCard({ node, selected = false, onSelect }: { node: ManifestLogicNode; selected?: boolean; onSelect: (id: string) => void }): React.ReactElement {
  const meta = KIND_META[node.kind];
  const Icon = meta.icon;
  return (
    <button type="button" onClick={() => onSelect(node.id)} aria-current={selected ? "true" : undefined} className={cn("flex w-full items-center gap-3 rounded-xl border bg-background/95 p-3 text-start shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected && "border-primary/50 ring-1 ring-primary/20")}>
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg border", meta.tone)}><Icon className="size-5" aria-hidden /></span>
      <span className="min-w-0">
        <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{node.kind}</span>
        <span className="block truncate font-mono text-sm font-semibold" title={node.name}>{node.name}</span>
        <span className="block truncate text-xs text-muted-foreground" title={node.detail}>{node.detail}</span>
      </span>
    </button>
  );
}

function Inspector({ snapshot, selected }: { snapshot: DeveloperConsoleSnapshot; selected: ManifestLogicNode }): React.ReactElement {
  const { language } = usePreferences();
  const neighborhood = logicNeighborhood(snapshot, selected.id);
  const surfaces = snapshot.surfaces.filter((surface) => surface.ownerId === selected.id);
  const opaque = selected.kind === "Procedure" && snapshot.limitations.opaqueProcedures.includes(selected.name);
  const native = selected.kind === "View" && snapshot.limitations.nativeViews.includes(selected.name);
  return (
    <aside className="space-y-5 p-4" aria-label={t(language, "logic.inspector")}>
      <div>
        <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{t(language, "logic.inspector")}</div>
        <div className="mt-2"><Badge variant="outline">{selected.kind}</Badge><code className="mt-2 block break-all text-sm font-semibold">{selected.name}</code></div>
        <p className="mt-2 text-sm text-muted-foreground">{selected.detail}</p>
      </div>

      {opaque || native ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
          <div className="flex items-center gap-2 font-medium"><TriangleAlert className="size-3.5" aria-hidden />{t(language, "logic.opaque")}</div>
          <p className="mt-1">{t(language, opaque ? "logic.opaqueProcedureBody" : "logic.nativeViewBody")}</p>
        </div>
      ) : null}

      <InspectorSection title={t(language, "logic.relatedSurfaces")}>
        {surfaces.length ? surfaces.map((surface) => (
          <div key={surface.id} className="rounded-lg border bg-muted/20 p-2.5">
            <div className="flex items-center gap-2"><Badge variant="secondary" className="text-[10px]">{surface.kind}</Badge>{surface.visibility ? <Badge variant="outline" className="text-[10px]">{surface.visibility}</Badge> : null}</div>
            <code className="mt-2 block break-words text-xs font-medium">{surface.name}</code>
            <div className="mt-1 text-xs text-muted-foreground">{surface.detail}</div>
          </div>
        )) : <p className="text-xs text-muted-foreground">{t(language, "logic.noSurfaces")}</p>}
      </InspectorSection>

      <InspectorSection title={t(language, "logic.relations")}>
        {[...neighborhood.incoming.map(({ edge, node }) => ({ key: edge.id, icon: ArrowLeft, label: edge.label, node })), ...neighborhood.outgoing.map(({ edge, node }) => ({ key: edge.id, icon: ArrowRight, label: edge.label, node }))].map(({ key, icon: Icon, label, node }) => (
          <div key={key} className="flex items-start gap-2 text-xs"><Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden /><span><strong>{label}</strong> <code>{node.name}</code></span></div>
        ))}
        {!neighborhood.incoming.length && !neighborhood.outgoing.length ? <p className="text-xs text-muted-foreground">{t(language, "logic.noRelations")}</p> : null}
      </InspectorSection>
    </aside>
  );
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return <section><h2 className="mb-2 text-xs font-semibold text-muted-foreground">{title}</h2><div className="space-y-2">{children}</div></section>;
}
