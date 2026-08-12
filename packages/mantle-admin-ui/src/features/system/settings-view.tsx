import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BarChart3, Save, Store } from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";

interface SiteSettings {
  brand: string;
  title: string;
  description: string;
  ga4MeasurementId: string;
  facebookPixelId: string;
}

type SettingsTab = "brand" | "tracking";

export function SettingsView(): React.ReactElement {
  const { language } = usePreferences();
  const query = useQuery<SiteSettings>({
    queryKey: ["site-settings"],
    queryFn: () => api.get<SiteSettings>("/site-settings"),
  });
  const [form, setForm] = React.useState<SiteSettings | null>(null);
  const [activeTab, setActiveTab] = React.useState<SettingsTab>("brand");
  React.useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (next: SiteSettings) => api.patch<SiteSettings>("/site-settings", next),
    onSuccess: (data) => setForm(data),
  });

  if (query.isLoading || !form) return <Skeleton className="h-64 w-full" />;
  if (query.isError) return <ErrorBox error={query.error} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t(language, "settings.page.title")}
        description={t(language, "settings.page.body")}
        actions={
          <Button onClick={() => save.mutate(form)} disabled={save.isPending}>
            <Save className="size-4" aria-hidden />
            {save.isPending ? t(language, "crud.saving") : t(language, "entryEdit.save")}
          </Button>
        }
      />
      {save.isError ? <ErrorBox error={save.error} /> : null}

      <div
        role="tablist"
        aria-label={t(language, "settings.tabsLabel")}
        className="inline-flex gap-1 rounded-lg border bg-muted/40 p-1"
      >
        <TabButton
          active={activeTab === "brand"}
          icon={Store}
          label={t(language, "settings.tab.brand")}
          onClick={() => setActiveTab("brand")}
        />
        <TabButton
          active={activeTab === "tracking"}
          icon={BarChart3}
          label={t(language, "settings.tab.tracking")}
          onClick={() => setActiveTab("tracking")}
        />
      </div>

      {activeTab === "brand" ? (
        <SectionCard className="grid max-w-5xl gap-4">
          <SectionIntro title={t(language, "settings.brandSection")} body={t(language, "settings.brandSectionBody")} />
          <Field label={t(language, "settings.siteBrand")}>
            <Input value={form.brand} onChange={(event) => setField(setForm, "brand", event.target.value)} />
          </Field>
          <Field label={t(language, "settings.siteTitle")}>
            <Input value={form.title} onChange={(event) => setField(setForm, "title", event.target.value)} />
          </Field>
          <Field label={t(language, "settings.siteDescription")}>
            <Textarea className="min-h-24" value={form.description} onChange={(event) => setField(setForm, "description", event.target.value)} />
          </Field>
        </SectionCard>
      ) : null}

      {activeTab === "tracking" ? (
        <SectionCard className="grid max-w-5xl gap-4">
          <SectionIntro title={t(language, "settings.trackingSection")} body={t(language, "settings.trackingSectionBody")} />
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t(language, "settings.ga4MeasurementId")} description={t(language, "settings.ga4MeasurementIdHelp")}>
              <Input value={form.ga4MeasurementId} placeholder="G-XXXXXXXXXX" onChange={(event) => setField(setForm, "ga4MeasurementId", event.target.value)} />
            </Field>
            <Field label={t(language, "settings.facebookPixelId")} description={t(language, "settings.facebookPixelIdHelp")}>
              <Input value={form.facebookPixelId} placeholder="123456789012345" onChange={(event) => setField(setForm, "facebookPixelId", event.target.value)} />
            </Field>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

function TabButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-semibold transition",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
      onClick={onClick}
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </button>
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

function setField(
  setForm: React.Dispatch<React.SetStateAction<SiteSettings | null>>,
  key: keyof SiteSettings,
  value: string,
): void {
  setForm((current) => current ? { ...current, [key]: value } : current);
}
