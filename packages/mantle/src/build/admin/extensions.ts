/** Build-time contribution metadata and existing manifest binding checks. */
import { DiagnosticError, makeDiagnostic } from "../spec/kernel/index.js";
import { UI_EXTENSION_REF, type JsonSchema, type LocalizedText, type RuntimePlan, type AdminRole } from "../spec/domain/index.js";
export const ADMIN_EXTENSION_TARGETS = {
  action: ["record/v1", "list.selection/v1", "list.toolbar/v1"],
  panel: ["record.sidebar/v1", "home/v1"],
  field: ["field.input/v1", "field.cell/v1"],
} as const;
export type AdminActionTarget = (typeof ADMIN_EXTENSION_TARGETS.action)[number];
export type AdminPanelTarget = (typeof ADMIN_EXTENSION_TARGETS.panel)[number];
export type AdminFieldTarget = (typeof ADMIN_EXTENSION_TARGETS.field)[number];

/** Where a contribution applies, by name only, so the server can evaluate it. `format` matches `x-mcp-hint` or `format`. */
export interface AdminExtensionWhen {
  readonly schema?: readonly string[];
  readonly field?: readonly string[];
  readonly format?: readonly string[];
}

export interface AdminExtensionPage {
  readonly id: string;
  readonly title: LocalizedText;
  readonly role: AdminRole;
  /** "more", "settings", a built-in group (content, operations, reports) or a navGroups id. */
  readonly nav?: { readonly group: string; readonly order?: number };
}
/** A settings page Admin renders from `schema` (the form subset) with no client code. */
export interface AdminExtensionSettings {
  readonly id: string;
  readonly title: LocalizedText;
  readonly role: AdminRole;
  readonly schema: JsonSchema;
}
export interface AdminExtensionAction {
  readonly id: string;
  readonly title: LocalizedText;
  readonly role: AdminRole;
  readonly target: AdminActionTarget;
  /** `run` calls the server at once, `confirm` asks first, `dialog` mounts the module's renderer in an Admin dialog. */
  readonly presentation: "run" | "confirm" | "dialog";
  readonly destructive?: boolean;
  readonly when?: AdminExtensionWhen;
}
export interface AdminExtensionPanel {
  readonly id: string;
  readonly title: LocalizedText;
  readonly role: AdminRole;
  readonly target: AdminPanelTarget;
  readonly when?: AdminExtensionWhen;
}
export interface AdminExtensionField {
  readonly id: string;
  readonly target: AdminFieldTarget;
  /** Default `admin`; Admin routes enforce the admin-layer gate. */
  readonly role?: AdminRole;
  readonly when?: AdminExtensionWhen;
  /** The form subset `uiSchema` `options` must satisfy; without it, `options` is refused. */
  readonly optionsSchema?: JsonSchema;
}

export interface AdminExtensionContributions {
  readonly pages?: readonly AdminExtensionPage[];
  readonly settings?: readonly AdminExtensionSettings[];
  readonly actions?: readonly AdminExtensionAction[];
  readonly panels?: readonly AdminExtensionPanel[];
  readonly fields?: readonly AdminExtensionField[];
}

export interface AdminExtension {
  readonly apiVersion?: 1;
  readonly id: string;
  readonly title?: LocalizedText;
  readonly module?: string;
  readonly integrity?: string;
  readonly source?: unknown;
  readonly contributes: AdminExtensionContributions;
}
const invalid = (code: "UI_EXTENSION_INVALID" | "UI_EXTENSION_UNKNOWN" | "UI_EXTENSION_TARGET" | "UI_EXTENSION_OPTIONS", path: string, message: string, value?: unknown) =>
  new DiagnosticError(makeDiagnostic({ code, phase: "boot", severity: "error", path, message, ...(value === undefined ? {} : { value }) }));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is LocalizedText => (typeof v === "string" && v.length > 0) || (isObject(v) && Object.keys(v).length > 0 && Object.values(v).every((x) => typeof x === "string" && x.length > 0));
const keysWithin = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).find((k) => !allowed.includes(k));

// ---------- the form subset (settings schemas and field options) ----------

const FORM_TYPES = ["string", "number", "integer", "boolean"];
const FORM_PROPERTY_KEYS = ["type", "title", "description", "default", "enum", "oneOf", "minimum", "maximum", "minLength", "maxLength"];

/** Why `schema` is outside the form subset Admin renders and checks, or `null`. */
export function formSchemaProblem(schema: unknown): string | null {
  if (!isObject(schema) || schema["type"] !== "object" || !isObject(schema["properties"])) return "an object schema with properties";
  const extra = keysWithin(schema, ["type", "properties", "required", "title", "description", "additionalProperties"]);
  if (extra) return `no '${extra}' at the top level`;
  if (schema["additionalProperties"] !== undefined && schema["additionalProperties"] !== false) return "additionalProperties false or absent";
  const props = schema["properties"];
  const names = Object.keys(props);
  if (names.length === 0 || names.length > 64) return "1 to 64 properties";
  if (names.includes("__proto__")) return "no property named __proto__";
  const required = schema["required"];
  if (required !== undefined && (!Array.isArray(required) || required.some((r) => typeof r !== "string" || !names.includes(r)))) return "required naming declared properties";
  for (const [name, p] of Object.entries(props)) {
    if (!isObject(p) || typeof p["type"] !== "string" || !FORM_TYPES.includes(p["type"])) return `property '${name}' typed string, number, integer or boolean`;
    const bad = keysWithin(p, FORM_PROPERTY_KEYS);
    if (bad) return `property '${name}' without '${bad}'`;
    if (p["title"] !== undefined && !isText(p["title"])) return `property '${name}' with a text title`;
    if (p["description"] !== undefined && !isText(p["description"])) return `property '${name}' with a text description`;
    if (p["enum"] !== undefined && (!Array.isArray(p["enum"]) || p["enum"].length === 0 || p["enum"].some((x) => !matchesType(p["type"] as string, x)))) return `property '${name}' with an enum of its type`;
    if (p["oneOf"] !== undefined && (!Array.isArray(p["oneOf"]) || p["oneOf"].length === 0 || p["oneOf"].some((o) => !isObject(o) || keysWithin(o, ["const", "title"]) || !matchesType(p["type"] as string, o["const"]) || (o["title"] !== undefined && !isText(o["title"]))))) return `property '${name}' with a oneOf of { const, title }`;
    for (const k of ["minimum", "maximum", "minLength", "maxLength"]) if (p[k] !== undefined && (typeof p[k] !== "number" || !Number.isFinite(p[k]))) return `property '${name}' with a numeric ${k}`;
    if (p["default"] !== undefined && checkValue(p, p["default"]) !== null) return `property '${name}' with a default it accepts`;
  }
  return null;
}

function matchesType(type: string, v: unknown): boolean {
  if (type === "string") return typeof v === "string";
  if (type === "boolean") return typeof v === "boolean";
  if (type === "integer") return Number.isInteger(v);
  return typeof v === "number" && Number.isFinite(v);
}

function checkValue(p: Record<string, unknown>, v: unknown): string | null {
  const type = p["type"] as string;
  if (!matchesType(type, v)) return type === "integer" ? "an integer" : `a ${type}`;
  if (Array.isArray(p["enum"]) && !p["enum"].includes(v)) return "one of the listed values";
  if (Array.isArray(p["oneOf"]) && !p["oneOf"].some((o) => (o as Record<string, unknown>)["const"] === v)) return "one of the listed values";
  if (typeof v === "number") {
    if (typeof p["minimum"] === "number" && v < p["minimum"]) return `at least ${p["minimum"]}`;
    if (typeof p["maximum"] === "number" && v > p["maximum"]) return `at most ${p["maximum"]}`;
  }
  if (typeof v === "string") {
    const length = [...v].length;
    if (typeof p["minLength"] === "number" && length < p["minLength"]) return `at least ${p["minLength"]} characters`;
    if (typeof p["maxLength"] === "number" && length > p["maxLength"]) return `at most ${p["maxLength"]} characters`;
  }
  return null;
}

/** Checks `value` against a form-subset `schema`: the errors by field, empty when it passes. */
export function checkFormValue(schema: JsonSchema, value: unknown): Readonly<Record<string, string>> {
  if (!isObject(value)) return { "": "an object" };
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  // own properties only, and no prototype: `constructor` or `__proto__` is a field name like any other
  const errors: Record<string, string> = Object.create(null) as Record<string, string>;
  const has = (name: string) => Object.hasOwn(value, name) && value[name] !== undefined;
  for (const k of Object.keys(value)) if (!Object.hasOwn(props, k)) errors[k] = "no such field";
  for (const name of schema.required ?? []) if (!has(name)) errors[name] = "required";
  for (const [name, p] of Object.entries(props)) {
    // null is a value, and none of the form subset's types accepts it
    if (!has(name) || Object.hasOwn(errors, name)) continue;
    const problem = checkValue(p, value[name]);
    if (problem) errors[name] = `expected ${problem}`;
  }
  return errors;
}

/** Every `<extension>/<contribution>` the plan's `uiSchema` names, with the target its key needs. */
export function planUiExtensionRefs(plan: Pick<RuntimePlan, "schemas" | "views" | "procedures">) {
  const refs: { readonly path: string; readonly ref: string; readonly target: AdminFieldTarget | AdminPanelTarget; readonly options?: unknown }[] = [];
  const fields = (owner: string, ui: Record<string, unknown> | undefined) => {
    for (const [name, c] of Object.entries(isObject(ui?.["fields"]) ? ui["fields"] : {})) {
      if (isObject(c) && typeof c["widget"] === "string" && UI_EXTENSION_REF.test(c["widget"])) refs.push({ path: `${owner}/uiSchema/fields/${name}/widget`, ref: c["widget"], target: "field.input/v1", ...(c["options"] === undefined ? {} : { options: c["options"] }) });
    }
  };
  const cells = (owner: string, ui: Record<string, unknown> | undefined) => {
    const list = ui?.["list"];
    for (const [name, ref] of Object.entries(isObject(list) && isObject(list["cells"]) ? list["cells"] : {})) if (typeof ref === "string") refs.push({ path: `${owner}/uiSchema/list/cells/${name}`, ref, target: "field.cell/v1" });
  };
  for (const [name, s] of Object.entries(plan.schemas)) {
    const owner = `schema:${s.name ?? name}`;
    const ui = s.uiSchema as Record<string, unknown> | undefined;
    fields(owner, ui);
    cells(owner, ui);
    const panels = ui?.["panels"];
    if (Array.isArray(panels)) for (const ref of panels) if (typeof ref === "string") refs.push({ path: `${owner}/uiSchema/panels`, ref, target: "record.sidebar/v1" });
  }
  for (const [name, p] of Object.entries(plan.procedures)) fields(`procedure:${name}`, p.uiSchema as Record<string, unknown> | undefined);
  for (const [name, v] of Object.entries(plan.views)) cells(`view:${name}`, v.uiSchema as Record<string, unknown> | undefined);
  return refs;
}

/** Checks that each contribution the plan names exists, has the target its key needs, and accepts its `options`. */
export function checkPlanUiExtensions(plan: Pick<RuntimePlan, "schemas" | "views" | "procedures">, extensions: readonly Pick<AdminExtension, "id" | "contributes">[]): void {
  for (const { path, ref, target, options } of planUiExtensionRefs(plan)) {
    const [, extId, cId] = UI_EXTENSION_REF.exec(ref)!;
    const ext = extensions.find((e) => e.id === extId);
    const c = ext ? [...(ext.contributes.fields ?? []), ...(ext.contributes.panels ?? [])].find((x) => x.id === cId) : undefined;
    if (!c) throw invalid("UI_EXTENSION_UNKNOWN", path, `no Admin extension contribution '${ref}'`, ref);
    if (c.target !== target) throw invalid("UI_EXTENSION_TARGET", path, `'${ref}' is a ${c.target} contribution; this key needs ${target}`, ref);
    if (options === undefined) continue;
    const schema = (c as AdminExtensionField).optionsSchema;
    if (!schema) throw invalid("UI_EXTENSION_OPTIONS", path, `'${ref}' takes no options`, options);
    const errors = checkFormValue(schema, options);
    const first = Object.entries(errors)[0];
    if (first) throw invalid("UI_EXTENSION_OPTIONS", `${path}/${first[0]}`, `options for '${ref}': ${first[0] || "options"} ${first[1]}`, options);
  }
}

