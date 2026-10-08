import { isAdminExtensionModule, type AdminExtensionModule } from "@aotter/mantle-ui/extension";
import type { AdminExtensionInfo, AdminExtensionWhen, JsonSchema, SiteInfo } from "./types";

/** `<extension>/<contribution>`, as a manifest's `uiSchema` names a contribution (ADR-lite 1376). */
export const UI_EXTENSION_REF = /^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})$/;

export type ExtensionContribution<K extends keyof AdminExtensionInfo["contributes"]> = AdminExtensionInfo["contributes"][K][number] & { readonly extension: AdminExtensionInfo };

export const extensionsOf = (site: SiteInfo | undefined): readonly AdminExtensionInfo[] => site?.extensions?.filter((e) => e && typeof e === "object" && e.contributes) ?? [];

/** Every contribution of one kind, with its extension. */
export function contributionsOf<K extends keyof AdminExtensionInfo["contributes"]>(site: SiteInfo | undefined, kind: K): ExtensionContribution<K>[] {
  return extensionsOf(site).flatMap((extension) => (extension.contributes[kind] ?? []).map((c) => ({ ...c, extension }) as ExtensionContribution<K>));
}

/** The contribution a `uiSchema` name points at, if this staff member's role reaches it. */
export function contributionByRef<K extends "fields" | "panels">(site: SiteInfo | undefined, kind: K, ref: unknown): ExtensionContribution<K> | undefined {
  const m = typeof ref === "string" ? UI_EXTENSION_REF.exec(ref) : null;
  return m ? contributionsOf(site, kind).find((c) => c.extension.id === m[1] && c.id === m[2]) : undefined;
}

/** Names only, as the server evaluates it; `format` is `x-mcp-hint` or `format`. Without `when`, never. */
export function matchesWhen(when: AdminExtensionWhen | undefined, at: { schema: string; field?: string; property?: JsonSchema }): boolean {
  if (!when) return false;
  if (when.schema && !when.schema.includes(at.schema)) return false;
  if (when.field && (!at.field || !when.field.includes(at.field))) return false;
  if (when.format) {
    const formats = [at.property?.["x-mcp-hint"], at.property?.["format"]].filter((x): x is string => typeof x === "string");
    if (!formats.some((f) => when.format!.includes(f))) return false;
  }
  return true;
}

/** Where a field widget comes from: the manifest's name wins over a matching `when`. */
export function fieldContribution(site: SiteInfo | undefined, target: "field.input/v1" | "field.cell/v1", at: { schema: string; field: string; property?: JsonSchema; ref?: unknown }): ExtensionContribution<"fields"> | undefined {
  const named = at.ref === undefined ? undefined : contributionByRef(site, "fields", at.ref);
  if (named) return named.target === target ? named : undefined;
  return contributionsOf(site, "fields").find((c) => c.target === target && matchesWhen(c.when, at));
}

export const extensionApiBase = (extension: string) => `/admin/api/x/${encodeURIComponent(extension)}/api`;

const loaded = new Map<string, Promise<AdminExtensionModule>>();
let kitStyles = false;

/**
 * The extension's module, imported once. The server accepts only a same-origin path; this guards an older or
 * misconfigured server too. The kit's stylesheet comes with the first extension, so kit components look like Admin.
 */
export function loadExtensionModule(extension: AdminExtensionInfo): Promise<AdminExtensionModule> {
  const cached = loaded.get(extension.id);
  if (cached) return cached;
  const promise = (async () => {
    if (!extension.module) throw new Error(`extension ${extension.id} has no module`);
    const url = new URL(extension.module, window.location.origin);
    if (url.origin !== window.location.origin) throw new Error(`extension ${extension.id} module is not same-origin`);
    if (!kitStyles) {
      kitStyles = true;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL("shared/kit.css", document.baseURI).href;
      document.head.append(link);
    }
    const module = (await import(/* @vite-ignore */ url.href)) as { default?: unknown };
    if (!isAdminExtensionModule(module.default)) throw new Error(`extension ${extension.id} module does not default-export defineAdminExtension(...)`);
    return module.default;
  })();
  loaded.set(extension.id, promise);
  // a failed import may succeed after a deploy: do not keep the failure
  promise.catch(() => loaded.delete(extension.id));
  return promise;
}
