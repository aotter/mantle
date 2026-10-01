import * as React from "react";
import { CalendarIcon, LockKeyhole, Plus, Trash2 } from "lucide-react";
import { Button, Calendar, Checkbox, Input, Popover, PopoverContent, PopoverTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "../kit/index.js";
import {
  dateFromFieldValue,
  enumOptions,
  formatMoneyMinor,
  formatTimestampMs,
  moneyMinorHint,
  optionLabel,
  propertyDescription,
  propertyLabel,
  timestampHint,
  type FieldSchema,
} from "./values.js";

/**
 * A form over a JSON Schema: one control per property, by type, format, `x-mcp-hint` and option list. Admin's entry
 * editor, its operation dialogs and an MCP App render the same fields; what only one host can do (a media library,
 * a rich text editor) comes in through `renderField`.
 */

/** Every string the fields render; hosts pass their own translations. */
export interface FieldLabels {
  readonly emptyOption: string;
  readonly chooseOption: string;
  readonly boolean: string;
  readonly dateTimeSelect: string;
  readonly dateTimeTime: string;
  readonly removeItem: string;
  readonly addItem: string;
}

export const defaultFieldLabels: FieldLabels = {
  emptyOption: "No value",
  chooseOption: "Choose…",
  boolean: "Yes",
  dateTimeSelect: "Pick a date",
  dateTimeTime: "Time",
  removeItem: "Remove",
  addItem: "Add item",
};

/** One field as a host's own control sees it. */
export interface FieldSlot {
  readonly name: string;
  readonly schema: FieldSchema;
  readonly path: readonly string[];
  readonly value: unknown;
  readonly label: string;
  /** The string widget the field asks for: `input`, `textarea`, `markdown` or `html`. */
  readonly widget: StringWidget;
  readonly setValue: (next: unknown) => void;
}

/** A host's control for a field, or undefined to keep the default one. */
export type RenderField = (field: FieldSlot) => React.ReactNode | undefined;

export type StringWidget = "input" | "textarea" | "markdown" | "html";

export interface SchemaFieldsProps {
  readonly schema: FieldSchema;
  /** A Schema or Procedure `uiSchema`: `fields.<name>.widget: textarea`. */
  readonly uiSchema?: Readonly<Record<string, unknown>> | null;
  /** The whole value the fields edit; `path` points into it. */
  readonly value: Readonly<Record<string, unknown>>;
  readonly path?: readonly string[];
  readonly onChange: (value: Record<string, unknown>) => void;
  readonly language: string;
  readonly canonical?: string | null;
  /** Root properties not shown (bound inputs, a translation's key). */
  readonly hiddenRootFields?: readonly string[];
  readonly labels?: FieldLabels;
  readonly renderField?: RenderField;
  /** How a field's label reads; defaults to its `title`, else its name humanized. */
  readonly propertyLabel?: (name: string, schema: FieldSchema | undefined, language: string, canonical: string | null) => string;
}

export function SchemaFields(props: SchemaFieldsProps): React.ReactElement {
  const path = props.path ?? [];
  const required = new Set(props.schema.required ?? []);
  return (
    <div className="space-y-5">
      {Object.entries(props.schema.properties ?? {})
        .filter(([name]) => path.length > 0 || !(props.hiddenRootFields ?? []).includes(name))
        .map(([name, fieldSchema]) => (
          <SchemaField
            key={[...path, name].join(".")}
            {...props}
            name={name}
            fieldSchema={fieldSchema}
            widget={path.length === 0 ? fieldWidget(props.uiSchema ?? null, name) : null}
            required={required.has(name)}
            path={[...path, name]}
          />
        ))}
    </div>
  );
}

function SchemaField(props: SchemaFieldsProps & {
  readonly name: string;
  readonly fieldSchema: FieldSchema;
  readonly widget: "textarea" | null;
  readonly required: boolean;
  readonly path: readonly string[];
}): React.ReactElement {
  const { name, fieldSchema: schema, required, path, language } = props;
  const canonical = props.canonical ?? null;
  const labels = props.labels ?? defaultFieldLabels;
  const rootValue = props.value;
  const value = readPath(rootValue, path);
  const type = schemaType(schema);
  const label = (props.propertyLabel ?? propertyLabel)(name, schema, language, canonical);
  const description = propertyDescription(schema, language, canonical);
  const setValue = (next: unknown): void => props.onChange(writePath(rootValue, path, next));
  // the runtime owns bound values, so the form keeps them read-only
  const readOnly = typeof schema["x-mantle-bind"] === "string";
  const nullable = schema.nullable === true || (schema.enum ?? []).includes(null) || [schema.type].flat().includes("null");
  const nested = (childSchema: FieldSchema, childPath: readonly string[]) => <SchemaFields {...props} schema={childSchema} path={childPath} />;
  const custom = readOnly ? undefined : props.renderField?.({ name, schema, path, value, label, widget: stringFieldWidget(schema, props.widget), setValue });

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        {label}
        {required && !readOnly ? <span className="text-destructive">*</span> : null}
      </label>
      {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
      {custom !== undefined ? custom : readOnly ? (
        <p
          role="textbox"
          aria-readonly="true"
          className="flex min-h-9 cursor-not-allowed items-center justify-between gap-3 rounded-lg border border-transparent bg-muted px-3 py-2 text-sm text-muted-foreground"
        >
          <span>{(timestampHint(schema) ? formatTimestampMs(value) : stringForInput(value)) || labels.emptyOption}</span>
          <LockKeyhole className="size-4 shrink-0" aria-hidden="true" />
        </p>
      ) : schema.enum || enumOptions(schema) ? (
        <Select
          // a required field has no empty choice unless null is one of its values: it starts unchosen and the person picks one
          value={stringForInput(value) || (required && !nullable ? "" : "__empty__")}
          onValueChange={(next) => setValue(next === "__empty__" ? "" : next)}
        >
          <SelectTrigger className="w-full" aria-label={label}>
            <SelectValue placeholder={labels.chooseOption} />
          </SelectTrigger>
          <SelectContent>
            {required && !nullable ? null : <SelectItem value="__empty__">{labels.emptyOption}</SelectItem>}
            {(enumOptions(schema) ?? schema.enum!.filter((v) => v !== null).map((v) => ({ value: String(v) }))).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {optionLabel(schema, option.value, language, canonical)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : type === "boolean" ? (
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={Boolean(value)} onCheckedChange={(checked) => setValue(checked === true)} />
          {labels.boolean}
        </label>
      ) : type === "number" || type === "integer" ? (
        <div className="space-y-1">
          {timestampHint(schema) ? (
            <DateTimePicker label={label} labels={labels} value={value} onChange={(date) => setValue(date?.getTime() ?? null)} />
          ) : (
            <Input
              type="number"
              aria-label={label}
              value={numberForInput(value)}
              min={schema.minimum}
              max={schema.maximum}
              onChange={(event) => {
                const raw = event.target.value;
                setValue(raw === "" ? null : Number(raw));
              }}
            />
          )}
          <NumberFieldPreview schema={schema} value={value} rootValue={rootValue} />
        </div>
      ) : type === "object" ? (
        <div className="rounded-lg border bg-muted/20 p-4">
          {schema.properties ? nested(schema, path) : <JsonEditor value={value} onChange={setValue} />}
        </div>
      ) : type === "array" ? (
        <ArrayField schema={schema} value={Array.isArray(value) ? value : []} path={path} labels={labels}
          setArray={(next) => setValue(next)} nested={nested} />
      ) : (
        <StringFieldControl schema={schema} widget={props.widget} value={value} label={label} labels={labels} onChange={setValue} />
      )}
    </div>
  );
}

function DateTimePicker({ label, labels, value, onChange }: {
  label: string; labels: FieldLabels; value: unknown; onChange: (date: Date | undefined) => void;
}): React.ReactElement {
  const selected = dateFromFieldValue(value);
  const timeId = React.useId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-start font-normal" aria-label={label}>
          <CalendarIcon />
          {selected ? formatTimestampMs(selected.getTime()) : labels.dateTimeSelect}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(day) => {
            if (!day) return;
            const next = new Date(day);
            next.setHours(selected?.getHours() ?? 0, selected?.getMinutes() ?? 0, 0, 0);
            onChange(next);
          }}
        />
        <div className="flex items-center gap-3 border-t p-3">
          <label className="text-sm font-medium" htmlFor={timeId}>{labels.dateTimeTime}</label>
          <Input
            id={timeId}
            type="time"
            className="w-32"
            disabled={!selected}
            value={selected ? `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}` : ""}
            onChange={(event) => {
              const [hours, minutes] = event.target.value.split(":").map(Number);
              // a cleared time input reads "": keep the time already chosen
              if (!selected || !Number.isFinite(hours) || !Number.isFinite(minutes)) return;
              const next = new Date(selected);
              next.setHours(hours!, minutes!, 0, 0);
              onChange(next);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A muted preview beside a money or timestamp number, in the sibling `currency` when the value has one. */
function NumberFieldPreview({ schema, value, rootValue }: {
  schema: FieldSchema; value: unknown; rootValue: Readonly<Record<string, unknown>>;
}): React.ReactElement | null {
  const formatted = moneyMinorHint(schema) ? formatMoneyMinor(value, rootValue["currency"]) : timestampHint(schema) ? formatTimestampMs(value) : null;
  return formatted ? <p className="text-xs text-muted-foreground">= {formatted}</p> : null;
}

function ArrayField({ schema, value, path, labels, setArray, nested }: {
  schema: FieldSchema; value: unknown[]; path: readonly string[]; labels: FieldLabels;
  setArray: (next: unknown[]) => void; nested: (schema: FieldSchema, path: readonly string[]) => React.ReactNode;
}): React.ReactElement {
  const itemSchema = schema.items ?? {};
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      {value.map((item, index) => (
        <div key={index} className="rounded-lg border border-border/70 bg-card/50 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground">#{index + 1}</span>
            <Button type="button" variant="ghost" size="icon-sm" title={labels.removeItem} aria-label={labels.removeItem}
              onClick={() => setArray(value.filter((_, i) => i !== index))}>
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </div>
          {schemaType(itemSchema) === "object" && itemSchema.properties ? nested(itemSchema, [...path, String(index)]) : (
            <Input
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
      <Button type="button" variant="secondary" size="sm" onClick={() => setArray([...value, defaultValueForSchema(itemSchema)])}>
        <Plus className="size-3.5" aria-hidden />
        {labels.addItem}
      </Button>
    </div>
  );
}

function JsonEditor({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }): React.ReactElement {
  const [draft, setDraft] = React.useState(JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => setDraft(JSON.stringify(value ?? {}, null, 2)), [value]);
  return (
    <div className="space-y-2">
      <Textarea
        className="min-h-32 font-mono"
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

/** Markdown and HTML need a host's editor (`renderField`); without one they are a plain textarea. */
function StringFieldControl({ schema, widget, value, label, labels, onChange }: {
  schema: FieldSchema; widget: "textarea" | null; value: unknown; label: string; labels: FieldLabels; onChange: (next: unknown) => void;
}): React.ReactElement {
  const kind = stringFieldWidget(schema, widget);
  const text = stringForInput(value);
  if (kind !== "input") return <Textarea aria-label={label} className="min-h-24" value={text} maxLength={schema.maxLength} onChange={(event) => onChange(event.target.value)} />;
  if (schema.format === "date-time") return <DateTimePicker label={label} labels={labels} value={value} onChange={(date) => onChange(date?.toISOString() ?? "")} />;
  return <Input type="text" aria-label={label} value={text} onChange={(event) => onChange(event.target.value)} />;
}

/** The string widget a field asks for: its `x-mcp-hint`, else the uiSchema widget, else an input. */
export function stringFieldWidget(schema: FieldSchema, widget: "textarea" | null): StringWidget {
  const hint = typeof schema["x-mcp-hint"] === "string" ? schema["x-mcp-hint"] : "";
  if (hint === "markdown" || hint === "html") return hint;
  if (hint === "richtext") return "textarea";
  return widget ?? "input";
}

function fieldWidget(uiSchema: Readonly<Record<string, unknown>> | null, name: string): "textarea" | null {
  const fields = uiSchema?.["fields"];
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const config = (fields as Record<string, unknown>)[name];
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  return (config as Record<string, unknown>)["widget"] === "textarea" ? "textarea" : null;
}

function schemaType(schema: FieldSchema): string {
  const raw = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (typeof raw === "string") return raw;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "string";
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

function defaultValueForSchema(schema: FieldSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  const type = schemaType(schema);
  if (type === "object") return {};
  if (type === "array") return [];
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return 0;
  return "";
}

function readPath(root: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (typeof current === "object" && current !== null) current = (current as Record<string, unknown>)[segment];
    else return undefined;
  }
  return current;
}

function writePath(root: Readonly<Record<string, unknown>>, path: readonly string[], value: unknown): Record<string, unknown> {
  if (path.length === 0) return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const clone = structuredClone(root) as Record<string, unknown>;
  let current: unknown = clone;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const nextIsIndex = /^\d+$/.test(path[index + 1]!);
    if (Array.isArray(current)) {
      const i = Number(segment);
      current[i] = current[i] ?? (nextIsIndex ? [] : {});
      current = current[i];
    } else if (typeof current === "object" && current !== null) {
      const record = current as Record<string, unknown>;
      record[segment] = record[segment] ?? (nextIsIndex ? [] : {});
      current = record[segment];
    }
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(current)) current[Number(last)] = value;
  else if (typeof current === "object" && current !== null) (current as Record<string, unknown>)[last] = value;
  return clone;
}
