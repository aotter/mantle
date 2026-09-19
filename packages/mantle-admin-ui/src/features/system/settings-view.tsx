import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { asRenderable } from "../../lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBox, FormActionBar, OperationErrorBox, PageHeader, SectionCard } from "../../ui/page";

interface SiteSettings {
  brand: string;
  title: string;
  description: string;
}

export function SettingsView(): React.ReactElement {
  const { language } = usePreferences();
  const queryClient = useQueryClient();
  const query = useQuery<SiteSettings>({
    queryKey: ["site-settings"],
    queryFn: () => api.get<SiteSettings>("/site-settings"),
  });
  const [form, setForm] = React.useState<SiteSettings | null>(null);
  React.useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (next: SiteSettings) => api.patch<SiteSettings>("/site-settings", next),
    onSuccess: (data) => {
      queryClient.setQueryData(["site-settings"], data);
      void queryClient.invalidateQueries({ queryKey: ["site"] });
      setForm(data);
    },
  });

  if (query.isLoading || !form) return <Skeleton className="h-64 w-full" />;
  if (query.isError) return <ErrorBox error={query.error} />;
  const dirty = !sameSettings(form, query.data);
  const saved = save.isSuccess && !dirty;

  function change(key: keyof SiteSettings, value: string): void {
    save.reset();
    setForm((current) => current ? { ...current, [key]: value } : current);
  }

  return (
    <div className="flex min-h-full flex-col gap-6">
      <PageHeader
        title={t(language, "settings.page.title")}
        description={t(language, "settings.page.body")}
      />
      {save.isError ? <OperationErrorBox error={asRenderable(save.error)} /> : null}

      <SectionCard className="grid max-w-5xl gap-4">
        <SectionIntro title={t(language, "settings.brandSection")} body={t(language, "settings.brandSectionBody")} />
        <Field label={t(language, "settings.siteBrand")} description={t(language, "settings.siteBrandHelp")}>
          <Input value={form.brand} onChange={(event) => change("brand", event.target.value)} />
        </Field>
        <Field label={t(language, "settings.siteTitle")} description={t(language, "settings.siteTitleHelp")}>
          <Input value={form.title} onChange={(event) => change("title", event.target.value)} />
        </Field>
        <Field label={t(language, "settings.siteDescription")} description={t(language, "settings.siteDescriptionHelp")}>
          <Textarea className="min-h-24" value={form.description} onChange={(event) => change("description", event.target.value)} />
        </Field>
      </SectionCard>

      <FormActionBar
        status={save.isPending
          ? t(language, "crud.saving")
          : dirty
          ? t(language, "common.unsavedChanges")
          : saved
          ? t(language, "common.saved")
          : undefined}
      >
        <Button onClick={() => save.mutate(form)} disabled={!dirty || save.isPending}>
          <Save className="size-4" aria-hidden />
          {save.isPending ? t(language, "crud.saving") : t(language, "entryEdit.save")}
        </Button>
      </FormActionBar>
    </div>
  );
}

function SectionIntro({ title, body }: { title: string; body: string }): React.ReactElement {
  return (
    <div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      <span>{label}</span>
      {description ? <span className="text-xs font-normal text-muted-foreground">{description}</span> : null}
      {children}
    </label>
  );
}

function sameSettings(a: SiteSettings, b: SiteSettings | undefined): boolean {
  return Boolean(b) && Object.keys(a).every((key) => a[key as keyof SiteSettings] === b![key as keyof SiteSettings]);
}
