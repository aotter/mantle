/** Extension declaration grammar; executable hooks receive the native Admin context. */
/** Opaque build-validated JSON schema data; the kernel never interprets it. */
export type AdminExtensionSchema = Readonly<Record<string, unknown>>;
type JsonSchema = AdminExtensionSchema;
type LocalizedText = string | Readonly<Record<string, string>>;
import type { Context } from "./index.js";
export type AdminExtensionCaller = Context<unknown, unknown>["caller"];
type Admin = AdminExtensionCaller;
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
    readonly role: "admin";
    readonly nav?: {
        /** "more", "settings", a built-in group (content, operations, reports) or a navGroups id. */
        readonly group: string;
        readonly order?: number;
    };
}
/** A settings page Admin renders from `schema` (the form subset) with no client code. */
export interface AdminExtensionSettings {
    readonly id: string;
    readonly title: LocalizedText;
    readonly role: "admin";
    readonly schema: JsonSchema;
}
export interface AdminExtensionAction {
    readonly id: string;
    readonly title: LocalizedText;
    readonly role: "admin";
    readonly target: AdminActionTarget;
    /** `run` calls the server at once, `confirm` asks first, `dialog` mounts the module's renderer in an Admin dialog. */
    readonly presentation: "run" | "confirm" | "dialog";
    readonly destructive?: boolean;
    readonly when?: AdminExtensionWhen;
}
export interface AdminExtensionPanel {
    readonly id: string;
    readonly title: LocalizedText;
    readonly role: "admin";
    readonly target: AdminPanelTarget;
    readonly when?: AdminExtensionWhen;
}
export interface AdminExtensionField {
    readonly id: string;
    readonly target: AdminFieldTarget;
    /** Default `admin`, the OSS role. */
    readonly role?: "admin";
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
export interface AdminExtensionRecordRef {
    readonly schema: string;
    readonly id: string;
    readonly version?: number;
}
export interface AdminExtensionSelection {
    readonly schema: string;
    readonly ids: readonly string[];
}
export interface AdminExtension<Env = unknown, Database = unknown> {
    readonly apiVersion: 1;
    /** The raw API receives the original Request; its declared body limit defaults to 1 MB. */
    readonly bodyLimit?: number;
    /** Kebab-case, unique per Admin, and never changed once deployed. */
    readonly id: string;
    readonly title: LocalizedText;
    /** A same-origin ESM path the host serves, whose default export is `defineAdminExtension({...})`. */
    readonly module?: string;
    /** The host installs module integrity in its shell import map; Admin does not inject it. */
    readonly integrity?: string;
    /** Historical source modules are unsupported by native Admin; use a host-served module. */
    readonly source?: string | (() => string | Promise<string>);
    readonly contributes: AdminExtensionContributions;
    readonly handlers?: AdminExtensionHandlers<Env, Database>;
}
export interface AdminExtensionHandlers<Env = unknown, Database = unknown> {
    readonly api?: (request: Request, context: Context<Env, Database> & {
        readonly extension: string;
        readonly path: string;
    }) => Response | null | Promise<Response | null>;
    readonly settings?: Readonly<Record<string, {
        load(caller: Admin, context: Context<Env, Database>): unknown;
        save(caller: Admin, value: Readonly<Record<string, unknown>>, context: Context<Env, Database>): unknown;
    }>>;
    readonly actions?: Readonly<Record<string, {
        run(caller: Admin, input: {
            readonly record?: AdminExtensionRecordRef;
            readonly selection?: AdminExtensionSelection;
            readonly schema?: string;
        }, context: Context<Env, Database>): unknown;
    }>>;
}
/** A project sidebar group (`navGroups` of the `--admin-extensions` module); `uiSchema.nav.group` and pages name it by id. */
export interface AdminNavGroup {
    /** Kebab-case; not a built-in group (content, operations, reports, more, settings). */
    readonly id: string;
    readonly title: LocalizedText;
    /** Among the built-in groups' content 10, operations 20 and reports 30; default 50. More always stays last. */
    readonly order?: number;
}
