import * as React from "react";
import { Background, Controls, ReactFlow, type ReactFlowInstance } from "@xyflow/react";
import { Maximize2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@aotter/mantle-ui/kit";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { DeveloperAtom, DeveloperSchemaModel } from "../../lib/types";
import { businessRules, type BusinessRule } from "./business-rules";
import { businessFlow, logicNodeTypes } from "./business-flow";

/**
 * The one Procedure-logic graph (#1892): `compact` in the system wiring side panel, `full` on the Procedure page. Both
 * read the same compiler projection and draw the same graph; selecting a node shows its rule below.
 */
export function ProcedureLogicPreview({ atom, schemas, density = "compact" }: { atom: DeveloperAtom; schemas: readonly DeveloperSchemaModel[]; density?: "compact" | "full" }): React.ReactElement | null {
  const { language, resolvedTheme } = usePreferences();
  const title = resolveLocalizedText(atom.title, language) || atom.name;
  const rules = React.useMemo(() => businessRules(atom, schemas, language), [atom, schemas, language]);
  const layout = React.useMemo(() => businessFlow(atom.id, rules, language), [atom.id, rules, language]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [expandedFlow, setExpandedFlow] = React.useState<ReactFlowInstance | null>(null);
  const expandedCanvasRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const canvas = expandedCanvasRef.current;
    if (!expandedFlow || !canvas) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        void expandedFlow.fitView({ padding: 0.08, maxZoom: 1 });
      });
    });
    observer.observe(canvas);
    return () => { observer.disconnect(); window.cancelAnimationFrame(frame); };
  }, [expandedFlow]);
  const selectedRule = (layout.nodes.find((node) => node.id === selectedId)?.data as { rule?: BusinessRule } | undefined)?.rule;
  if (atom.kind !== "Procedure" || atom.handler?.kind !== "sql" || layout.nodes.length < 2) return null;

  const canvas = (expanded: boolean) => <ReactFlow
    onInit={expanded ? setExpandedFlow : undefined}
    nodes={layout.nodes.map((node) => ({ ...node, selected: node.id === selectedId }))}
    edges={layout.edges} nodeTypes={logicNodeTypes} colorMode={resolvedTheme}
    fitView fitViewOptions={{ padding: 0.08, maxZoom: expanded || density === "full" ? 1 : 0.8 }}
    minZoom={0.08} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false}
    deleteKeyCode={null} onNodeClick={(_event, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId(null)}
    onKeyDownCapture={(event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const id = (event.target as HTMLElement).closest(".react-flow__node[data-id]")?.getAttribute("data-id");
      if (id) { event.preventDefault(); setSelectedId(id); }
    }}
  ><Background gap={24} size={1} /><Controls showInteractive={false} /></ReactFlow>;
  const details = selectedRule ? <div className="border-t px-3 py-3" aria-live="polite">
    <p className="text-sm font-medium">{selectedRule.title}</p>
    <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{selectedRule.body || selectedRule.summary}</p>
  </div> : null;

  return <section className="overflow-hidden rounded-lg border" aria-label={t(language, "developer.logic.title")}>
    <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
      <h3 className="text-sm font-semibold">{t(language, "developer.logic.title")}</h3>
      <Dialog>
        <DialogTrigger asChild><Button size="sm" variant="ghost"><Maximize2 aria-hidden />{t(language, "developer.logic.expand")}</Button></DialogTrigger>
        <DialogContent className="flex h-[90svh] w-[95vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none" closeLabel={t(language, "common.close")}>
          <div className="shrink-0 border-b px-5 py-3 pr-12">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="mt-1">{t(language, "developer.logic.legend")}</DialogDescription>
          </div>
          <div ref={expandedCanvasRef} className="min-h-0 flex-1" aria-label={t(language, "developer.logic.graphFull")}>{canvas(true)}</div>
          {selectedRule ? <div className="max-h-[25svh] shrink-0 overflow-auto">{details}</div> : null}
        </DialogContent>
      </Dialog>
    </div>
    <div className={density === "full" ? "h-[520px]" : "h-72"} aria-label={t(language, "developer.logic.graph")}>{canvas(false)}</div>
    {details}
  </section>;
}
