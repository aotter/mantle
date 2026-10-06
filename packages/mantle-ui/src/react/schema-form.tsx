import type { ReactNode } from "react";
import type { InteractionController, InteractionState } from "../controller/index.js";

/** The JSON Schema subset the generic form renders. */
export interface FormSchema {
  readonly type?: string | readonly string[];
  readonly title?: string | Readonly<Record<string, string>>;
  readonly description?: string | Readonly<Record<string, string>>;
  readonly properties?: Readonly<Record<string, FormSchema>>;
  readonly required?: readonly string[];
  readonly enum?: readonly unknown[];
  readonly maxLength?: number;
  readonly readOnly?: boolean;
  readonly [keyword: string]: unknown;
}

/**
 * A plain form for an operation's editable inputs, for hosts without their
 * own field renderer (an MCP App, a small application). Strings, numbers,
 * booleans and enums get native controls; anything richer is edited as JSON.
 * Fields listed in `hidden` (row bindings, the version, idempotency keys)
 * are not rendered.
 */
export function SchemaForm(props: {
  readonly schema: FormSchema;
  readonly controller: InteractionController;
  readonly state: InteractionState;
  readonly hidden?: readonly string[];
  readonly language?: string;
}): ReactNode {
  const hidden = new Set(props.hidden ?? []);
  const required = new Set(props.schema.required ?? []);
  const fields = Object.entries(props.schema.properties ?? {})
    .filter(([name, field]) => !hidden.has(name) && field.readOnly !== true);
  if (fields.length === 0) return null;
  return (
    <div data-slot="schema-form" className="grid gap-3">
      {fields.map(([name, field]) => {
        const id = `mantle-field-${name}`;
        const label = schemaText(field.title, props.language) ?? name;
        const hint = schemaText(field.description, props.language);
        const value = props.state.draft[name];
        return (
          <div key={name} className="grid gap-1 text-sm">
            <label htmlFor={id} className="font-medium">
              {label}{required.has(name) ? <span aria-hidden="true"> *</span> : null}
            </label>
            {control(id, name, field, value, required.has(name), props.controller, hint ? `${id}-hint` : undefined)}
            {hint ? <p id={`${id}-hint`} className="text-muted-foreground">{hint}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

function control(
  id: string,
  name: string,
  field: FormSchema,
  value: unknown,
  required: boolean,
  controller: InteractionController,
  describedBy: string | undefined,
): ReactNode {
  const common = { id, name, required, "aria-describedby": describedBy, className: "rounded-md border bg-background px-2 py-1" };
  const type = Array.isArray(field.type) ? field.type.find((item) => item !== "null") : field.type;
  if (field.enum) {
    return (
      <select {...common} value={value === undefined ? "" : String(value)} onChange={(event) => {
        const picked = field.enum!.find((option) => String(option) === event.target.value);
        controller.edit(name, picked);
      }}>
        <option value="" disabled={required}>—</option>
        {field.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
      </select>
    );
  }
  if (type === "boolean") {
    return <input {...common} type="checkbox" className="h-4 w-4" checked={value === true} onChange={(event) => controller.edit(name, event.target.checked)} />;
  }
  if (type === "number" || type === "integer") {
    return (
      <input {...common} type="number" step={type === "integer" ? 1 : "any"} value={typeof value === "number" ? value : ""}
        onChange={(event) => controller.edit(name, event.target.value === "" ? undefined : Number(event.target.value))} />
    );
  }
  if (type === "string") {
    const long = (field.maxLength ?? 0) > 200;
    return long
      ? <textarea {...common} rows={4} value={typeof value === "string" ? value : ""} onChange={(event) => controller.edit(name, event.target.value)} />
      : <input {...common} type="text" value={typeof value === "string" ? value : ""} onChange={(event) => controller.edit(name, event.target.value)} />;
  }
  return <JsonField common={common} name={name} value={value} controller={controller} />;
}

function JsonField(props: { common: Record<string, unknown>; name: string; value: unknown; controller: InteractionController }): ReactNode {
  return (
    <textarea
      {...props.common}
      rows={4}
      defaultValue={props.value === undefined ? "" : JSON.stringify(props.value, null, 2)}
      onBlur={(event) => {
        const raw = event.target.value.trim();
        event.target.setCustomValidity("");
        if (raw === "") return props.controller.edit(props.name, undefined);
        try {
          props.controller.edit(props.name, JSON.parse(raw) as unknown);
        } catch {
          event.target.setCustomValidity("Enter valid JSON.");
          event.target.reportValidity();
        }
      }}
    />
  );
}

/**
 * A schema `title` or `description` in the language: an exact tag, then the
 * same tag in any case, then the same primary language, then English.
 */
export function schemaText(value: FormSchema["title"], language: string | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (!value) return undefined;
  const tags = Object.keys(value);
  const wanted = language?.toLowerCase();
  const primary = wanted?.split("-")[0];
  const tag = (language && language in value ? language : undefined)
    ?? tags.find((item) => item.toLowerCase() === wanted)
    ?? tags.find((item) => item.toLowerCase().split("-")[0] === primary);
  return (tag ? value[tag] : undefined) ?? value["en"] ?? Object.values(value)[0];
}
