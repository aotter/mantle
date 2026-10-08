import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { Button, Skeleton } from "@aotter/mantle-ui/kit";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api, ApiError } from "../../lib/api";
import { extensionsOf } from "../../lib/extensions";
import { resolveLocalizedText } from "../../lib/localized-text";
import { siteQueryOptions } from "../../lib/queries";
import type { AdminExtensionInfo, JsonSchema } from "../../lib/types";
import { ErrorBox, FormActionBar, PageHeader, SectionCard } from "../../ui/page";
import { SchemaFields } from "../content/entry-edit-view";
import { ExtensionMount } from "../extensions/extension-mount";
import { NotFoundView } from "./not-found-view";

/**
 * `/admin/x/{extension}/{contribution}`: an extension's page, which its module renders, or its settings, which Admin
 * renders from the declared schema (ADR-lite 1376). Only contributions the server listed for this staff member exist.
 */
export function ExtensionPage({ extension: extensionId, contribution }: { extension: string; contribution: string }): React.ReactElement {
  const { language } = usePreferences();
  const site = useQuery(siteQueryOptions());
  const canonical = site.data?.canonicalLocale ?? null;
  const extension = extensionsOf(site.data).find((e) => e.id === extensionId);
  const page = extension?.contributes.pages.find((p) => p.id === contribution);
  const settings = extension?.contributes.settings.find((s) => s.id === contribution);

  if (site.isPending) return <Skeleton className="h-40 w-full" />;
  if (!extension || (!page && !settings)) return <NotFoundView path={`/admin/x/${extensionId}/${contribution}`} />;
  const title = resolveLocalizedText((page ?? settings)!.title, language, canonical) ?? contribution;
  const eyebrow = resolveLocalizedText(extension.title, language, canonical) ?? extension.id;
  if (page) {
    return (
      <section aria-label={title}>
        <PageHeader eyebrow={eyebrow} title={title} />
        <ExtensionMount key={`${extension.id}/${page.id}`} extension={extension} kind="pages" id={page.id} />
      </section>
    );
  }
  return <ExtensionSettings extension={extension} id={settings!.id} schema={settings!.schema} title={title} eyebrow={eyebrow} />;
}

function ExtensionSettings({ extension, id, schema, title, eyebrow }: { extension: AdminExtensionInfo; id: string; schema: JsonSchema; title: string; eyebrow: string }): React.ReactElement {
  const { language } = usePreferences();
  const site = useQuery(siteQueryOptions());
  const queryClient = useQueryClient();
  const path = `/x/${encodeURIComponent(extension.id)}/settings/${encodeURIComponent(id)}`;
  const key = ["extension-settings", extension.id, id] as const;
  const stored = useQuery({ queryKey: key, queryFn: () => api.get<{ value: Record<string, unknown> | null }>(path) });
  const [draft, setDraft] = React.useState<Record<string, unknown> | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const value = draft ?? stored.data?.value ?? {};
  const save = useMutation({
    mutationFn: (next: Record<string, unknown>) => api.patch<{ value: Record<string, unknown> }>(path, { value: next }),
    onSuccess: (out) => {
      queryClient.setQueryData(key, out);
      setDraft(null);
      setFieldErrors({});
      toast.success(t(language, "extension.settingsSaved"));
    },
    onError: (error) => {
      const fields = error instanceof ApiError ? (error.body as { error?: { fields?: Record<string, string> } } | null)?.error?.fields : undefined;
      setFieldErrors(fields ?? {});
    },
  });

  return (
    <section aria-label={title}>
      <PageHeader eyebrow={eyebrow} title={title} />
      {stored.isError ? <ErrorBox error={stored.error} /> : null}
      {stored.isPending ? <Skeleton className="h-40 w-full" /> : (
        <SectionCard className="space-y-4">
          <SchemaFields schema={schema} value={value} path={[]} onChange={setDraft} language={language}
            canonical={site.data?.canonicalLocale ?? null} collectionName={extension.id} mediaPurposes={[]} />
          {Object.keys(fieldErrors).length > 0 ? (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <p>{t(language, "extension.settingsInvalid")}</p>
              <ul className="mt-1 list-disc ps-5">
                {Object.entries(fieldErrors).map(([field, message]) => <li key={field}><code>{field || "—"}</code>: {message}</li>)}
              </ul>
            </div>
          ) : null}
          {save.isError && Object.keys(fieldErrors).length === 0 ? <ErrorBox error={save.error} /> : null}
        </SectionCard>
      )}
      <FormActionBar status={save.isPending ? t(language, "crud.saving") : draft ? t(language, "common.unsavedChanges") : undefined}>
        <Button type="button" onClick={() => save.mutate(value)} disabled={save.isPending || stored.isPending || draft === null}>
          <Save className="size-4" aria-hidden />
          {t(language, "entryEdit.save")}
        </Button>
      </FormActionBar>
    </section>
  );
}
