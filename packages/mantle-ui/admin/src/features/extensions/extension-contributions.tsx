import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Puzzle } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@aotter/mantle-ui/kit";
import type { AdminExtensionRecord, AdminExtensionSelection } from "@aotter/mantle-ui/extension";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api, ApiError, refusalOf } from "../../lib/api";
import { contributionByRef, contributionsOf, fieldContribution, matchesWhen, type ExtensionContribution } from "../../lib/extensions";
import { resolveLocalizedText } from "../../lib/localized-text";
import { siteQueryOptions } from "../../lib/queries";
import type { LocalizedText } from "../../lib/types";
import { useConfirm } from "../../ui/confirm-dialog";
import { SectionCard } from "../../ui/page";
import { ExtensionMount } from "./extension-mount";

type ActionTarget = "record/v1" | "list.selection/v1" | "list.toolbar/v1";

const offered = (when: { schema?: string[] } | undefined, schema: string) => !when?.schema || when.schema.includes(schema);

/**
 * The extension actions offered at one place (ADR-lite 1376): a record's header, a list's bulk bar or its toolbar.
 * `run` calls the server, `confirm` asks first, `dialog` renders the extension's own UI in an Admin dialog.
 */
export function ExtensionActions({ target, schema, record, selection, onDone, size }: {
  target: ActionTarget;
  schema: string;
  record?: AdminExtensionRecord;
  selection?: AdminExtensionSelection;
  onDone?: () => void;
  size?: "sm" | "default";
}): React.ReactElement | null {
  const { language } = usePreferences();
  const site = useQuery(siteQueryOptions());
  const canonical = site.data?.canonicalLocale ?? null;
  const confirm = useConfirm();
  const [dialog, setDialog] = React.useState<ExtensionContribution<"actions"> | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const actions = contributionsOf(site.data, "actions").filter((a) => a.target === target && offered(a.when, schema));
  if (actions.length === 0) return null;
  const label = (text: LocalizedText, fallback: string) => resolveLocalizedText(text, language, canonical) ?? fallback;

  const run = async (action: ExtensionContribution<"actions">) => {
    const title = label(action.title, action.id);
    if (action.presentation === "dialog") { setDialog(action); return; }
    if (action.presentation === "confirm" && !await confirm({ description: title })) return;
    setBusy(`${action.extension.id}/${action.id}`);
    try {
      const body = target === "record/v1" ? { record } : target === "list.selection/v1" ? { selection } : { schema };
      const out = await api.post<{ ok: true; result: unknown }>(`/x/${encodeURIComponent(action.extension.id)}/actions/${encodeURIComponent(action.id)}`, body);
      const message = (out.result as { message?: LocalizedText } | null)?.message;
      toast.success(message ? label(message, title) : t(language, "extension.actionDone", { action: title }));
      onDone?.();
    } catch (error) {
      const refusal = error instanceof ApiError ? refusalOf(error.body) : null;
      toast.error(refusal?.message ?? t(language, "extension.actionFailed", { action: title }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {actions.map((action) => (
        <Button key={`${action.extension.id}/${action.id}`} type="button" size={size} variant={action.destructive ? "destructive" : "secondary"}
          disabled={busy !== null} aria-busy={busy === `${action.extension.id}/${action.id}` || undefined} onClick={() => void run(action)}>
          <Puzzle className="size-4" aria-hidden />
          {label(action.title, action.id)}
        </Button>
      ))}
      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}>
        <DialogContent closeLabel={t(language, "common.close")} className="sm:max-w-2xl">
          {dialog ? (
            <>
              <DialogHeader>
                <DialogTitle>{label(dialog.title, dialog.id)}</DialogTitle>
                <DialogDescription className="sr-only">{label(dialog.extension.title, dialog.extension.id)}</DialogDescription>
              </DialogHeader>
              <ExtensionMount extension={dialog.extension} kind="actions" id={dialog.id}
                place={{ ...(record ? { record } : {}), ...(selection ? { selection } : {}), schema }}
                onClose={() => { setDialog(null); onDone?.(); }} />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Record side panels: the ones the Schema's `uiSchema.panels` names, then those whose `when` matches, each once. */
export function ExtensionPanels({ target, schema, uiSchema, record }: {
  target: "record.sidebar/v1" | "home/v1";
  schema?: string;
  uiSchema?: Record<string, unknown> | null;
  record?: AdminExtensionRecord;
}): React.ReactElement | null {
  const { language } = usePreferences();
  const site = useQuery(siteQueryOptions());
  const canonical = site.data?.canonicalLocale ?? null;
  const named = (Array.isArray(uiSchema?.["panels"]) ? uiSchema["panels"] as unknown[] : [])
    .map((ref) => contributionByRef(site.data, "panels", ref))
    .filter((p): p is ExtensionContribution<"panels"> => p !== undefined && p.target === target);
  // the home page has no Schema: every home panel shows there
  const matched = contributionsOf(site.data, "panels").filter((p) => p.target === target && (target === "home/v1" || matchesWhen(p.when, { schema: schema ?? "" })));
  const panels = [...named, ...matched].filter((p, i, all) => all.findIndex((x) => x.extension.id === p.extension.id && x.id === p.id) === i);
  if (panels.length === 0) return null;
  const Wrap = target === "home/v1" ? HomeGrid : React.Fragment;
  return (
    <Wrap>
      {panels.map((panel) => (
        <SectionCard key={`${panel.extension.id}/${panel.id}`}>
          <h2 className="mb-3 text-sm font-semibold">{resolveLocalizedText(panel.title, language, canonical) ?? panel.id}</h2>
          <ExtensionMount extension={panel.extension} kind="panels" id={panel.id} place={{ ...(record ? { record } : {}), ...(schema ? { schema } : {}) }} />
        </SectionCard>
      ))}
    </Wrap>
  );
}

function HomeGrid({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}

/** A list cell an extension renders (`field.cell/v1`), named in `uiSchema.list.cells` or matched by `when`; else `children`. */
export function ExtensionCell({ schema, field, value, property, cells, children }: {
  schema: string;
  field: string;
  value: unknown;
  property?: Record<string, unknown>;
  cells?: unknown;
  children: React.ReactNode;
}): React.ReactElement {
  const site = useQuery(siteQueryOptions());
  const ref = cells && typeof cells === "object" ? (cells as Record<string, unknown>)[field] : undefined;
  const cell = fieldContribution(site.data, "field.cell/v1", { schema, field, ...(property ? { property } : {}), ref });
  if (!cell) return <>{children}</>;
  return <ExtensionMount extension={cell.extension} kind="fields" id={cell.id} fallback={children}
    place={{ field: { schema, name: field, value, readOnly: true, property: property ?? {} } }} />;
}
