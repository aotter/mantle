import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Braces } from "lucide-react";

import { t } from "../../app/i18n";
import { usePreferences } from "../../app/preferences";
import { useAdminRouter } from "../../app/router";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { DeveloperAtom, DeveloperAtomRelation, DeveloperConsoleSnapshot } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { atomKindTone, relationLabel } from "./atom-graph";
import { developerDetailHref, developerSelectionHref } from "./developer-route";

export function DeveloperRelations({ selectedId, graph }: { selectedId: string; graph: DeveloperConsoleSnapshot["graph"] }): React.ReactElement {
  const { language } = usePreferences();
  const { navigate } = useAdminRouter();
  const atoms = new Map(graph.atoms.map((atom) => [atom.id, atom]));
  const outgoing = graph.relations.filter(({ sourceId }) => sourceId === selectedId);
  const incoming = graph.relations.filter(({ targetId }) => targetId === selectedId);
  const count = outgoing.length + incoming.length;
  return (
    <aside className="flex min-h-0 flex-col" aria-label={t(language, "model.relationships")}>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-sm font-medium">{t(language, "model.relationships")}</h2>
        <span className="font-mono text-xs text-muted-foreground">{count}</span>
        <Button asChild variant="ghost" size="sm" className="ms-auto">
          <a href={developerSelectionHref("/admin/dev", selectedId)}><Braces aria-hidden />{t(language, "model.openGraph")}</a>
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {incoming.length ? <RelationGroup title={t(language, "developer.graph.comesFrom")} relations={incoming} outgoing={false} atoms={atoms} onSelect={(id) => navigate(developerDetailHref(id))} onOpenManifest={(id, pointer) => navigate(developerDetailHref(id, { tab: "manifest", pointer }))} /> : null}
        {outgoing.length ? <RelationGroup title={t(language, "developer.graph.continuesTo")} relations={outgoing} outgoing atoms={atoms} onSelect={(id) => navigate(developerDetailHref(id))} onOpenManifest={(id, pointer) => navigate(developerDetailHref(id, { tab: "manifest", pointer }))} /> : null}
        {!count ? <p className="text-sm text-muted-foreground">{t(language, "model.noRelations")}</p> : null}
      </div>
    </aside>
  );
}

function RelationGroup({ title, relations, outgoing, atoms, onSelect, onOpenManifest }: { title: string; relations: readonly DeveloperAtomRelation[]; outgoing: boolean; atoms: ReadonlyMap<string, DeveloperAtom>; onSelect: (id: string) => void; onOpenManifest: (id: string, pointer: string) => void }): React.ReactElement {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="space-y-2">
        {relations.map((relation) => {
          const atom = atoms.get(outgoing ? relation.targetId : relation.sourceId);
          return atom ? <RelationCard key={relation.id} relation={relation} atom={atom} outgoing={outgoing} onSelect={onSelect} onOpenManifest={onOpenManifest} /> : null;
        })}
      </div>
    </section>
  );
}

function RelationCard({ relation, atom, outgoing, onSelect, onOpenManifest }: { relation: DeveloperAtomRelation; atom: DeveloperAtom; outgoing: boolean; onSelect: (id: string) => void; onOpenManifest: (id: string, pointer: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  const title = resolveLocalizedText(atom.title, language);
  const DirectionIcon = outgoing ? ArrowDownRight : ArrowUpRight;
  return (
    <div className="rounded-lg border bg-card p-3">
      <button type="button" onClick={() => onSelect(atom.id)} className="flex w-full min-w-0 items-center gap-2 text-start hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <DirectionIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className={cn("inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", atomKindTone[atom.kind])}>{atom.kind}</span>
        <span className="min-w-0 truncate font-mono text-xs font-semibold">{atom.name}</span>
      </button>
      {title && title !== atom.name ? <div className="mt-1 truncate ps-5 text-xs text-muted-foreground">{title}</div> : null}
      <div className="mt-2 text-xs font-medium">{relationLabel(language, relation.kind)}</div>
      <button type="button" onClick={() => onOpenManifest(relation.sourceId, relation.pointer)} className="mt-2 block w-full rounded-md bg-muted/50 p-2 text-start hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t(language, "model.openDeclaration")}>
        <code className="block truncate text-[10px] text-muted-foreground">{relation.sourceId.replace(":", "/")}</code>
        <code className="mt-0.5 block break-all text-[10px]">{relation.pointer} = {JSON.stringify(relation.value)}</code>
      </button>
    </div>
  );
}
