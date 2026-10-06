import * as React from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import { Maximize2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@aotter/mantle-ui/kit";
import { usePreferences } from "../../app/preferences";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { DeveloperAtom, DeveloperSchemaModel } from "../../lib/types";
import { businessRules, type BusinessRule } from "./business-rules";
import { businessFlow, BusinessRuleNode } from "./business-flow";

const nodeTypes = { businessRule: BusinessRuleNode };

/** A view of the sealed compiler projection, shared by the inspector and its modal. */
export function ProcedureLogicPreview({ atom, schemas }: { atom: DeveloperAtom; schemas: readonly DeveloperSchemaModel[] }): React.ReactElement | null {
  const { language, resolvedTheme } = usePreferences();
  const zh = language.startsWith("zh");
  const title = resolveLocalizedText(atom.title, language) || atom.name;
  const rules = React.useMemo(() => businessRules(atom, schemas, language), [atom, schemas, language]);
  const layout = React.useMemo(() => {
    const flow = businessFlow(atom.id, title, rules, zh);
    // The inspector already owns the title; no nested group heading in either canvas.
    const nodes = flow.nodes.map(({ parentId: _parent, extent: _extent, ...node }) => ({
      ...node, position: { ...node.position, y: node.position.y - 76 },
    }));
    return { nodes, edges: flow.edges };
  }, [atom.id, title, rules, zh]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selectedRule = layout.nodes.find((node) => node.id === selectedId)?.data.rule as BusinessRule | undefined;
  if (atom.kind !== "Procedure" || atom.handler?.kind !== "sql" || !layout.nodes.length) return null;

  const canvas = (expanded: boolean) => <ReactFlow
    nodes={layout.nodes.map((node) => ({ ...node, selected: node.id === selectedId }))}
    edges={layout.edges} nodeTypes={nodeTypes} colorMode={resolvedTheme}
    fitView fitViewOptions={{ padding: 0.12, maxZoom: expanded ? 1 : 0.65 }}
    minZoom={0.08} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false}
    deleteKeyCode={null} onNodeClick={(_event, node) => setSelectedId(node.id)}
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

  return <section className="overflow-hidden rounded-lg border" aria-label={zh ? "流程邏輯" : "Procedure logic"}>
    <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
      <h3 className="text-sm font-semibold">{zh ? "流程邏輯" : "Procedure logic"}</h3>
      <Dialog>
        <DialogTrigger asChild><Button size="sm" variant="ghost"><Maximize2 aria-hidden />{zh ? "放大" : "Expand"}</Button></DialogTrigger>
        <DialogContent className="flex h-[90svh] w-[95vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none" closeLabel={zh ? "關閉" : "Close"}>
          <div className="shrink-0 border-b px-5 py-3 pr-12">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="mt-1">{zh ? "流程邏輯：實線是資料操作順序，虛線是欄位值選擇。點選節點查看規則。" : "Procedure logic: solid lines show statement order; dashed lines select field values. Select a node for its rules."}</DialogDescription>
          </div>
          <div className="min-h-0 flex-1" aria-label={zh ? "完整流程邏輯圖" : "Full procedure logic graph"}>{canvas(true)}</div>
          {selectedRule ? <div className="max-h-[25svh] shrink-0 overflow-auto">{details}</div> : null}
        </DialogContent>
      </Dialog>
    </div>
    <div className="h-64" aria-label={zh ? "流程邏輯圖" : "Procedure logic graph"}>{canvas(false)}</div>
    {details}
  </section>;
}
