import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BarChart3, CreditCard, Save, Store } from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { SiteSettings } from "../../lib/types";
import { Button } from "../../ui/button";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { SegmentedTabs } from "../../ui/resource";

type SettingsTab = "brand" | "checkout" | "tracking";

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

  if (query.isLoading || !form) return <div className="glass-card h-64 animate-pulse" />;
  if (query.isError) return <ErrorBox error={query.error} />;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AotterMantle"
        title={t(language, "settings.page.title")}
        description={t(language, "settings.page.body")}
        actions={
          <Button onClick={() => save.mutate(form)} disabled={save.isPending}>
            <Save className="size-4" aria-hidden />
            {save.isPending ? t(language, "crud.saving") : t(language, "productEdit.save")}
          </Button>
        }
      />
      {save.isError ? <ErrorBox error={save.error} /> : null}

      <SegmentedTabs
        className="w-fit"
        label={t(language, "settings.tabsLabel")}
        value={activeTab}
        onChange={setActiveTab}
        items={[
          { value: "brand", label: t(language, "settings.tab.brand"), icon: Store },
          { value: "checkout", label: t(language, "settings.tab.checkout"), icon: CreditCard },
          { value: "tracking", label: t(language, "settings.tab.tracking"), icon: BarChart3 },
        ]}
      />

      {activeTab === "brand" ? (
        <SectionCard className="grid max-w-5xl gap-4">
          <SectionIntro title={t(language, "settings.brandSection")} body={t(language, "settings.brandSectionBody")} />
          <Field label={t(language, "settings.siteBrand")}>
            <input className="admin-input" value={form.brand} onChange={(event) => setField(setForm, "brand", event.target.value)} />
          </Field>
          <Field label={t(language, "settings.siteTitle")}>
            <input className="admin-input" value={form.title} onChange={(event) => setField(setForm, "title", event.target.value)} />
          </Field>
          <Field label={t(language, "settings.siteDescription")}>
            <textarea className="admin-textarea min-h-24" value={form.description} onChange={(event) => setField(setForm, "description", event.target.value)} />
          </Field>
          <Field label={t(language, "productEdit.brandIntro")}>
            <textarea className="admin-textarea min-h-32" value={form.brandIntro} onChange={(event) => setField(setForm, "brandIntro", event.target.value)} />
          </Field>
          <Field label={t(language, "productEdit.serviceIncludes")}>
            <textarea className="admin-textarea min-h-32" value={form.serviceIncludes} onChange={(event) => setField(setForm, "serviceIncludes", event.target.value)} />
          </Field>
        </SectionCard>
      ) : null}

      {activeTab === "checkout" ? (
        <SectionCard className="grid max-w-5xl gap-4">
          <SectionIntro title={t(language, "settings.checkoutSection")} body={t(language, "settings.checkoutSectionBody")} />
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t(language, "settings.currency")}>
              <input className="admin-input" value={form.currency} placeholder="TWD" onChange={(event) => setField(setForm, "currency", event.target.value)} />
            </Field>
            <Field label={t(language, "settings.paymentProvider")}>
              <select className="admin-input" value={form.paymentProvider} onChange={(event) => setField(setForm, "paymentProvider", event.target.value)}>
                <option value="">{t(language, "settings.paymentProviderUnset")}</option>
                <option value="ecpay">ECPay</option>
                <option value="stripe">Stripe</option>
                <option value="manual">{t(language, "settings.paymentProviderManual")}</option>
              </select>
            </Field>
            <Field label={t(language, "settings.paymentMerchantId")}>
              <input className="admin-input" value={form.paymentMerchantId} onChange={(event) => setField(setForm, "paymentMerchantId", event.target.value)} />
            </Field>
            <Field label={t(language, "settings.checkoutTermsUrl")}>
              <input className="admin-input" value={form.checkoutTermsUrl} onChange={(event) => setField(setForm, "checkoutTermsUrl", event.target.value)} />
            </Field>
            <Field label={t(language, "settings.checkoutReturnPath")}>
              <input className="admin-input" value={form.checkoutReturnPath} placeholder="/checkout/return" onChange={(event) => setField(setForm, "checkoutReturnPath", event.target.value)} />
            </Field>
            <Field label={t(language, "settings.checkoutCallbackPath")}>
              <input className="admin-input" value={form.checkoutCallbackPath} placeholder="/api/checkout/callback" onChange={(event) => setField(setForm, "checkoutCallbackPath", event.target.value)} />
            </Field>
          </div>
        </SectionCard>
      ) : null}

      {activeTab === "tracking" ? (
        <SectionCard className="grid max-w-5xl gap-4">
          <SectionIntro title={t(language, "settings.trackingSection")} body={t(language, "settings.trackingSectionBody")} />
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t(language, "settings.ga4MeasurementId")} description={t(language, "settings.ga4MeasurementIdHelp")}>
              <input className="admin-input" value={form.ga4MeasurementId} placeholder="G-XXXXXXXXXX" onChange={(event) => setField(setForm, "ga4MeasurementId", event.target.value)} />
            </Field>
            <Field label={t(language, "settings.facebookPixelId")} description={t(language, "settings.facebookPixelIdHelp")}>
              <input className="admin-input" value={form.facebookPixelId} placeholder="123456789012345" onChange={(event) => setField(setForm, "facebookPixelId", event.target.value)} />
            </Field>
          </div>
        </SectionCard>
      ) : null}
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

function setField(
  setForm: React.Dispatch<React.SetStateAction<SiteSettings | null>>,
  key: keyof SiteSettings,
  value: string,
): void {
  setForm((current) => current ? { ...current, [key]: value } : current);
}
