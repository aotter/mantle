/**
 * Writing an Admin extension's client module (ADR-lite 1376). The module's default export is
 * `defineAdminExtension({ pages, actions, panels, fields })`, renderers keyed by the contribution ids its declaration
 * lists. Admin serves `react`, `react-dom`, `@aotter/mantle-ui/kit` and this module through its import map, so an
 * extension marks them external and shares Admin's own React and kit.
 */

export type LocalizedText = string | Readonly<Record<string, string>>;
export type StaffRole = "owner" | "editor" | "contributor";

export interface AdminExtensionRecord { readonly schema: string; readonly id: string; readonly version?: number }
export interface AdminExtensionSelection { readonly schema: string; readonly ids: readonly string[] }
export interface AdminExtensionField {
  readonly schema: string;
  readonly name: string;
  readonly value: unknown;
  readonly readOnly: boolean;
  /** The field's JSON Schema. */
  readonly property: Readonly<Record<string, unknown>>;
}

/** What Admin offers every renderer. Nothing else from the console is reachable. */
export interface AdminExtensionHost {
  /** Moves to an Admin path, e.g. `/admin/c/products/p1`. */
  navigate(path: string): void;
  notify(message: string, kind?: "success" | "error" | "info"): void;
  /** Closes the dialog a `dialog` action renders in; elsewhere it does nothing. */
  close(): void;
}

export interface AdminExtensionContext {
  readonly extension: string;
  readonly contribution: string;
  /** `/admin/api/x/{extension}/api`: the extension's own API, behind Admin's session and role checks. */
  readonly apiBase: string;
  readonly language: string;
  readonly theme: "light" | "dark";
  readonly caller: { readonly role: StaffRole };
  readonly host: AdminExtensionHost;
  /** Record targets and record panels. */
  readonly record?: AdminExtensionRecord;
  /** `list.selection/v1` actions. */
  readonly selection?: AdminExtensionSelection;
  /** `list.toolbar/v1` actions: the listed Schema. */
  readonly schema?: string;
  /** Field targets. */
  readonly field?: AdminExtensionField;
  /** `uiSchema` `options` for a field widget, checked against its `optionsSchema`. */
  readonly options?: Readonly<Record<string, unknown>>;
  /** `field.input/v1` only: report a new value. */
  readonly onChange?: (value: unknown) => void;
}

/**
 * What a renderer returns: nothing, a cleanup, or `{ update, unmount }`. With `update`, Admin passes a changed context
 * (a new field value, a new language) instead of mounting again.
 */
export type AdminExtensionMounted = void | (() => void) | { readonly update?: (context: AdminExtensionContext) => void; readonly unmount?: () => void };
export type AdminExtensionRenderer = (element: HTMLElement, context: AdminExtensionContext) => AdminExtensionMounted | Promise<AdminExtensionMounted>;

export interface AdminExtensionModule {
  readonly pages?: Readonly<Record<string, AdminExtensionRenderer>>;
  /** `dialog` actions only; `run` and `confirm` actions are server handlers. */
  readonly actions?: Readonly<Record<string, AdminExtensionRenderer>>;
  readonly panels?: Readonly<Record<string, AdminExtensionRenderer>>;
  readonly fields?: Readonly<Record<string, AdminExtensionRenderer>>;
}

const BRAND = "mantle.admin-extension/v1";

/** Marks a module's renderers; Admin refuses a default export that did not come from here. */
export function defineAdminExtension<T extends AdminExtensionModule>(module: T): T & { readonly [BRAND]: true } {
  for (const kind of ["pages", "actions", "panels", "fields"] as const) {
    for (const [id, render] of Object.entries(module[kind] ?? {})) {
      if (typeof render !== "function") throw new TypeError(`defineAdminExtension: ${kind}.${id} must be a function.`);
    }
  }
  return Object.freeze({ ...module, [BRAND]: true as const });
}

/** Whether `value` is a module `defineAdminExtension` made. */
export function isAdminExtensionModule(value: unknown): value is AdminExtensionModule {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)[BRAND] === true;
}
