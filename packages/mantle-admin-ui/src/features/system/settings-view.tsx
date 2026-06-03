import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { Button } from "../../ui/button";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";

interface SiteSettings {
  brand: string;
  title: string;
  description: string;
  brandIntro: string;
  serviceIncludes: string;
  currency: string;
  paymentProvider: string;
  paymentMerchantId: string;
  checkoutReturnPath: string;
  checkoutCallbackPath: string;
  checkoutTermsUrl: string;
}

export function SettingsView(): React.ReactElement {
  const { language } = usePreferences();
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
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.72fr)]">
        <SectionCard className="grid gap-4">
          <div>
            <h2 className="text-lg font-semibold">{t(language, "settings.brandSection")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t(language, "settings.brandSectionBody")}</p>
          </div>
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

        <SectionCard className="grid gap-4 content-start">
          <div>
            <h2 className="text-lg font-semibold">{t(language, "settings.checkoutSection")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t(language, "settings.checkoutSectionBody")}</p>
          </div>
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
          <Field label={t(language, "settings.checkoutReturnPath")}>
            <input className="admin-input" value={form.checkoutReturnPath} placeholder="/checkout/return" onChange={(event) => setField(setForm, "checkoutReturnPath", event.target.value)} />
          </Field>
          <Field label={t(language, "settings.checkoutCallbackPath")}>
            <input className="admin-input" value={form.checkoutCallbackPath} placeholder="/api/checkout/callback" onChange={(event) => setField(setForm, "checkoutCallbackPath", event.target.value)} />
          </Field>
          <Field label={t(language, "settings.checkoutTermsUrl")}>
            <input className="admin-input" value={form.checkoutTermsUrl} onChange={(event) => setField(setForm, "checkoutTermsUrl", event.target.value)} />
          </Field>
        </SectionCard>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      <span>{label}</span>
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
