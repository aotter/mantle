/** Extension declaration grammar; executable hooks receive the native Admin context. */
/** Opaque build-validated JSON schema data; the kernel never interprets it. */
export type AdminExtensionSchema = Readonly<Record<string, unknown>>;
type JsonSchema = AdminExtensionSchema;
type LocalizedText = string | Readonly<Record<string, string>>;
import type { Context } from "./index.js";
export type AdminExtensionCaller = Context<unknown, unknown>["caller"];
type Staff = AdminExtensionCaller;
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
    readonly role: "staff";
    readonly nav?: {
        readonly group: "more" | "settings";
        readonly order?: number;
    };
}
/** A settings page Admin renders from `schema` (the form subset) with no client code. */
export interface AdminExtensionSettings {
    readonly id: string;
    readonly title: LocalizedText;
    readonly role: "staff";
    readonly schema: JsonSchema;
}
export interface AdminExtensionAction {
    readonly id: string;
    readonly title: LocalizedText;
    readonly role: "staff";
    readonly target: AdminActionTarget;
    /** `run` calls the server at once, `confirm` asks first, `dialog` mounts the module's renderer in an Admin dialog. */
    readonly presentation: "run" | "confirm" | "dialog";
    readonly destructive?: boolean;
    readonly when?: AdminExtensionWhen;
}
export interface AdminExtensionPanel {
    readonly id: string;
    readonly title: LocalizedText;
    readonly role: "staff";
    readonly target: AdminPanelTarget;
    readonly when?: AdminExtensionWhen;
}
export interface AdminExtensionField {
    readonly id: string;
    readonly target: AdminFieldTarget;
    /** Default `staff`, the OSS role. */
    readonly role?: "staff";
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
    /** Subresource Integrity for `module`, enforced through Admin's import map. */
    readonly integrity?: string;
    /**
     * The module's code, which build tooling emits at `{basePath}/extensions/{id}.js` to staff whose role reaches the
     * extension, with its integrity computed. Plain ESM needs no build: Admin's import map resolves `react`,
     * `react/jsx-runtime`, `react-dom/client`, `@aotter/mantle-ui/kit` and `@aotter/mantle-admin/extension`.
     */
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
        load(caller: Staff, context: Context<Env, Database>): unknown;
        save(caller: Staff, value: Readonly<Record<string, unknown>>, context: Context<Env, Database>): unknown;
    }>>;
    readonly actions?: Readonly<Record<string, {
        run(caller: Staff, input: {
            readonly record?: AdminExtensionRecordRef;
            readonly selection?: AdminExtensionSelection;
            readonly schema?: string;
        }, context: Context<Env, Database>): unknown;
    }>>;
}
