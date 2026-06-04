import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  Code2,
  Globe2,
  Layers3,
  Play,
  Route,
  ShieldCheck,
  TerminalSquare,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { AdminActionItem, AdminActionRunResult, AdminActionsResult, AdminActionTrigger, JsonSchema } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import { EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { SegmentedTabs } from "../../ui/resource";

type FormState = Record<string, unknown>;
type ActionPanel = "operations" | "api" | "system";

const PANEL_ICONS: Record<ActionPanel, LucideIcon> = {
  operations: CheckCircle2,
  api: Globe2,
  system: Workflow,
};

export function ActionsView(): React.ReactElement {
  const { language } = usePreferences();
  const [panel, setPanel] = React.useState<ActionPanel>("operations");
  const actions = useQuery<AdminActionsResult>({
    queryKey: ["admin-actions"],
    queryFn: () => api.get<AdminActionsResult>("/actions"),
  });
  const grouped = React.useMemo(() => groupActions(actions.data?.items ?? []), [actions.data]);
  const visibleActions = grouped[panel];

  React.useEffect(() => {
    if (!actions.data || visibleActions.length > 0) return;
    const next = (["operations", "api", "system"] as ActionPanel[]).find((item) => grouped[item].length > 0);
    if (next) setPanel(next);
  }, [actions.data, grouped, visibleActions.length]);

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
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <ActionSummaryCard
              icon={CheckCircle2}
              label={t(language, "actions.panel.operations")}
              value={grouped.operations.length}
              description={t(language, "actions.panel.operations.body")}
              active={panel === "operations"}
              onClick={() => setPanel("operations")}
            />
            <ActionSummaryCard
              icon={Globe2}
              label={t(language, "actions.panel.api")}
              value={grouped.api.length}
              description={t(language, "actions.panel.api.body")}
              active={panel === "api"}
              onClick={() => setPanel("api")}
            />
            <ActionSummaryCard
              icon={Workflow}
              label={t(language, "actions.panel.system")}
              value={grouped.system.length}
              description={t(language, "actions.panel.system.body")}
              active={panel === "system"}
              onClick={() => setPanel("system")}
            />
          </div>
          <SegmentedTabs
            label={t(language, "actions.title")}
            value={panel}
            onChange={setPanel}
            items={[
              { value: "operations", label: t(language, "actions.panel.operations"), icon: PANEL_ICONS.operations },
              { value: "api", label: t(language, "actions.panel.api"), icon: PANEL_ICONS.api },
              { value: "system", label: t(language, "actions.panel.system"), icon: PANEL_ICONS.system },
            ]}
          />
          <div className="grid gap-4" role="tabpanel">
            {visibleActions.length > 0 ? (
              visibleActions.map((action) => (
                <ActionCard key={action.name} action={action} compactRun={panel === "system"} />
              ))
            ) : (
              <EmptyState
                icon={PANEL_ICONS[panel]}
                title={t(language, "actions.panel.empty")}
                description={t(language, "actions.panel.empty.body")}
              />
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ActionSummaryCard({
  icon: Icon,
  label,
  value,
  description,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  description: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "glass-card flex min-h-32 items-start gap-3 p-4 text-start transition hover:-translate-y-1 hover:shadow-[var(--glass-shadow-lg)]",
        active ? "border-primary/55 bg-primary/10" : "hover:border-primary/35",
      )}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-md bg-accent text-primary">
        <Icon className="size-5" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-muted-foreground">{label}</span>
        <span className="mt-1 block text-3xl font-semibold text-foreground">{value}</span>
        <span className="mt-2 block text-sm leading-relaxed text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function ActionCard({ action, compactRun }: { action: AdminActionItem; compactRun: boolean }): React.ReactElement {
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
  const ActionIcon = iconForAction(action);

  function submit(): void {
    setJsonError(null);
    const input = structured ? form : parseJsonInput(jsonInput);
    if (input instanceof Error) {
      setJsonError(input.message);
      return;
    }
    run.mutate(input);
  }

  const runButton = (
    <Button type="button" onClick={submit} disabled={run.isPending} variant={compactRun ? "outline" : "default"}>
      <Play className="size-4" aria-hidden />
      {run.isPending ? t(language, "actions.running") : t(language, compactRun ? "actions.advancedRun" : "actions.run")}
    </Button>
  );

  return (
    <SectionCard className="grid gap-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-md bg-accent text-primary">
            <ActionIcon className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="break-words text-xl font-semibold">{action.name}</h2>
              <ActionIntentBadge action={action} />
            </div>
            <p className="mt-2 max-w-4xl whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
              {action.description ? trimDescription(action.description) : t(language, "actions.noDescription")}
            </p>
          </div>
        </div>
        {!compactRun ? <div className="flex items-start justify-end">{runButton}</div> : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.45fr)]">
        <div className="rounded-lg border border-[var(--glass-border)] bg-background/30 p-4">
          <p className="label-eyebrow mb-3">{t(language, "actions.triggers")}</p>
          <TriggerList triggers={action.triggers ?? []} />
        </div>
        <div className="rounded-lg border border-[var(--glass-border)] bg-background/30 p-4">
          <p className="label-eyebrow mb-3">{t(language, "actions.runtime")}</p>
          <div className="grid gap-2 text-sm">
            <KeyValue label={t(language, "actions.handler")} value={action.handlerRef ?? action.handlerKind} />
            <KeyValue label={t(language, "actions.audience")} value={audienceLabel(language, action.audience)} />
            <KeyValue label={t(language, "actions.manualRun")} value={manualRunLabel(language, action.manualRun)} />
          </div>
        </div>
      </div>

      {compactRun ? (
        <details className="rounded-lg border border-amber-300/40 bg-amber-50/60 p-4 text-sm dark:bg-amber-950/20">
          <summary className="flex cursor-pointer list-none items-start gap-3 font-semibold text-amber-900 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t(language, "actions.advancedSummary")}</span>
          </summary>
          <div className="mt-4 grid gap-4">
            <ActionInputs
              structured={structured}
              schema={action.input}
              form={form}
              setForm={setForm}
              jsonInput={jsonInput}
              setJsonInput={setJsonInput}
            />
            <div>{runButton}</div>
          </div>
        </details>
      ) : (
        <ActionInputs
          structured={structured}
          schema={action.input}
          form={form}
          setForm={setForm}
          jsonInput={jsonInput}
          setJsonInput={setJsonInput}
        />
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

function ActionInputs({
  structured,
  schema,
  form,
  setForm,
  jsonInput,
  setJsonInput,
}: {
  structured: boolean;
  schema: JsonSchema;
  form: FormState;
  setForm: (value: FormState) => void;
  jsonInput: string;
  setJsonInput: (value: string) => void;
}): React.ReactElement {
  const { language } = usePreferences();
  return structured ? (
    <SchemaObjectFields schema={schema} value={form} onChange={setForm} />
  ) : (
    <label className="grid gap-1.5 text-sm font-semibold">
      <span>{t(language, "actions.inputJson")}</span>
      <textarea
        className="admin-textarea min-h-40 font-mono text-xs"
        value={jsonInput}
        onChange={(event) => setJsonInput(event.target.value)}
      />
    </label>
  );
}

function TriggerList({ triggers }: { triggers: AdminActionTrigger[] }): React.ReactElement {
  const { language } = usePreferences();
  if (triggers.length === 0) {
    return <p className="text-sm text-muted-foreground">{t(language, "actions.noTriggers")}</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {triggers.map((trigger) => (
        <span
          key={`${trigger.name}-${trigger.sourceKind}-${trigger.path ?? trigger.schema ?? trigger.surface ?? ""}`}
          className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/70 bg-card/70 px-2.5 py-1 text-xs font-semibold text-foreground"
        >
          <Route className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="truncate">{triggerLabel(trigger)}</span>
        </span>
      ))}
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-semibold">{value}</span>
    </div>
  );
}

function ActionIntentBadge({ action }: { action: AdminActionItem }): React.ReactElement {
  const { language } = usePreferences();
  const mode = action.manualRun ?? "debug";
  const className =
    mode === "recommended"
      ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-200"
      : mode === "advanced"
        ? "bg-amber-500/15 text-amber-800 dark:text-amber-100"
        : "bg-sky-500/12 text-sky-700 dark:text-sky-200";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold", className)}>
      {mode === "recommended" ? <ShieldCheck className="size-3.5" aria-hidden /> : null}
      {mode === "debug" ? <Bug className="size-3.5" aria-hidden /> : null}
      {mode === "advanced" ? <AlertTriangle className="size-3.5" aria-hidden /> : null}
      {manualRunLabel(language, mode)}
    </span>
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
      <div>
        <p className="label-eyebrow">{t(language, "actions.inputFields")}</p>
        {schema.description ? (
          <p className="mt-1 max-w-4xl whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
            {trimDescription(schema.description)}
          </p>
        ) : null}
      </div>
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

function groupActions(items: AdminActionItem[]): Record<ActionPanel, AdminActionItem[]> {
  const grouped: Record<ActionPanel, AdminActionItem[]> = { operations: [], api: [], system: [] };
  for (const action of items) {
    if (action.manualRun === "advanced" || action.audience === "system" || action.operationKind === "system") {
      grouped.system.push(action);
    } else if (action.manualRun === "recommended" || action.audience === "staff") {
      grouped.operations.push(action);
    } else {
      grouped.api.push(action);
    }
  }
  return grouped;
}

function iconForAction(action: AdminActionItem): LucideIcon {
  if (action.operationKind === "checkout") return Globe2;
  if (action.operationKind === "inventory") return Layers3;
  if (action.operationKind === "orders") return ShieldCheck;
  if (action.operationKind === "system") return Workflow;
  return Code2;
}

function triggerLabel(trigger: AdminActionTrigger): string {
  if (trigger.sourceKind === "http") return `${trigger.method ?? "HTTP"} ${trigger.path ?? ""}`.trim();
  if (trigger.sourceKind === "lifecycle") {
    const hooks = trigger.hooks?.join(", ") ?? "";
    return `lifecycle ${trigger.schema ?? ""}${hooks ? `: ${hooks}` : ""}`.trim();
  }
  if (trigger.sourceKind === "mcp") return `MCP ${trigger.surface ?? ""}`.trim();
  return `${trigger.sourceKind} ${trigger.name}`.trim();
}

function audienceLabel(language: ReturnType<typeof usePreferences>["language"], audience?: string): string {
  if (audience === "staff") return t(language, "actions.audience.staff");
  if (audience === "storefront") return t(language, "actions.audience.storefront");
  if (audience === "system") return t(language, "actions.audience.system");
  if (audience === "agent") return t(language, "actions.audience.agent");
  return t(language, "actions.audience.staff");
}

function manualRunLabel(language: ReturnType<typeof usePreferences>["language"], mode?: string): string {
  if (mode === "recommended") return t(language, "actions.manual.recommended");
  if (mode === "advanced") return t(language, "actions.manual.advanced");
  return t(language, "actions.manual.debug");
}

function trimDescription(value: string): string {
  const cleaned = value.trim().replace(/\n{3,}/g, "\n\n");
  return cleaned.length > 420 ? `${cleaned.slice(0, 420).trim()}...` : cleaned;
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
