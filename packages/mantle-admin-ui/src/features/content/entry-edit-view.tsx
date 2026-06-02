import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Plus, Save, Trash2 } from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { EntryEditorPayload, JsonSchema, RelatedEntrySection } from "../../lib/types";
import { Button } from "../../ui/button";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { StatusBadge } from "../../ui/status-badge";
import { RichTextEditor } from "../editor/rich-text-editor";
import { collectionTitle } from "./collection-labels";

export function EntryEditView({
  collectionName,
  entryId,
}: {
  collectionName: string;
  entryId: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const query = useQuery<EntryEditorPayload>({
    queryKey: ["entry-editor", collectionName, entryId],
    queryFn: () => api.get<EntryEditorPayload>(`/entries/${encodeURIComponent(entryId)}/editor`),
  });
  const [data, setData] = React.useState<Record<string, unknown> | null>(null);
  React.useEffect(() => {
    if (query.data) setData(query.data.entry.data);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (nextData: Record<string, unknown>) =>
      api.patch<EntryEditorPayload>(`/entries/${encodeURIComponent(entryId)}/editor`, {
        data: nextData,
      }),
    onSuccess: (payload) => {
      setData(payload.entry.data);
    },
  });

  if (query.isLoading) return <div className="glass-card h-64 animate-pulse" />;
  if (query.isError) return <ErrorBox error={query.error} />;
  if (!query.data || !data) return <ErrorBox error={new Error("Missing entry editor payload.")} />;

  const payload = query.data;
  const title = entryTitle(data, payload.entry.id);
  const dirty = JSON.stringify(data) !== JSON.stringify(payload.entry.data);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <a
            href={`/admin/c/${encodeURIComponent(collectionName)}`}
            className="inline-flex items-center gap-2 hover:underline"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {t(language, "entryEdit.back", { name: collectionTitle(payload.collection, language) })}
          </a>
        }
        title={title}
        description={t(language, "entryEdit.body", {
          name: collectionTitle(payload.collection, language),
        })}
        actions={
          <>
            <StatusBadge status={payload.entry.status} />
            <Button
              type="button"
              onClick={() => save.mutate(data)}
              disabled={save.isPending || !dirty}
              title={t(language, "entryEdit.saveTooltip")}
            >
              <Save className="size-4" aria-hidden />
              {save.isPending ? t(language, "crud.saving") : t(language, "entryEdit.save")}
            </Button>
          </>
        }
      />

      {save.isError ? <ErrorBox error={save.error} /> : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <SectionCard>
          <SectionTitle
            title={t(language, "entryEdit.fields")}
            body={payload.collection.description}
          />
          <SchemaFields
            schema={payload.collection.schema}
            value={data}
            path={[]}
            onChange={setData}
            language={language}
          />
        </SectionCard>

        <div className="space-y-4">
          <SectionCard>
            <SectionTitle
              title={t(language, "entryEdit.meta")}
              body={`${payload.entry.collection} / ${payload.entry.id}`}
            />
            <dl className="space-y-3 text-sm">
              <MetaRow label={t(language, "collection.table.status")} value={<StatusBadge status={payload.entry.status} />} />
              <MetaRow label={t(language, "collection.table.locale")} value={payload.entry.locale ?? "-"} />
              <MetaRow label={t(language, "collection.table.version")} value={`v${payload.entry.version}`} />
            </dl>
          </SectionCard>
          <RelatedSections sections={payload.related} language={language} />
        </div>
      </div>
    </div>
  );
}

function SectionTitle({
  title,
  body,
}: {
  title: string;
  body?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {body ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{body}</p> : null}
    </div>
  );
}

function MetaRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{value}</dd>
    </div>
  );
}

function SchemaFields({
  schema,
  value,
  path,
  onChange,
  language,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  path: string[];
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return (
    <div className="space-y-5">
      {Object.entries(properties).map(([name, fieldSchema]) => (
        <SchemaField
          key={[...path, name].join(".")}
          name={name}
          schema={fieldSchema}
          required={required.has(name)}
          value={readPath(value, [...path, name])}
          path={[...path, name]}
          rootValue={value}
          onChange={onChange}
          language={language}
        />
      ))}
    </div>
  );
}

function SchemaField({
  name,
  schema,
  required,
  value,
  path,
  rootValue,
  onChange,
  language,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  value: unknown;
  path: string[];
  rootValue: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const type = schemaType(schema);
  const label = fieldLabel(name);
  const description = typeof schema.description === "string" ? schema.description : undefined;
  const setValue = (next: unknown): void => onChange(writePath(rootValue, path, next));

  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between gap-3 text-sm font-semibold text-foreground">
        <span>
          {label}
          {required ? <span className="ml-1 text-destructive">*</span> : null}
        </span>
        {schema["x-mcp-hint"] ? (
          <span className="badge-status bg-accent text-accent-foreground" title={String(schema["x-mcp-hint"])}>
            {String(schema["x-mcp-hint"])}
          </span>
        ) : null}
      </label>
      {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
      {schema.enum ? (
        <select
          className="admin-input"
          value={stringForInput(value)}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">{t(language, "entryEdit.emptyOption")}</option>
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      ) : type === "boolean" ? (
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={Boolean(value)}
            onChange={(event) => setValue(event.target.checked)}
          />
          {t(language, "entryEdit.boolean")}
        </label>
      ) : type === "number" || type === "integer" ? (
        <input
          className="admin-input"
          type="number"
          value={numberForInput(value)}
          min={schema.minimum}
          max={schema.maximum}
          onChange={(event) => {
            const raw = event.target.value;
            setValue(raw === "" ? null : Number(raw));
          }}
        />
      ) : type === "object" ? (
        <div className="rounded-lg border border-[var(--glass-border)] bg-background/30 p-4">
          {schema.properties ? (
            <SchemaFields
              schema={schema}
              value={rootValue}
              path={path}
              onChange={onChange}
              language={language}
            />
          ) : (
            <JsonEditor value={value} onChange={setValue} />
          )}
        </div>
      ) : type === "array" ? (
        <ArrayField
          schema={schema}
          value={Array.isArray(value) ? value : []}
          path={path}
          rootValue={rootValue}
          onChange={onChange}
          language={language}
        />
      ) : multilineField(schema, name) ? (
        <RichTextEditor
          compact
          value={stringForInput(value)}
          onChange={setValue}
        />
      ) : (
        <input
          className="admin-input"
          type={schema.format === "date-time" ? "datetime-local" : "text"}
          value={stringForInput(value)}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
    </div>
  );
}

function ArrayField({
  schema,
  value,
  path,
  rootValue,
  onChange,
  language,
}: {
  schema: JsonSchema;
  value: unknown[];
  path: string[];
  rootValue: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const itemSchema = schema.items ?? {};
  const setArray = (next: unknown[]): void => onChange(writePath(rootValue, path, next));
  return (
    <div className="space-y-3 rounded-lg border border-[var(--glass-border)] bg-background/30 p-3">
      {value.map((item, index) => (
        <div key={index} className="rounded-lg border border-border/70 bg-card/50 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground">#{index + 1}</span>
            <button
              type="button"
              className="row-action"
              title={t(language, "entryEdit.removeItem")}
              onClick={() => setArray(value.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
          {schemaType(itemSchema) === "object" && itemSchema.properties ? (
            <SchemaFields
              schema={itemSchema}
              value={rootValue}
              path={[...path, String(index)]}
              onChange={onChange}
              language={language}
            />
          ) : (
            <input
              className="admin-input"
              value={stringForInput(item)}
              onChange={(event) => {
                const next = [...value];
                next[index] = event.target.value;
                setArray(next);
              }}
            />
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setArray([...value, defaultValueForSchema(itemSchema)])}
      >
        <Plus className="size-3.5" aria-hidden />
        {t(language, "entryEdit.addItem")}
      </Button>
    </div>
  );
}

function JsonEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState(JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setDraft(JSON.stringify(value ?? {}, null, 2));
  }, [value]);
  return (
    <div className="space-y-2">
      <textarea
        className="admin-textarea admin-textarea-compact font-mono"
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          try {
            onChange(JSON.parse(next) as unknown);
            setError(null);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function RelatedSections({
  sections,
  language,
}: {
  sections: RelatedEntrySection[];
  language: AdminLanguage;
}): React.ReactElement {
  if (sections.length === 0) {
    return (
      <SectionCard>
        <SectionTitle title={t(language, "entryEdit.related")} body={t(language, "entryEdit.noRelated")} />
      </SectionCard>
    );
  }
  return (
    <>
      {sections.map((section) => (
        <SectionCard key={`${section.collection.name}:${section.relationship.childField}`}>
          <SectionTitle
            title={collectionTitle(section.collection, language)}
            body={t(language, "entryEdit.relationship", {
              child: section.relationship.childField,
              parent: section.relationship.parentField,
            })}
          />
          <div className="space-y-2">
            {section.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t(language, "entryEdit.noChildEntries")}</p>
            ) : (
              section.entries.map((entry) => (
                <a
                  key={entry.id}
                  href={`/admin/c/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-[var(--glass-border)] bg-background/35 p-3 text-sm text-foreground transition hover:border-primary hover:bg-accent"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{entryTitle(entry.data, entry.id)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {entry.collection} / v{entry.version}
                    </span>
                  </span>
                  <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </a>
              ))
            )}
          </div>
        </SectionCard>
      ))}
    </>
  );
}

function entryTitle(data: Record<string, unknown>, fallback: string): string {
  for (const key of ["title", "name", "slug", "skuCode", "orderId", "id"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback.slice(0, 8);
}

function schemaType(schema: JsonSchema): string {
  const raw = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (raw) return raw;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "string";
}

function multilineField(schema: JsonSchema, name: string): boolean {
  const hint = typeof schema["x-mcp-hint"] === "string" ? schema["x-mcp-hint"] : "";
  return (
    hint.includes("markdown") ||
    hint.includes("html") ||
    /body|description|content|intro|notes|summary/i.test(name) ||
    (typeof schema.maxLength === "number" && schema.maxLength > 160)
  );
}

function fieldLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stringForInput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function numberForInput(value: unknown): string | number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  return "";
}

function defaultValueForSchema(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  const type = schemaType(schema);
  if (type === "object") return {};
  if (type === "array") return [];
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return 0;
  return "";
}

function readPath(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (typeof current === "object" && current !== null) current = (current as Record<string, unknown>)[segment];
    else return undefined;
  }
  return current;
}

function writePath(
  root: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) return objectValue(value);
  const clone = structuredCloneSafe(root);
  let current: unknown = clone;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const nextSegment = path[index + 1]!;
    if (Array.isArray(current)) {
      const arrayIndex = Number(segment);
      current[arrayIndex] = current[arrayIndex] ?? (isArrayIndex(nextSegment) ? [] : {});
      current = current[arrayIndex];
    } else if (typeof current === "object" && current !== null) {
      const record = current as Record<string, unknown>;
      record[segment] = record[segment] ?? (isArrayIndex(nextSegment) ? [] : {});
      current = record[segment];
    }
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(current)) current[Number(last)] = value;
  else if (typeof current === "object" && current !== null) {
    (current as Record<string, unknown>)[last] = value;
  }
  return clone;
}

function structuredCloneSafe(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isArrayIndex(value: string): boolean {
  return /^\d+$/.test(value);
}
