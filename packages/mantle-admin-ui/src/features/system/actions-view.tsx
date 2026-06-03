import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Play, ShieldCheck, TerminalSquare } from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { AdminActionItem, AdminActionRunResult, AdminActionsResult, JsonSchema } from "../../lib/types";
import { Button } from "../../ui/button";
import { EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";

type FormState = Record<string, unknown>;

export function ActionsView(): React.ReactElement {
  const { language } = usePreferences();
  const actions = useQuery<AdminActionsResult>({
    queryKey: ["admin-actions"],
    queryFn: () => api.get<AdminActionsResult>("/actions"),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AotterMantle"
        title={t(language, "actions.title")}
        description={t(language, "actions.body")}
      />
      {actions.isLoading ? <div className="glass-card h-64 animate-pulse" /> : null}
      {actions.isError ? <ErrorBox error={actions.error} /> : null}
      {actions.data && actions.data.items.length === 0 ? (
        <EmptyState
          icon={TerminalSquare}
          title={t(language, "actions.emptyTitle")}
          description={t(language, "actions.emptyBody")}
        />
      ) : null}
      {actions.data && actions.data.items.length > 0 ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {actions.data.items.map((action) => (
            <ActionCard key={action.name} action={action} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActionCard({ action }: { action: AdminActionItem }): React.ReactElement {
  const { language } = usePreferences();
  const [form, setForm] = React.useState<FormState>(() => initialFormForSchema(action.input));
  const [jsonInput, setJsonInput] = React.useState(() => JSON.stringify(initialFormForSchema(action.input), null, 2));
  const [jsonError, setJsonError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<unknown>(null);
  const structured = isObjectSchema(action.input) && Boolean(action.input.properties);
  const run = useMutation({
    mutationFn: (input: unknown) =>
      api.post<AdminActionRunResult>(`/actions/${encodeURIComponent(action.name)}/run`, { input }),
    onSuccess: (data) => setResult(data.data),
  });

  function submit(): void {
    setJsonError(null);
    const input = structured ? form : parseJsonInput(jsonInput);
    if (input instanceof Error) {
      setJsonError(input.message);
      return;
    }
    run.mutate(input);
  }

  return (
    <SectionCard className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-semibold">{action.name}</h2>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="rounded-full bg-muted px-2.5 py-1">{action.handlerKind}</span>
            {action.requiresAuth ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-primary">
                <ShieldCheck className="size-3.5" aria-hidden />
                {t(language, "actions.staffOnly")}
              </span>
            ) : null}
          </div>
        </div>
        <Button type="button" onClick={submit} disabled={run.isPending}>
          <Play className="size-4" aria-hidden />
          {run.isPending ? t(language, "actions.running") : t(language, "actions.run")}
        </Button>
      </div>

      {structured ? (
        <SchemaObjectFields schema={action.input} value={form} onChange={setForm} />
      ) : (
        <label className="grid gap-1.5 text-sm font-semibold">
          <span>{t(language, "actions.inputJson")}</span>
          <textarea
            className="admin-textarea min-h-40 font-mono text-xs"
            value={jsonInput}
            onChange={(event) => setJsonInput(event.target.value)}
          />
        </label>
      )}

      {jsonError ? <p className="text-sm text-destructive">{jsonError}</p> : null}
      {run.isError ? <ErrorBox error={run.error} /> : null}
      {result !== null ? (
        <div className="rounded-lg border border-[var(--glass-border)] bg-background/35 p-3">
          <p className="label-eyebrow mb-2">{t(language, "actions.result")}</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      ) : null}
    </SectionCard>
  );
}

function SchemaObjectFields({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: FormState;
  onChange: (value: FormState) => void;
}): React.ReactElement {
  const { language } = usePreferences();
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return (
    <div className="grid gap-3">
      {Object.entries(properties).map(([name, fieldSchema]) => (
        <SchemaField
          key={name}
          name={name}
          schema={fieldSchema}
          required={required.has(name)}
          value={value[name]}
          onChange={(nextValue) => onChange({ ...value, [name]: nextValue })}
        />
      ))}
      {Object.keys(properties).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(language, "actions.noInput")}</p>
      ) : null}
    </div>
  );
}

function SchemaField({
  name,
  schema,
  required,
  value,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
}): React.ReactElement {
  const label = `${humanize(name)}${required ? " *" : ""}`;
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (schema.enum && schema.enum.length > 0) {
    return (
      <Field label={label} description={schema.description}>
        <select className="admin-input" value={stringValue(value)} onChange={(event) => onChange(event.target.value)}>
          <option value="" />
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  if (type === "boolean") {
    return (
      <label className="flex items-start gap-3 rounded-lg border border-[var(--glass-border)] bg-background/30 p-3 text-sm font-semibold">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-1"
        />
        <span>
          {label}
          {schema.description ? <span className="mt-1 block font-normal text-muted-foreground">{schema.description}</span> : null}
        </span>
      </label>
    );
  }
  if (type === "number" || type === "integer") {
    return (
      <Field label={label} description={schema.description}>
        <input
          className="admin-input"
          type="number"
          value={numberValue(value)}
          onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
        />
      </Field>
    );
  }
  if (type === "object" || type === "array") {
    return (
      <Field label={label} description={schema.description}>
        <textarea
          className="admin-textarea min-h-28 font-mono text-xs"
          value={JSON.stringify(value ?? (type === "array" ? [] : {}), null, 2)}
          onChange={(event) => {
            const parsed = parseJsonInput(event.target.value);
            if (!(parsed instanceof Error)) onChange(parsed);
          }}
        />
      </Field>
    );
  }
  return (
    <Field label={label} description={schema.description}>
      <input
        className="admin-input"
        value={stringValue(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
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
    <label className="grid gap-1.5 text-sm font-semibold">
      <span>{label}</span>
      {description ? <span className="text-xs font-normal text-muted-foreground">{description}</span> : null}
      {children}
    </label>
  );
}

function initialFormForSchema(schema: JsonSchema): FormState {
  if (!isObjectSchema(schema)) return {};
  const properties = schema.properties ?? {};
  return Object.fromEntries(Object.entries(properties).map(([name, fieldSchema]) => [name, defaultValueForSchema(fieldSchema)]));
}

function defaultValueForSchema(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return null;
  if (type === "array") return [];
  if (type === "object") return {};
  return "";
}

function isObjectSchema(schema: JsonSchema): boolean {
  const type = Array.isArray(schema.type) ? schema.type : [schema.type];
  return type.includes("object") || Boolean(schema.properties);
}

function parseJsonInput(value: string): unknown | Error {
  try {
    return value.trim() ? JSON.parse(value) : {};
  } catch (error) {
    return error instanceof Error ? error : new Error("Invalid JSON");
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberValue(value: unknown): string | number {
  return typeof value === "number" ? value : "";
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^\w/, (match) => match.toUpperCase());
}
