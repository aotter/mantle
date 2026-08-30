import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Braces, Database, Eye, Network, Zap, type LucideIcon } from "lucide-react";
import { api } from "../../lib/api";
import type {
  ManifestLogicGraph,
  ManifestLogicKind,
  ManifestLogicNode,
} from "../../lib/types";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { ErrorBox, PageHeader } from "../../ui/page";
import { Skeleton } from "@/components/ui/skeleton";

const KINDS: readonly ManifestLogicKind[] = ["Trigger", "Procedure", "Schema", "View"];
const NODE_WIDTH = 236;
const NODE_HEIGHT = 78;
const COLUMN_GAP = 88;
const ROW_GAP = 34;
const PADDING = 40;

const KIND_META: Record<ManifestLogicKind, { icon: LucideIcon; tone: string }> = {
  Trigger: { icon: Zap, tone: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  Procedure: { icon: Braces, tone: "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  Schema: { icon: Database, tone: "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  View: { icon: Eye, tone: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
};

export function ManifestLogicView(): React.ReactElement {
  const { language } = usePreferences();
  const graph = useQuery<ManifestLogicGraph>({
    queryKey: ["manifest-logic"],
    queryFn: () => api.get<ManifestLogicGraph>("/manifest-logic"),
  });

  return (
    <>
      <PageHeader
        eyebrow={t(language, "logic.eyebrow")}
        title={t(language, "logic.title")}
        description={t(language, "logic.description")}
      />
      {graph.isError ? <ErrorBox error={graph.error} /> : null}
      {graph.isLoading ? <Skeleton className="h-[36rem] w-full rounded-xl" /> : null}
      {graph.data ? <LogicCanvas graph={graph.data} label={t(language, "logic.canvasLabel")} /> : null}
    </>
  );
}

function LogicCanvas({ graph, label }: { graph: ManifestLogicGraph; label: string }): React.ReactElement {
  const positions = layoutNodes(graph.nodes);
  const maxRows = Math.max(...KINDS.map((kind) => graph.nodes.filter((node) => node.kind === kind).length), 1);
  const width = PADDING * 2 + KINDS.length * NODE_WIDTH + (KINDS.length - 1) * COLUMN_GAP;
  const height = PADDING * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * ROW_GAP + 44;

  return (
    <section className="overflow-hidden rounded-xl border bg-card/55" aria-label={label}>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Network className="size-4 text-muted-foreground" aria-hidden />
        {KINDS.map((kind) => (
          <span key={kind} className="rounded-full border bg-background/70 px-2.5 py-1 text-xs text-muted-foreground">
            {kind} <strong className="ms-1 text-foreground">{graph.nodes.filter((node) => node.kind === kind).length}</strong>
          </span>
        ))}
        <code className="ms-auto hidden max-w-48 truncate text-[10px] text-muted-foreground sm:block" title={graph.fingerprint}>
          {graph.fingerprint}
        </code>
      </div>
      <div className="max-h-[calc(100svh-15rem)] min-h-[36rem] overflow-auto bg-muted/20">
        <div
          className="relative"
          style={{
            width,
            height,
            backgroundImage: "radial-gradient(color-mix(in srgb, var(--muted-foreground) 22%, transparent) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
          }}
        >
          <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden>
            <defs>
              <marker id="logic-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground/70" />
              </marker>
            </defs>
            {graph.edges.map((edge, index) => {
              const from = positions.get(edge.from);
              const to = positions.get(edge.to);
              if (!from || !to) return null;
              const path = edgePath(from, to);
              return (
                <g key={edge.id}>
                  <path id={`logic-edge-${index}`} d={path} fill="none" className="stroke-muted-foreground/55" strokeWidth="1.5" markerEnd="url(#logic-arrow)" />
                  <text className="fill-muted-foreground text-[10px]" style={{ paintOrder: "stroke", stroke: "var(--background)", strokeWidth: 4 }}>
                    <textPath href={`#logic-edge-${index}`} startOffset="50%" textAnchor="middle">{edge.label}</textPath>
                  </text>
                </g>
              );
            })}
          </svg>
          {graph.nodes.map((node) => {
            const position = positions.get(node.id)!;
            return <LogicNodeCard key={node.id} node={node} x={position.x} y={position.y} />;
          })}
        </div>
      </div>
    </section>
  );
}

function LogicNodeCard({ node, x, y }: { node: ManifestLogicNode; x: number; y: number }): React.ReactElement {
  const meta = KIND_META[node.kind];
  const Icon = meta.icon;
  return (
    <article
      className="absolute flex items-center gap-3 rounded-xl border bg-background/95 p-3 shadow-sm backdrop-blur"
      style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}
      aria-label={`${node.kind} ${node.name}: ${node.detail}`}
    >
      <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg border ${meta.tone}`}>
        <Icon className="size-5" aria-hidden />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{node.kind}</div>
        <div className="truncate font-mono text-sm font-semibold" title={node.name}>{node.name}</div>
        <div className="truncate text-xs text-muted-foreground" title={node.detail}>{node.detail}</div>
      </div>
    </article>
  );
}

function layoutNodes(nodes: readonly ManifestLogicNode[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  for (const [column, kind] of KINDS.entries()) {
    nodes.filter((node) => node.kind === kind).forEach((node, row) => {
      positions.set(node.id, {
        x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + 44 + row * (NODE_HEIGHT + ROW_GAP),
      });
    });
  }
  return positions;
}

function edgePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  if (from.x === to.x) {
    const sx = from.x + NODE_WIDTH / 2;
    const sy = from.y + NODE_HEIGHT;
    const tx = to.x + NODE_WIDTH / 2;
    const ty = to.y;
    const bend = Math.max(36, Math.abs(ty - sy) / 2);
    return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx + bend} ${ty}, ${tx} ${ty}`;
  }
  const sx = from.x + NODE_WIDTH;
  const sy = from.y + NODE_HEIGHT / 2;
  const tx = to.x;
  const ty = to.y + NODE_HEIGHT / 2;
  const bend = Math.max(52, Math.abs(tx - sx) * 0.42);
  return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`;
}
