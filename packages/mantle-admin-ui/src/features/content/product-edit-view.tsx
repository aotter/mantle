import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bold, Code2, Heading2, Italic, Link, List, Plus, Save, Trash2 } from "lucide-react";
import type { AdminLanguage } from "../../app/preferences";
import { usePreferences } from "../../app/preferences";
import { api } from "../../lib/api";
import { Button } from "../../ui/button";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { t } from "../../app/i18n";

interface Promotion {
  label: string;
  title: string;
  body: string;
  relatedSkuCode?: string;
  discountPercent?: number | null;
}

interface ProductEditorPayload {
  product: { id: string; title: unknown };
  sku: {
    priceMinor: number | null;
    compareAtPriceMinor: number | null;
    currency: string;
  };
  content: {
    title: string;
    shortDescription: string;
    body: string;
    brand: { name: string; tagline: string; intro: string };
    promotions: Promotion[];
    serviceIncludes: string;
  };
  availableSkus: Array<{
    skuCode: string;
    productSlug: string;
    title: string;
    priceMinor: number | null;
    currency: string;
  }>;
}

export function ProductEditView({
  collectionName,
  entryId,
}: {
  collectionName: string;
  entryId: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const [bodyMode, setBodyMode] = React.useState<"rich" | "markdown" | "html">("rich");
  const query = useQuery<ProductEditorPayload>({
    queryKey: ["product-editor", entryId, language],
    queryFn: () =>
      api.get<ProductEditorPayload>(
        `/entries/${encodeURIComponent(entryId)}/product-editor?locale=${encodeURIComponent(language)}`,
      ),
  });
  const [form, setForm] = React.useState<ProductEditorPayload | null>(null);

  React.useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (next: ProductEditorPayload) =>
      api.patch<ProductEditorPayload>(
        `/entries/${encodeURIComponent(entryId)}/product-editor`,
        payloadForSave(next, language),
      ),
    onSuccess: (data) => setForm(data),
  });

  if (query.isLoading || !form) {
    return <div className="glass-card h-64 animate-pulse" />;
  }
  if (query.isError) return <ErrorBox error={query.error} />;

  const productTitle = form.content.title || renderUnknownTitle(form.product.title);
  const bodyPreview = React.useMemo(() => renderPreview(form.content.body, bodyMode), [form.content.body, bodyMode]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <a href={`/admin/c/${encodeURIComponent(collectionName)}`} className="inline-flex items-center gap-2 hover:underline">
            <ArrowLeft className="size-4" aria-hidden />
            {t(language, "productEdit.back")}
          </a>
        }
        title={productTitle || t(language, "productEdit.title")}
        description={t(language, "productEdit.body")}
        actions={
          <Button onClick={() => save.mutate(form)} disabled={save.isPending}>
            <Save className="size-4" aria-hidden />
            {save.isPending ? t(language, "crud.saving") : t(language, "productEdit.save")}
          </Button>
        }
      />

      {save.isError ? <ErrorBox error={save.error} /> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <SectionCard className="space-y-4">
            <SectionTitle title={t(language, "productEdit.basic")} />
            <Field label={t(language, "editor.titleLabel")}>
              <input
                className="admin-input"
                value={form.content.title}
                onChange={(event) => updateContent(setForm, { title: event.target.value })}
              />
            </Field>
            <Field label={t(language, "productEdit.shortDescription")}>
              <input
                className="admin-input"
                maxLength={140}
                value={form.content.shortDescription}
                onChange={(event) => updateContent(setForm, { shortDescription: event.target.value })}
              />
            </Field>
            <RichBodyEditor
              language={language}
              mode={bodyMode}
              setMode={setBodyMode}
              value={form.content.body}
              preview={bodyPreview}
              onChange={(body) => updateContent(setForm, { body })}
            />
          </SectionCard>

          <SectionCard className="space-y-4">
            <SectionTitle title={t(language, "productEdit.promotions")} />
            <div className="space-y-3">
              {form.content.promotions.map((promotion, index) => (
                <div key={index} className="grid gap-2 border border-border/70 p-3">
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-[10rem_1fr_auto]">
                    <input
                      className="admin-input"
                      value={promotion.label}
                      placeholder={t(language, "productEdit.promoLabel")}
                      onChange={(event) => updatePromotion(setForm, index, { label: event.target.value })}
                    />
                    <input
                      className="admin-input"
                      value={promotion.title}
                      placeholder={t(language, "productEdit.promoTitle")}
                      onChange={(event) => updatePromotion(setForm, index, { title: event.target.value })}
                    />
                    <button
                      type="button"
                      className="row-action"
                      title={t(language, "crud.delete")}
                      onClick={() => removePromotion(setForm, index)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </div>
                  <textarea
                    className="admin-textarea min-h-20"
                    value={promotion.body}
                    placeholder={t(language, "productEdit.promoBody")}
                    onChange={(event) => updatePromotion(setForm, index, { body: event.target.value })}
                  />
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_10rem]">
                    <Field label={t(language, "productEdit.relatedSku")}>
                      <select
                        className="admin-input"
                        value={promotion.relatedSkuCode ?? ""}
                        onChange={(event) => updatePromotion(setForm, index, { relatedSkuCode: event.target.value || undefined })}
                      >
                        <option value="">{t(language, "productEdit.noRelatedSku")}</option>
                        {form.availableSkus.map((sku) => (
                          <option key={sku.skuCode} value={sku.skuCode}>
                            {sku.title} / {sku.skuCode}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t(language, "productEdit.discountPercent")}>
                      <input
                        className="admin-input"
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={promotion.discountPercent ?? ""}
                        onChange={(event) =>
                          updatePromotion(setForm, index, {
                            discountPercent: event.target.value === "" ? null : Number(event.target.value),
                          })
                        }
                      />
                    </Field>
                  </div>
                </div>
              ))}
            </div>
            <Button type="button" variant="outline" onClick={() => addPromotion(setForm)}>
              <Plus className="size-4" aria-hidden />
              {t(language, "productEdit.addPromotion")}
            </Button>
          </SectionCard>
        </div>

        <div className="space-y-4">
          <SectionCard className="space-y-4">
            <SectionTitle title={t(language, "productEdit.price")} />
            <Field label={`${t(language, "productEdit.salePrice")} (${form.sku.currency})`}>
              <input
                className="admin-input"
                type="number"
                min={0}
                value={form.sku.priceMinor ?? 0}
                onChange={(event) => updateSku(setForm, { priceMinor: Number(event.target.value) })}
              />
            </Field>
            <Field label={`${t(language, "productEdit.compareAtPrice")} (${form.sku.currency})`}>
              <input
                className="admin-input"
                type="number"
                min={0}
                value={form.sku.compareAtPriceMinor ?? ""}
                onChange={(event) => updateSku(setForm, { compareAtPriceMinor: Number(event.target.value) || null })}
              />
            </Field>
          </SectionCard>

          <SectionCard className="space-y-4">
            <SectionTitle title={t(language, "productEdit.brand")} />
            <Field label={t(language, "productEdit.brandName")}>
              <input
                className="admin-input"
                value={form.content.brand.name}
                onChange={(event) => updateBrand(setForm, { name: event.target.value })}
              />
            </Field>
            <Field label={t(language, "productEdit.brandTagline")}>
              <input
                className="admin-input"
                value={form.content.brand.tagline}
                onChange={(event) => updateBrand(setForm, { tagline: event.target.value })}
              />
            </Field>
            <Field label={t(language, "productEdit.brandIntro")}>
              <textarea
                className="admin-textarea min-h-32"
                value={form.content.brand.intro}
                onChange={(event) => updateBrand(setForm, { intro: event.target.value })}
              />
            </Field>
            <Field label={t(language, "productEdit.serviceIncludes")}>
              <textarea
                className="admin-textarea min-h-32"
                value={form.content.serviceIncludes}
                onChange={(event) => updateContent(setForm, { serviceIncludes: event.target.value })}
              />
            </Field>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ title }: { title: string }): React.ReactElement {
  return <h2 className="text-lg">{title}</h2>;
}

function RichBodyEditor({
  language,
  mode,
  setMode,
  value,
  preview,
  onChange,
}: {
  language: AdminLanguage;
  mode: "rich" | "markdown" | "html";
  setMode: (mode: "rich" | "markdown" | "html") => void;
  value: string;
  preview: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium">{t(language, "productEdit.description")}</span>
        <div className="segmented-control">
          <button type="button" data-active={mode === "rich"} onClick={() => setMode("rich")}>
            {t(language, "editor.mode.rich")}
          </button>
          <button type="button" data-active={mode === "markdown"} onClick={() => setMode("markdown")}>
            {t(language, "editor.mode.markdown")}
          </button>
          <button type="button" data-active={mode === "html"} onClick={() => setMode("html")}>
            {t(language, "editor.mode.html")}
          </button>
        </div>
      </div>
      <div className="editor-toolbar" aria-label={t(language, "editor.insertBlock")}>
        {[Heading2, Bold, Italic, Link, List, Code2].map((Icon, index) => (
          <button key={index} type="button" title={t(language, "editor.insertBlock")}>
            <Icon className="size-4" aria-hidden />
          </button>
        ))}
      </div>
      <textarea
        className="admin-textarea admin-textarea-compact"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="editor-preview editor-preview-compact" dangerouslySetInnerHTML={{ __html: preview }} />
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

function payloadForSave(form: ProductEditorPayload, locale: string): Record<string, unknown> {
  return {
    locale,
    title: form.content.title,
    shortDescription: form.content.shortDescription,
    body: form.content.body,
    priceMinor: form.sku.priceMinor,
    compareAtPriceMinor: form.sku.compareAtPriceMinor,
    brandName: form.content.brand.name,
    brandTagline: form.content.brand.tagline,
    brandIntro: form.content.brand.intro,
    promotions: form.content.promotions,
    serviceIncludes: form.content.serviceIncludes,
  };
}

function renderUnknownTitle(title: unknown): string {
  return typeof title === "string" ? title : "";
}

function updateContent(
  setForm: React.Dispatch<React.SetStateAction<ProductEditorPayload | null>>,
  patch: Partial<ProductEditorPayload["content"]>,
): void {
  setForm((current) => current ? { ...current, content: { ...current.content, ...patch } } : current);
}

function updateSku(
  setForm: React.Dispatch<React.SetStateAction<ProductEditorPayload | null>>,
  patch: Partial<ProductEditorPayload["sku"]>,
): void {
  setForm((current) => current ? { ...current, sku: { ...current.sku, ...patch } } : current);
}

function updateBrand(
  setForm: React.Dispatch<React.SetStateAction<ProductEditorPayload | null>>,
  patch: Partial<ProductEditorPayload["content"]["brand"]>,
): void {
  setForm((current) =>
    current
      ? { ...current, content: { ...current.content, brand: { ...current.content.brand, ...patch } } }
      : current,
  );
}

function updatePromotion(
  setForm: React.Dispatch<React.SetStateAction<ProductEditorPayload | null>>,
  index: number,
  patch: Partial<Promotion>,
): void {
  setForm((current) => {
    if (!current) return current;
    const promotions = current.content.promotions.map((promotion, i) =>
      i === index ? { ...promotion, ...patch } : promotion,
    );
    return { ...current, content: { ...current.content, promotions } };
  });
}

function addPromotion(setForm: React.Dispatch<React.SetStateAction<ProductEditorPayload | null>>): void {
  setForm((current) =>
    current
      ? {
          ...current,
          content: {
            ...current.content,
            promotions: [...current.content.promotions, { label: "", title: "", body: "", relatedSkuCode: "", discountPercent: null }],
          },
        }
      : current,
  );
}

function removePromotion(
  setForm: React.Dispatch<React.SetStateAction<ProductEditorPayload | null>>,
  index: number,
): void {
  setForm((current) => {
    if (!current) return current;
    return {
      ...current,
      content: {
        ...current.content,
        promotions: current.content.promotions.filter((_, i) => i !== index),
      },
    };
  });
}

function renderPreview(body: string, mode: "markdown" | "html" | "rich"): string {
  if (mode === "html") return body;

  const output: string[] = [];
  let inList = false;

  for (const rawLine of body.split("\n")) {
    const line = escapeHtml(rawLine.trim());

    if (!line) {
      if (inList) {
        output.push("</ul>");
        inList = false;
      }
      continue;
    }

    if (line.startsWith("## ")) {
      if (inList) {
        output.push("</ul>");
        inList = false;
      }
      output.push(`<h2>${line.slice(3)}</h2>`);
      continue;
    }

    if (line.startsWith("- ")) {
      if (!inList) {
        output.push("<ul>");
        inList = true;
      }
      output.push(`<li>${line.slice(2)}</li>`);
      continue;
    }

    if (inList) {
      output.push("</ul>");
      inList = false;
    }
    output.push(`<p>${line}</p>`);
  }

  if (inList) output.push("</ul>");
  return output.join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
