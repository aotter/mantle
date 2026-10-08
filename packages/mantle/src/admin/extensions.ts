/**
 * Admin extensions (ADR-lite 1376): a declaration that is plain data, server handlers that are code, and an optional
 * same-origin module with the renderers. Admin validates every declaration at construction, sends the caller the
 * contributions their role reaches, and checks the session and role again on every extension route.
 */
import { DiagnosticError, makeDiagnostic } from "../spec/kernel/index.js";
import { UI_EXTENSION_REF, isStaffRole, meetsRole, type JsonSchema, type LocalizedText, type RuntimePlan, type StaffRole } from "../spec/domain/index.js";
import type { Caller } from "../core/index.js";
import { json, readJsonObject, wireError } from "../core/wire.js";

export type AdminExtensionCaller = Extract<Caller, { kind: "user" }> & { readonly role: StaffRole };

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
  readonly role: StaffRole;
  readonly nav?: { readonly group: "more" | "settings"; readonly order?: number };
}
/** A settings page Admin renders from `schema` (the form subset) with no client code. */
export interface AdminExtensionSettings {
  readonly id: string;
  readonly title: LocalizedText;
  readonly role: StaffRole;
  readonly schema: JsonSchema;
}
export interface AdminExtensionAction {
  readonly id: string;
  readonly title: LocalizedText;
  readonly role: StaffRole;
  readonly target: AdminActionTarget;
  /** `run` calls the server at once, `confirm` asks first, `dialog` mounts the module's renderer in an Admin dialog. */
  readonly presentation: "run" | "confirm" | "dialog";
  readonly destructive?: boolean;
  readonly when?: AdminExtensionWhen;
}
export interface AdminExtensionPanel {
  readonly id: string;
  readonly title: LocalizedText;
  readonly role: StaffRole;
  readonly target: AdminPanelTarget;
  readonly when?: AdminExtensionWhen;
}
export interface AdminExtensionField {
  readonly id: string;
  readonly target: AdminFieldTarget;
  /** Default `contributor`: a viewer below it gets Admin's own widget. */
  readonly role?: StaffRole;
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

export interface AdminExtensionRecordRef { readonly schema: string; readonly id: string; readonly version?: number }
export interface AdminExtensionSelection { readonly schema: string; readonly ids: readonly string[] }

export interface AdminExtensionHandlers {
  /** `{basePath}/api/x/{extension}/api/{path}`, for the extension's lowest contribution role and above; `null` answers 404. */
  readonly api?: (request: Request, context: { readonly caller: AdminExtensionCaller; readonly extension: string; readonly path: string }) => Response | null | Promise<Response | null>;
  readonly settings?: Readonly<Record<string, {
    load(caller: AdminExtensionCaller): unknown;
    /** Receives a value already checked against the settings `schema`; may return the stored value. */
    save(caller: AdminExtensionCaller, value: Readonly<Record<string, unknown>>): unknown;
  }>>;
  readonly actions?: Readonly<Record<string, {
    run(caller: AdminExtensionCaller, input: { readonly record?: AdminExtensionRecordRef; readonly selection?: AdminExtensionSelection; readonly schema?: string }): unknown;
  }>>;
}

export interface AdminExtension {
  readonly apiVersion: 1;
  /** Kebab-case, unique per Admin, and never changed once deployed. */
  readonly id: string;
  readonly title: LocalizedText;
  /** A same-origin ESM path the host serves, whose default export is `defineAdminExtension({...})`. */
  readonly module?: string;
  /** Subresource Integrity for `module`, enforced through Admin's import map. */
  readonly integrity?: string;
  /**
   * The module's code, which Admin serves itself at `{basePath}/extensions/{id}.js` to staff whose role reaches the
   * extension, with its integrity computed. Plain ESM needs no build: Admin's import map resolves `react`,
   * `react/jsx-runtime`, `react-dom/client`, `@aotter/mantle-ui/kit` and `@aotter/mantle-ui/extension`.
   */
  readonly source?: string | (() => string | Promise<string>);
  readonly contributes: AdminExtensionContributions;
  readonly handlers?: AdminExtensionHandlers;
}

const P = "admin";
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const MODULE = /^\/(?![/\\])[^\s?#]*$/;
const INTEGRITY = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
const ROLE_ORDER: readonly StaffRole[] = ["contributor", "editor", "owner"];

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

// ---------- declarations ----------

function checkWhen(when: unknown, path: string): void {
  if (when === undefined) return;
  if (!isObject(when) || keysWithin(when, ["schema", "field", "format"]) || Object.keys(when).length === 0) throw invalid("UI_EXTENSION_INVALID", path, "when has schema, field or format", when);
  for (const [k, v] of Object.entries(when)) {
    if (!Array.isArray(v) || v.length === 0 || v.length > 64 || v.some((x) => typeof x !== "string" || x.length === 0)) throw invalid("UI_EXTENSION_INVALID", `${path}/${k}`, `when.${k} is a non-empty list of names`, v);
  }
}

const CONTRIBUTION_KEYS = {
  pages: ["id", "title", "role", "nav"],
  settings: ["id", "title", "role", "schema"],
  actions: ["id", "title", "role", "target", "presentation", "destructive", "when"],
  panels: ["id", "title", "role", "target", "when"],
  fields: ["id", "target", "role", "when", "optionsSchema"],
} as const;
type Kind = keyof typeof CONTRIBUTION_KEYS;
const KINDS = Object.keys(CONTRIBUTION_KEYS) as Kind[];

/** Validates every declaration and their handlers; throws `UI_EXTENSION_INVALID` naming the first problem. */
export function validateAdminExtensions(extensions: readonly AdminExtension[]): void {
  if (!Array.isArray(extensions)) throw invalid("UI_EXTENSION_INVALID", "admin-extensions", "extensions is a list");
  const seen = new Set<string>();
  for (const ext of extensions) {
    const at = `admin-extension:${isObject(ext) && typeof ext["id"] === "string" ? ext["id"] : "?"}`;
    if (!isObject(ext)) throw invalid("UI_EXTENSION_INVALID", at, "an extension is an object");
    const extra = keysWithin(ext, ["apiVersion", "id", "title", "module", "integrity", "source", "contributes", "handlers"]);
    if (extra) throw invalid("UI_EXTENSION_INVALID", `${at}/${extra}`, `unknown key '${extra}'`);
    if (ext["apiVersion"] !== 1) throw invalid("UI_EXTENSION_INVALID", `${at}/apiVersion`, "apiVersion 1", ext["apiVersion"]);
    if (typeof ext["id"] !== "string" || !ID.test(ext["id"])) throw invalid("UI_EXTENSION_INVALID", `${at}/id`, "a kebab-case id", ext["id"]);
    if (seen.has(ext["id"])) throw invalid("UI_EXTENSION_INVALID", `${at}/id`, `extension id '${ext["id"]}' is used twice`, ext["id"]);
    seen.add(ext["id"]);
    if (!isText(ext["title"])) throw invalid("UI_EXTENSION_INVALID", `${at}/title`, "a title");
    // same origin only: an absolute path, never a scheme-relative or external URL
    if (ext["module"] !== undefined && (typeof ext["module"] !== "string" || !MODULE.test(ext["module"]))) throw invalid("UI_EXTENSION_INVALID", `${at}/module`, "a same-origin absolute path", ext["module"]);
    if (ext["source"] !== undefined && typeof ext["source"] !== "string" && typeof ext["source"] !== "function") throw invalid("UI_EXTENSION_INVALID", `${at}/source`, "source is the module's code or a function returning it");
    if (ext["source"] !== undefined && ext["module"] !== undefined) throw invalid("UI_EXTENSION_INVALID", `${at}/source`, "either module (served by the host) or source (served by Admin), not both");
    if (ext["integrity"] !== undefined && (typeof ext["integrity"] !== "string" || !INTEGRITY.test(ext["integrity"]) || ext["module"] === undefined)) throw invalid("UI_EXTENSION_INVALID", `${at}/integrity`, "sha256-, sha384- or sha512- integrity for a module", ext["integrity"]);
    const contributes = ext["contributes"];
    if (!isObject(contributes)) throw invalid("UI_EXTENSION_INVALID", `${at}/contributes`, "contributes is an object");
    const extraKind = keysWithin(contributes, KINDS);
    if (extraKind) throw invalid("UI_EXTENSION_INVALID", `${at}/contributes/${extraKind}`, `unknown contribution kind '${extraKind}'`);
    const ids = new Set<string>();
    let count = 0;
    for (const kind of KINDS) {
      const list = contributes[kind];
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw invalid("UI_EXTENSION_INVALID", `${at}/contributes/${kind}`, `${kind} is a list`);
      for (const c of list) {
        const cat = `${at}/${kind}/${isObject(c) && typeof c["id"] === "string" ? c["id"] : "?"}`;
        if (!isObject(c)) throw invalid("UI_EXTENSION_INVALID", cat, "a contribution is an object");
        const bad = keysWithin(c, CONTRIBUTION_KEYS[kind]);
        if (bad) throw invalid("UI_EXTENSION_INVALID", `${cat}/${bad}`, `unknown key '${bad}'`);
        if (typeof c["id"] !== "string" || !ID.test(c["id"])) throw invalid("UI_EXTENSION_INVALID", `${cat}/id`, "a kebab-case id", c["id"]);
        // one namespace per extension, so `<extension>/<contribution>` names exactly one
        if (ids.has(c["id"])) throw invalid("UI_EXTENSION_INVALID", `${cat}/id`, `contribution id '${c["id"]}' is used twice`, c["id"]);
        ids.add(c["id"]);
        count++;
        if (kind !== "fields" && !isText(c["title"])) throw invalid("UI_EXTENSION_INVALID", `${cat}/title`, "a title");
        if ((kind !== "fields" || c["role"] !== undefined) && (typeof c["role"] !== "string" || !isStaffRole(c["role"]))) throw invalid("UI_EXTENSION_INVALID", `${cat}/role`, "a staff role", c["role"]);
        if (kind === "actions" || kind === "panels" || kind === "fields") {
          const targets: readonly string[] = ADMIN_EXTENSION_TARGETS[kind === "actions" ? "action" : kind === "panels" ? "panel" : "field"];
          if (!targets.includes(c["target"] as string)) throw invalid("UI_EXTENSION_INVALID", `${cat}/target`, `one of ${targets.join(", ")}`, c["target"]);
          checkWhen(c["when"], `${cat}/when`);
        }
        if (kind === "pages" && c["nav"] !== undefined) {
          const nav = c["nav"];
          if (!isObject(nav) || keysWithin(nav, ["group", "order"]) || (nav["group"] !== "more" && nav["group"] !== "settings") || (nav["order"] !== undefined && !Number.isInteger(nav["order"]))) throw invalid("UI_EXTENSION_INVALID", `${cat}/nav`, "nav { group: more | settings, order? }", nav);
        }
        if (kind === "actions") {
          if (!["run", "confirm", "dialog"].includes(c["presentation"] as string)) throw invalid("UI_EXTENSION_INVALID", `${cat}/presentation`, "run, confirm or dialog", c["presentation"]);
          if (c["destructive"] !== undefined && typeof c["destructive"] !== "boolean") throw invalid("UI_EXTENSION_INVALID", `${cat}/destructive`, "a boolean", c["destructive"]);
        }
        const formKey = kind === "settings" ? "schema" : kind === "fields" ? "optionsSchema" : null;
        if (formKey && (kind === "settings" || c[formKey] !== undefined)) {
          const problem = formSchemaProblem(c[formKey]);
          if (problem) throw invalid("UI_EXTENSION_INVALID", `${cat}/${formKey}`, `the form subset: ${problem}`);
        }
        const rendered = kind === "pages" || kind === "panels" || kind === "fields" || (kind === "actions" && c["presentation"] === "dialog");
        if (rendered && ext["module"] === undefined && ext["source"] === undefined) throw invalid("UI_EXTENSION_INVALID", `${at}/module`, `'${c["id"]}' renders, so the extension needs a module or a source`);
      }
    }
    if (count === 0) throw invalid("UI_EXTENSION_INVALID", `${at}/contributes`, "at least one contribution");
    checkHandlers(ext as unknown as AdminExtension, at);
  }
}

function checkHandlers(ext: AdminExtension, at: string): void {
  const raw: unknown = ext.handlers ?? {};
  if (!isObject(raw) || keysWithin(raw, ["api", "settings", "actions"])) throw invalid("UI_EXTENSION_INVALID", `${at}/handlers`, "handlers has api, settings and actions");
  const h = raw as AdminExtensionHandlers;
  if (h.api !== undefined && typeof h.api !== "function") throw invalid("UI_EXTENSION_INVALID", `${at}/handlers/api`, "a function");
  const settings = ext.contributes.settings ?? [];
  for (const s of settings) {
    const handler = h.settings?.[s.id];
    if (typeof handler?.load !== "function" || typeof handler.save !== "function") throw invalid("UI_EXTENSION_INVALID", `${at}/handlers/settings/${s.id}`, `settings '${s.id}' needs load and save`);
  }
  for (const id of Object.keys(h.settings ?? {})) if (!settings.some((s) => s.id === id)) throw invalid("UI_EXTENSION_INVALID", `${at}/handlers/settings/${id}`, `no settings contribution '${id}'`);
  const server = (ext.contributes.actions ?? []).filter((a) => a.presentation !== "dialog");
  for (const a of server) if (typeof h.actions?.[a.id]?.run !== "function") throw invalid("UI_EXTENSION_INVALID", `${at}/handlers/actions/${a.id}`, `action '${a.id}' needs run`);
  for (const id of Object.keys(h.actions ?? {})) if (!server.some((a) => a.id === id)) throw invalid("UI_EXTENSION_INVALID", `${at}/handlers/actions/${id}`, `no run or confirm action '${id}'`);
}

// ---------- uiSchema references (§1b) ----------

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
export function checkPlanUiExtensions(plan: Pick<RuntimePlan, "schemas" | "views" | "procedures">, extensions: readonly AdminExtension[]): void {
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

// ---------- what a caller sees ----------

const fieldRole = (f: AdminExtensionField): StaffRole => f.role ?? "contributor";

/** The declarations (never handlers or integrity) of the contributions `role` reaches; extensions with none are left out. */
export function adminExtensionsFor(extensions: readonly AdminExtension[], role: StaffRole, basePath = "/admin") {
  return extensions.flatMap((e) => {
    const reach = <T extends { readonly role?: StaffRole }>(xs: readonly T[] | undefined, roleOf: (x: T) => StaffRole) => (xs ?? []).filter((x) => meetsRole(role, roleOf(x)));
    const contributes = {
      pages: reach(e.contributes.pages, (x) => x.role),
      settings: reach(e.contributes.settings, (x) => x.role),
      actions: reach(e.contributes.actions, (x) => x.role),
      panels: reach(e.contributes.panels, (x) => x.role),
      fields: reach(e.contributes.fields, fieldRole),
    };
    if (Object.values(contributes).every((xs) => xs.length === 0)) return [];
    const module = e.module ?? (e.source !== undefined ? extensionSourcePath(basePath, e.id) : undefined);
    return [{ id: e.id, title: e.title, ...(module ? { module } : {}), contributes }];
  });
}

export const extensionSourcePath = (basePath: string, id: string) => `${basePath}/extensions/${id}.js`;

const sources = new WeakMap<AdminExtension, Promise<{ code: string; integrity: string }>>();
/** The code Admin serves for a `source` extension and its sha384 integrity, read once. */
export function extensionSource(e: AdminExtension): Promise<{ code: string; integrity: string }> | null {
  if (e.source === undefined) return null;
  let found = sources.get(e);
  if (!found) {
    found = (async () => {
      const code = typeof e.source === "function" ? await e.source() : e.source!;
      if (typeof code !== "string" || code.length === 0) throw invalid("UI_EXTENSION_INVALID", `admin-extension:${e.id}/source`, "source returned no code");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-384", new TextEncoder().encode(code)));
      return { code, integrity: `sha384-${btoa(String.fromCharCode(...digest))}` };
    })();
    // a failed read may succeed later (a deploy, a transient store error): do not keep the failure
    found.catch(() => sources.delete(e));
    sources.set(e, found);
  }
  return found;
}

/** `{basePath}/extensions/{id}.js`: a `source` extension's module, for staff whose role reaches one of its contributions. */
export async function adminExtensionModule(extensions: readonly AdminExtension[], id: string, caller: AdminExtensionCaller): Promise<Response> {
  const ext = extensions.find((e) => e.id === id && e.source !== undefined);
  if (!ext) throw wireError("NOT_FOUND", "no such route", P);
  const role = apiRole(ext);
  if (!meetsRole(caller.role, role)) throw denied(role);
  const { code } = await extensionSource(ext)!;
  return new Response(code, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "private, no-cache", "x-content-type-options": "nosniff" } });
}

/** The lowest role any of the extension's contributions needs: whoever sees one of them may call its API. */
function apiRole(e: AdminExtension): StaffRole {
  const roles = [
    ...KINDS.filter((k) => k !== "fields").flatMap((k) => ((e.contributes[k] ?? []) as readonly { readonly role: StaffRole }[]).map((c) => c.role)),
    ...(e.contributes.fields ?? []).map(fieldRole),
  ];
  return ROLE_ORDER.find((r) => roles.includes(r)) ?? "owner";
}

const denied = (role: StaffRole) => wireError("AUTH_DENIED", `This needs the ${role} role.`, P);
const noStore = (out: Response): Response => {
  // like every Admin API answer, staff data is not cached unless the extension says otherwise
  if (out.headers.has("cache-control")) return out;
  const headers = new Headers(out.headers);
  headers.set("cache-control", "no-store");
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
};

function readRef(v: unknown, path: string): AdminExtensionRecordRef {
  if (!isObject(v) || typeof v["schema"] !== "string" || typeof v["id"] !== "string" || !v["id"] || (v["version"] !== undefined && !Number.isInteger(v["version"]))) throw wireError("INPUT_VALIDATION_FAILED", `${path} is { schema, id, version? }`, P);
  return { schema: v["schema"], id: v["id"], ...(v["version"] === undefined ? {} : { version: v["version"] as number }) };
}

/**
 * Answers `{basePath}/api/x/{extension}/...` after Admin's session checks: `settings/{id}` (GET loads, PATCH saves),
 * `actions/{id}` (POST runs) and `api/{path}` (the extension's own API). `null` when the path is not an extension's.
 */
export async function adminExtensionRoute(extensions: readonly AdminExtension[], request: Request, rest: string, caller: AdminExtensionCaller): Promise<Response> {
  const m = /^([^/]+)\/(settings|actions|api)(?:\/(.*))?$/.exec(rest);
  const ext = m ? extensions.find((e) => e.id === m[1]) : undefined;
  if (!m || !ext) throw wireError("NOT_FOUND", "no such route", P);
  const [, , kind, tail = ""] = m;
  const NO_STORE = { "cache-control": "no-store" };
  if (kind === "api") {
    const role = apiRole(ext);
    if (!meetsRole(caller.role, role)) throw denied(role);
    const out = ext.handlers?.api ? await ext.handlers.api(request, { caller, extension: ext.id, path: tail }) : null;
    if (!out) throw wireError("NOT_FOUND", "no such route", P);
    return noStore(out);
  }
  if (kind === "settings") {
    const s = ext.contributes.settings?.find((x) => x.id === tail);
    const handler = s && ext.handlers?.settings?.[s.id];
    if (!s || !handler) throw wireError("NOT_FOUND", "no such route", P);
    if (!meetsRole(caller.role, s.role)) throw denied(s.role);
    if (request.method === "GET") return json({ value: (await handler.load(caller)) ?? null }, 200, NO_STORE);
    // PATCH, as Admin's own site settings: the body is the whole value, checked against the schema
    if (request.method !== "PATCH") throw wireError("METHOD_NOT_ALLOWED", "settings take GET or PATCH", P);
    const value = (await readJsonObject(request, P))["value"];
    const errors = checkFormValue(s.schema, value);
    if (Object.keys(errors).length > 0) return json({ error: { code: "INPUT_VALIDATION_FAILED", message: "The settings do not match their schema.", fields: errors } }, 400, NO_STORE);
    const saved = await handler.save(caller, value as Record<string, unknown>);
    return json({ value: saved ?? value }, 200, NO_STORE);
  }
  const a = ext.contributes.actions?.find((x) => x.id === tail && x.presentation !== "dialog");
  const handler = a && ext.handlers?.actions?.[a.id];
  if (!a || !handler) throw wireError("NOT_FOUND", "no such route", P);
  if (request.method !== "POST") throw wireError("METHOD_NOT_ALLOWED", "actions take POST", P);
  if (!meetsRole(caller.role, a.role)) throw denied(a.role);
  const body = await readJsonObject(request, P);
  let input: { record?: AdminExtensionRecordRef; selection?: AdminExtensionSelection; schema?: string };
  if (a.target === "record/v1") {
    input = { record: readRef(body["record"], "record") };
  } else if (a.target === "list.selection/v1") {
    const sel = body["selection"];
    if (!isObject(sel) || typeof sel["schema"] !== "string" || !Array.isArray(sel["ids"]) || sel["ids"].length === 0 || sel["ids"].length > 1000 || sel["ids"].some((x) => typeof x !== "string" || !x)) throw wireError("INPUT_VALIDATION_FAILED", "selection is { schema, ids } with 1 to 1000 ids", P);
    input = { selection: { schema: sel["schema"], ids: sel["ids"] as string[] } };
  } else {
    if (typeof body["schema"] !== "string") throw wireError("INPUT_VALIDATION_FAILED", "schema names the list", P);
    input = { schema: body["schema"] };
  }
  // `when` is checked here as well as in the console, so a crafted request cannot run an action somewhere it was not offered
  const schema = input.record?.schema ?? input.selection?.schema ?? input.schema!;
  if (a.when?.schema && !a.when.schema.includes(schema)) throw wireError("NOT_FOUND", "no such route", P);
  const result = await handler.run(caller, input);
  return json({ ok: true, result: result ?? null }, 200, NO_STORE);
}

// ---------- tooling ----------

export interface AdminExtensionChange {
  readonly change: "added" | "removed" | "changed";
  /** `<extension>` or `<extension>/<contribution>` */
  readonly ref: string;
  /** For `changed`: the keys that differ, e.g. `role`, `target`, `module`. */
  readonly keys?: readonly string[];
}

const declaration = (e: AdminExtension) => ({ id: e.id, title: e.title, module: e.module, integrity: e.integrity });

/** What changed between two sets of declarations, for review screens. Handlers are code and are not compared. */
export function diffAdminExtensions(previous: readonly AdminExtension[], next: readonly AdminExtension[]): readonly AdminExtensionChange[] {
  const out: AdminExtensionChange[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const changedKeys = (a: Record<string, unknown>, b: Record<string, unknown>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k])).sort();
  const contributions = (e: AdminExtension) => new Map(KINDS.flatMap((k) => ((e.contributes[k] ?? []) as readonly { readonly id: string }[]).map((c) => [c.id, { kind: k, ...c }] as const)));
  for (const p of previous) if (!next.some((n) => n.id === p.id)) out.push({ change: "removed", ref: p.id });
  for (const n of next) {
    const p = previous.find((x) => x.id === n.id);
    if (!p) {
      out.push({ change: "added", ref: n.id });
      for (const id of contributions(n).keys()) out.push({ change: "added", ref: `${n.id}/${id}` });
      continue;
    }
    const keys = changedKeys(declaration(p), declaration(n));
    if (keys.length) out.push({ change: "changed", ref: n.id, keys });
    const before = contributions(p);
    const after = contributions(n);
    for (const [id] of before) if (!after.has(id)) out.push({ change: "removed", ref: `${n.id}/${id}` });
    for (const [id, c] of after) {
      const b = before.get(id);
      if (!b) out.push({ change: "added", ref: `${n.id}/${id}` });
      else {
        const k = changedKeys(b, c);
        if (k.length) out.push({ change: "changed", ref: `${n.id}/${id}`, keys: k });
      }
    }
  }
  return out;
}

const text = { anyOf: [{ type: "string", minLength: 1 }, { type: "object", additionalProperties: { type: "string", minLength: 1 }, minProperties: 1 }] };
const id = { type: "string", pattern: ID.source };
const role = { enum: ["owner", "editor", "contributor"] };
const names = { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 64 };
const when = { type: "object", additionalProperties: false, minProperties: 1, properties: { schema: names, field: names, format: names } };
const form = { type: "object", description: "The form subset: an object schema whose properties are string, number, integer or boolean with title, description, default, enum, oneOf, minimum, maximum, minLength and maxLength." };
const contribution = (props: Record<string, unknown>, required: readonly string[]) => ({ type: "object", additionalProperties: false, required: ["id", ...required], properties: { id, ...props } });

/** JSON Schema of one extension's declaration (handlers excluded), for tooling and agents. */
export const ADMIN_EXTENSION_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Mantle Admin extension declaration",
  type: "object",
  additionalProperties: false,
  required: ["apiVersion", "id", "title", "contributes"],
  properties: {
    apiVersion: { const: 1 },
    id,
    title: text,
    module: { type: "string", pattern: MODULE.source },
    integrity: { type: "string", pattern: INTEGRITY.source },
    contributes: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        pages: { type: "array", items: contribution({ title: text, role, nav: { type: "object", additionalProperties: false, required: ["group"], properties: { group: { enum: ["more", "settings"] }, order: { type: "integer" } } } }, ["title", "role"]) },
        settings: { type: "array", items: contribution({ title: text, role, schema: form }, ["title", "role", "schema"]) },
        actions: { type: "array", items: contribution({ title: text, role, target: { enum: ADMIN_EXTENSION_TARGETS.action }, presentation: { enum: ["run", "confirm", "dialog"] }, destructive: { type: "boolean" }, when }, ["title", "role", "target", "presentation"]) },
        panels: { type: "array", items: contribution({ title: text, role, target: { enum: ADMIN_EXTENSION_TARGETS.panel }, when }, ["title", "role", "target"]) },
        fields: { type: "array", items: contribution({ target: { enum: ADMIN_EXTENSION_TARGETS.field }, role, when, optionsSchema: form }, ["target"]) },
      },
    },
  },
} as const;
